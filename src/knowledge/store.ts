/**
 * Knowledge Store
 *
 * Vector database for storing and retrieving research documents using LanceDB.
 */

// Type-only import for lancedb types; runtime values (connect, Index,
// rerankers) are resolved lazily via getLancedb() so the native binding is not
// hoisted into the CLI bundle and loaded at startup. See ./lancedb-loader.ts.
import type * as lancedb from '@lancedb/lancedb';
import { getLancedb } from './lancedb-loader.ts';
import { CircuitBreaker } from '../utils/circuit-breaker.ts';
import { logger } from '../logger.ts';
import { 
  IKnowledgeStore, 
  StoreDocument, 
  IEmbedder 
} from '../core/interfaces/knowledge-interfaces.ts';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { MigrationStrategy, MigrationResult } from './migration.ts';
import { metrics } from '../utils/metrics.ts';
import { createStoreTable, CURRENT_SCHEMA_VERSION } from './store-schema.ts';
import { addDocumentsToStore, searchStore, findDocumentsByUrl, findRelevantUrls } from './store-operations.ts';
import { isEmbedderUnreachable } from './embedder-utils.ts';
import { ServiceLifecycle } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import { normalizeWorkspacePath } from '../utils/text-utils.ts';

export interface StoreOptions {
  dbDir: string;
  embedder: IEmbedder;
  modelName: string;
  migrationStrategy?: MigrationStrategy;
  /** Called when embedder connection fails — should return a fresh IEmbedder. */
  reconnectFactory?: () => Promise<IEmbedder>;
  /** Optional lock wrapper for multi-process safety during initialization and migration */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  
  /** Scoping options for unified database */
  workspace?: string;
  knowledgeMode: 'none' | 'project' | 'global';
  /** Cache TTL in days for automatic eviction */
  ttlDays?: number;
  /** Max age (in days) a cached document may be served at read time. 0 (default)
   *  disables the read-time gate, preserving prior behaviour — eviction (ttlDays)
   *  still bounds the worst case. Set >0 for time-sensitive research to force a
   *  fresh scrape of anything older than this window. */
  maxServeAgeDays?: number;
}

export class KnowledgeStore implements IKnowledgeStore {
  readonly name = ServiceNames.KNOWLEDGE_STORE;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  // Coalesces concurrent open() calls (see open()).
  private _openPromise: Promise<void> | null = null;
  private options: StoreOptions;
  private tableName = 'knowledge';
  private manifestPath: string;
  private isClosing = false;
  private activeWrites = new Set<Promise<any>>();
  // LanceDB table version at the last successful FTS rebuild. rebuildFtsIndex() skips
  // when the version is unchanged: a research run that committed no new transactions
  // would otherwise create a fresh FTS index (and a new table version) on every cleanup,
  // the dominant driver of the unbounded _indices/_versions bloat seen on disk. Row
  // count is NOT a sufficient signal — a re-ingest of changed content deletes N rows and
  // adds N (writer-queue hash-change path), leaving the count identical while the indexed
  // row SET changed; the table version advances on every such transaction, so it is the
  // correct proxy and is cross-process-correct (getFreshTable re-opens at the latest version).
  private lastFtsVersion: number | null = null;
  private rrfReranker: lancedb.rerankers.RRFReranker | null = null;
  private circuitBreaker = new CircuitBreaker({
    failureThreshold: 3,
    resetTimeoutMs: 15000,
    name: 'KnowledgeStore'
  });

  constructor(options: StoreOptions) {
    this.options = options;
    this.manifestPath = path.join(this.options.dbDir, 'store-manifest.json');
  }

  private getScopeFilter(): string {
    const ws = this.getWorkspace().replace(/'/g, "''");

    switch (this.options.knowledgeMode) {
      case 'project':
        return `workspace = '${ws}'`;
      case 'global':
        return 'is_global = true';
      default: // 'none'
        return '1 = 0';
    }
  }

  private getWorkspace(): string {
    return normalizeWorkspacePath(this.options.workspace || process.cwd());
  }

  async initialize(): Promise<void> {
    this.lifecycle = ServiceLifecycle.INITIALIZING;
    await this.loadManifest();
    await this.open();
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  private async loadManifest(): Promise<void> {
    try {
      if (fs.existsSync(this.manifestPath)) {
        const content = await fsPromises.readFile(this.manifestPath, 'utf-8');
        const manifest = JSON.parse(content);
        if (manifest.activeTableName) {
          this.tableName = manifest.activeTableName;
          logger.debug(`[store] Loaded active table name from manifest: ${this.tableName}`);
        }
      }
    } catch (err) {
      logger.warn('[store] Failed to load manifest, using default table name:', err);
    }
  }

  private async saveManifest(): Promise<void> {
    const tempPath = `${this.manifestPath}.tmp`;
    try {
      const content = JSON.stringify({ activeTableName: this.tableName }, null, 2);
      await fsPromises.writeFile(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
      await fsPromises.rename(tempPath, this.manifestPath);
    } catch (err) {
      logger.warn('[store] Failed to save manifest:', err);
      if (fs.existsSync(tempPath)) {
        try { await fsPromises.unlink(tempPath); } catch { /* ignore */ }
      }
    }
  }

  async open(): Promise<void> {
    if (this.db) return;

    // Coalesce concurrent opens in-process. withLock (when provided) is a
    // cross-process FILE lock, not an in-process mutex — and when it's absent there
    // is no serialization at all, so two concurrent open() calls would both run
    // lancedb.connect() and the second would overwrite this.db, leaking the first
    // connection's file handles. This sentinel makes all concurrent callers await
    // the same open.
    if (this._openPromise) return this._openPromise;

    this._openPromise = (async () => {
      try {
        if (this.options.withLock) {
          await this.options.withLock(() => this.openInternal());
        } else {
          await this.openInternal();
        }
      } finally {
        this._openPromise = null;
      }
    })();

    return this._openPromise;
  }

  private async openInternal(): Promise<void> {
    // Re-check after acquiring lock
    if (this.db) return;

    try {
      if (!fs.existsSync(this.options.dbDir)) {
        fs.mkdirSync(this.options.dbDir, { recursive: true });
      }
      this.db = await (await getLancedb()).connect(this.options.dbDir);

      const tableNames = await this.db.tableNames();
      if (tableNames.includes(this.tableName)) {
        this.table = await this.db.openTable(this.tableName);

        // Tracks whether we've moved past schema-reading into migration. A failure
        // while merely reading the schema is non-fatal (warn + skip). A failure
        // DURING migration is fatal and must escape — without this flag the outer
        // catch below mislabels it "Failed to read table schema" and the store
        // opens on a mismatched table instead of surfacing the corruption.
        let migrationInProgress = false;
        try {
          const schema = await this.table.schema();

          // Read the stored model/version FIRST so we know whether a migration is
          // imminent before deciding whether the old table's vector width is safe
          // to adopt.
          let storedModel = schema.metadata.get('embedding_model');
          let storedVersion = schema.metadata.get('schema_version');

          if (typeof storedModel === 'object' && storedModel !== null && 'byteLength' in (storedModel as any)) {
            storedModel = new TextDecoder().decode(storedModel as unknown as Uint8Array);
          }
          if (typeof storedVersion === 'object' && storedVersion !== null && 'byteLength' in (storedVersion as any)) {
            storedVersion = new TextDecoder().decode(storedVersion as unknown as Uint8Array);
          }

          const isModelMismatch = storedModel !== this.options.modelName;
          const isVersionMismatch = storedVersion !== CURRENT_SCHEMA_VERSION;

          // Seed the embedder dimension from the existing table ONLY when the model
          // is unchanged (same model ⇒ same vector width). On a model change the old
          // width is wrong for the new table; seeding it would make createTable()
          // build the new table at the old dimension and every insert would then
          // fail on an Arrow FixedSizeList width mismatch once the new model warms
          // up. In that case we leave the dimension unset and warm the new embedder
          // below before creating any table.
          if (!isModelMismatch) {
            const vectorField = schema.fields.find(f => f.name === 'vector');
            if (vectorField && (vectorField.type as any).constructor.name === 'FixedSizeList') {
              const dim = (vectorField.type as any).listSize;
              if (this.options.embedder.getDimension() === null) {
                this.options.embedder.setDimension(dim);
                logger.debug(`[store] Extracted dimension ${dim} from existing table schema`);
              }
            }
          }

          if (isModelMismatch || isVersionMismatch) {
            const reason = isModelMismatch ? 'Model change' : 'Schema version change';
            logger.warn(`[store] ${reason} detected: ${storedModel} (v${storedVersion}) → ${this.options.modelName} (v${CURRENT_SCHEMA_VERSION})`);
            const strategy = this.options.migrationStrategy || 'backup';

            migrationInProgress = true;
            // Ensure the embedder knows the NEW model's dimension before any
            // createTable() runs inside migration. On a model change the old width
            // was deliberately not seeded above, so getDimension() is null here; a
            // single real embed warms the model across every IEmbedder impl
            // (local Embedder, EmbeddingServer, EmbeddingClient) and makes
            // getDimension() report the correct new width. (re-embed needs the warm
            // embedder regardless.)
            if (this.options.embedder.getDimension() === null) {
              await this.options.embedder.embedMany([' ']);
            }
            try {
              await this.handleModelChange(storedModel || 'unknown', this.options.modelName, strategy);
            } catch (err) {
              const errorMsg = `Model migration failed using strategy '${strategy}': ${err instanceof Error ? err.message : String(err)}`;
              logger.error(`[store] ${errorMsg}`);

              if (strategy !== 'drop' && strategy !== 'backup') {
                logger.warn('[store] Falling back to backup strategy after migration failure');
                await this.handleModelChange(storedModel || 'unknown', this.options.modelName, 'backup');
              } else if (strategy === 'backup') {
                logger.warn('[store] Falling back to drop strategy after backup failure');
                await this.handleModelChange(storedModel || 'unknown', this.options.modelName, 'drop');
              } else {
                throw new Error(errorMsg, { cause: err });
              }
            }
          }
        } catch (schemaErr) {
          // A migration failure is fatal — re-throw so the caller learns the store
          // could not be brought to a consistent state. Only a pure schema-read
          // failure (before migration began) is downgraded to a warning.
          if (migrationInProgress) throw schemaErr;
          logger.warn('[store] Failed to read table schema:', schemaErr);
        }
      } else {
        this.table = await this.createTable();
      }

      await this.evictOldRecords();
      await this.pruneOrphanedMigrationDirs();

      // Persist manifest after every successful open so that table name
      // changes (from migration, re-embed rename, etc.) survive crashes.
      await this.saveManifest();
    } catch (err) {
      logger.error('[store] Failed to open database:', err);
      // Roll back a partial open: connect() may have succeeded (this.db set) before a
      // later step (createTable/migration/evict/saveManifest) threw. Leaving this.db set
      // makes a subsequent open() short-circuit on `if (this.db) return` and treat a
      // half-open store (this.table possibly null) as ready. Null both so the next open
      // genuinely retries.
      try { await this.db?.close(); } catch { /* best-effort */ }
      this.db = null;
      this.table = null;
      throw err;
    }
  }

  private async handleModelChange(oldModel: string, newModel: string, strategy: MigrationStrategy): Promise<MigrationResult> {
    logger.info(`[store] Executing migration strategy: ${strategy}`);
    logger.info(`[store] Old model: ${oldModel}, New model: ${newModel}`);

    switch (strategy) {
      case 'drop':
        return this.migrationDrop(oldModel, newModel);
      case 're-embed':
        return this.migrationReEmbed(oldModel, newModel);
      case 'backup':
        return this.migrationBackup(oldModel, newModel);
      default:
        logger.warn(`[store] Unknown migration strategy '${strategy}', falling back to 'backup'`);
        return this.migrationBackup(oldModel, newModel);
    }
  }

  private async migrationBackup(_oldModel: string, newModel: string): Promise<MigrationResult> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupTableName = `${this.tableName}_backup_${timestamp}`;
    logger.warn(`[store] Backing up table to ${backupTableName} and recreating with model ${newModel}`);

    if (!this.table || !this.db) {
      throw new Error('Table not connected');
    }

    const count = await this.table.countRows();
    
    // Close current table handle
    this.table = null;
    
    // In LanceDB, tables are directories. Rename the .lance directory.
    const oldDir = path.join(this.options.dbDir, `${this.tableName}.lance`);
    const backupDir = path.join(this.options.dbDir, `${backupTableName}.lance`);
    
    try {
      if (fs.existsSync(oldDir)) {
        await fsPromises.rename(oldDir, backupDir);
        logger.info(`[store] Successfully backed up database directory to ${backupDir}`);
      }
    } catch (err) {
      logger.error(`[store] Atomic backup failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    // Create fresh table
    this.table = await this.createTable();
    // Table name unchanged (still canonical 'knowledge'), but persist to be safe.
    await this.saveManifest();
    logger.info(`[store] Migration complete: ${count} documents backed up, fresh table created with model ${newModel}`);

    return { strategy: 'backup', success: true, documentsProcessed: count };
  }

  private async migrationDrop(_oldModel: string, newModel: string): Promise<MigrationResult> {
    logger.warn(`[store] Dropping table and recreating with model ${newModel} (data will be lost)`);

    if (!this.table || !this.db) {
      throw new Error('Table not connected');
    }

    const count = await this.table.countRows();
    logger.warn(`[store] Deleting ${count} existing documents`);

    await this.db.dropTable(this.tableName);
    this.table = await this.createTable();
    // Table name unchanged (still canonical 'knowledge'), but persist to be safe.
    await this.saveManifest();

    logger.info(`[store] Migration complete: ${count} documents removed, table recreated with model ${newModel}`);

    return { strategy: 'drop', success: true, documentsProcessed: count };
  }

  private async migrationReEmbed(_oldModel: string, newModel: string): Promise<MigrationResult> {
    logger.info(`[store] Re-embedding documents with model ${newModel} (data will be preserved)`);

    if (!this.table || !this.db) {
      throw new Error('Table not connected');
    }

    const totalDocs = await this.table.countRows();
    logger.info(`[store] Processing ${totalDocs} documents for re-embedding...`);

    let embedded = 0;
    const batchSize = 50;
    const tempTableName = `${this.tableName}_migration_${Date.now()}`;

    try {
      // Create new table BEFORE dropping the old one to prevent data loss on failure
      logger.info(`[store] Creating new table ${tempTableName} for migration...`);
      const newTable = await this.createTable(tempTableName);

      for (let i = 0; i < totalDocs; i += batchSize) {
        const batchRows = await this.table.query().limit(batchSize).offset(i).toArray();

        const batchDocs = batchRows.flatMap(row => {
          let metadata: Record<string, any> = {};
          try { metadata = JSON.parse(row.metadata as string); } catch {
            logger.warn('[store] Skipping row with corrupted metadata during re-embed migration');
          }
          return [{
            url: row.url as string,
            text: row.text as string,
            content: row.content as string | undefined,
            metadata,
            workspace: (row.workspace as string) || 'global',
            is_global: !!row.is_global,
            ingestion_type: (row.ingestion_type as string) || metadata['ingestionType'] || 'synthesis-description',
            timestamp: Number(row.timestamp),
          }];
        });

        const texts = batchDocs.map(d => d.text);
        const vectors = await this.options.embedder.embedMany(texts);

        const records = batchDocs.map((doc, idx) => ({
          vector: Array.from(vectors[idx]!),
          url: doc.url,
          text: doc.text,
          content: doc.content || null,
          metadata: JSON.stringify(doc.metadata),
          workspace: doc.workspace,
          is_global: doc.is_global,
          ingestion_type: doc.ingestion_type,
          timestamp: BigInt(doc.timestamp),
        }));

        await newTable.add(records);
        embedded += batchDocs.length;

        if (embedded % 100 === 0 || embedded === totalDocs) {
          logger.info(`[store] Re-embedded ${embedded}/${totalDocs} documents`);
        }
      }

      // Only drop old table after successful completion
      logger.info(`[store] Migration successful, dropping old table ${this.tableName}...`);
      const canonicalName = 'knowledge'; // We try to return to the canonical name if possible
      const oldTableName = this.tableName;
      await this.db.dropTable(oldTableName);

      // LanceDB has no rename API, but its tables are plain directories on disk.
      // Rename the temp directory to the canonical table name so that the next
      // process start finds 'knowledge' (not 'knowledge_migration_<ts>').
      logger.info(`[store] Renaming ${tempTableName} to ${canonicalName}...`);
      try {
        const tempDir = path.join(this.options.dbDir, `${tempTableName}.lance`);
        const canonicalDir = path.join(this.options.dbDir, `${canonicalName}.lance`);
        
        // If canonical name was already something else and it still exists, 
        // we might need to handle it. But we just dropped it above.
        await fsPromises.rename(tempDir, canonicalDir);
        
        this.tableName = canonicalName;
        await this.saveManifest();
        
        // Reopen the canonical table so this.table reflects the renamed path
        this.table = await this.db.openTable(this.tableName);
      } catch (renameErr) {
        // If rename fails (cross-device, permissions, etc.) we keep the temp name
        // but CRITICALLY we now persist it in the manifest so future sessions
        // will find it automatically.
        logger.warn(`[store] Directory rename failed, persisting temp table name in manifest: ${renameErr}`);
        this.tableName = tempTableName;
        await this.saveManifest();
        
        this.table = newTable;
        logger.info(`[store] Migrated data is safe in ${tempTableName} and tracked via manifest.`);
      }

      logger.info(`[store] Migration complete: ${embedded} documents re-embedded with model ${newModel}`);

      return { strategy: 're-embed', success: true, documentsProcessed: embedded };
    } catch (error) {
      logger.error(`[store] Migration failed at ${embedded}/${totalDocs}:`, error);
      logger.error(`[store] Original data is still intact in table ${this.tableName}`);
      throw error;
    }
  }

  private async createTable(name: string = this.tableName): Promise<lancedb.Table> {
    if (!this.db) throw new Error('Database not connected');
    const dim = this.options.embedder.getDimension();
    if (dim === null) throw new Error('[store] Cannot create table: embedder dimension unknown (not yet initialized)');
    return createStoreTable(this.db, name, dim, this.options.modelName);
  }

  private async withEmbedderReconnect<T>(fn: (embedder: IEmbedder) => Promise<T>): Promise<T> {
    try {
      return await fn(this.options.embedder);
    } catch (err) {
      if (isEmbedderUnreachable(err) && this.options.reconnectFactory) {
        logger.warn('[store] Embedder server unreachable, reconnecting and retrying...');
        this.options.embedder = await this.options.reconnectFactory();
        return fn(this.options.embedder);
      }
      throw err;
    }
  }

  /**
   * Internal helper to get a fresh table handle, ensuring we see the latest
   * documents added by other processes. Re-opening a table in LanceDB is 
   * a cheap manifest re-read.
   */
  private async getFreshTable(): Promise<lancedb.Table> {
    return (await this.openFreshTable()).table;
  }

  /**
   * Re-open the table and report whether the returned handle is a genuinely fresh
   * re-open (`stale=false`) or a fallback to the previously-cached handle after a
   * transient re-open failure (`stale=true`). The FTS skip-guards must reason about
   * the freshness of the handle THEY hold, not a shared field a concurrent op can
   * reset out from under them — so staleness is returned per-call, not stored.
   */
  private async openFreshTable(): Promise<{ table: lancedb.Table; stale: boolean }> {
    if (!this.db) throw new Error('Store not open');
    try {
      this.table = await this.db.openTable(this.tableName);
      return { table: this.table, stale: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If the table genuinely no longer exists (dropped/renamed by another
      // process's migration), do NOT serve a stale handle that points at a gone
      // table — invalidate and surface the error so callers fail clearly.
      if (/not found|does not exist|no such table/i.test(msg)) {
        this.table = null;
        throw err;
      }
      if (!this.table) throw err;
      // Transient (lock/IO) refresh failure: keep using the existing handle, but
      // log at WARN so the degraded path is visible rather than silent, and report
      // the handle as stale so version-based skip guards fail safe (rebuild, don't skip).
      logger.warn(`[store] Failed to refresh table handle, using existing: ${msg}`);
      return { table: this.table, stale: true };
    }
  }

  /**
   * Run a table operation under the same close-coordination guard addDocuments uses:
   * register into activeWrites BEFORE checking isClosing (so close() can't observe an
   * empty set and tear down the connection mid-flight), and skip cleanly if the store
   * is already closing. Compaction (optimize/rebuildFtsIndex) runs in the background
   * right after a run completes — exactly when a Ctrl+C-driven close() is most likely
   * to race it — so both must be tracked, not just writes.
   */
  private async trackOperation<T>(label: string, whenClosing: T, fn: () => Promise<T>): Promise<T> {
    let resolveWrite!: () => void;
    const writePromise = new Promise<void>((resolve) => { resolveWrite = resolve; });
    this.activeWrites.add(writePromise);
    try {
      if (this.isClosing) {
        logger.debug(`[store] Skipping ${label} — store is closing`);
        return whenClosing;
      }
      return await fn();
    } finally {
      this.activeWrites.delete(writePromise);
      resolveWrite();
    }
  }

  async addDocuments(docs: StoreDocument[]): Promise<void> {
    // FIX (#3): Register the write promise BEFORE checking isClosing to prevent
    // close() from reading an empty activeWrites set and closing the DB.
    let writeResolve: () => void;
    const writePromise = new Promise<void>((resolve) => { writeResolve = resolve; });
    this.activeWrites.add(writePromise);

    try {
      // Now check isClosing after registering
      if (this.isClosing) {
        logger.warn(`[store] Skipping addDocuments — store is closing`);
        return;
      }

      let table = await this.getFreshTable();
      const workspace = this.getWorkspace();

      await this.withEmbedderReconnect(async (embedder) => {
        let retryCount = 0;
        const MAX_RETRIES = 5;
        const BASE_DELAY = 100;

        while (retryCount <= MAX_RETRIES) {
          try {
            const isGlobal = this.options.knowledgeMode === 'global';
          await addDocumentsToStore(
              table, 
              docs, 
              embedder, 
              () => this.isClosing,
              workspace,
              isGlobal
            );
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Detect version mismatch or lock errors typical of cross-process contention
            if (msg.includes('Version mismatch') || msg.includes('Lock error') || msg.includes('Commit error')) {
              retryCount++;
              if (retryCount > MAX_RETRIES) throw err;

              // Exponential backoff with jitter
              const delay = Math.floor(Math.random() * (BASE_DELAY * Math.pow(2, retryCount - 1)));
              logger.debug(`[store] Write contention detected, retrying ${retryCount}/${MAX_RETRIES} after ${delay}ms...`);
              await new Promise(r => setTimeout(r, delay));

              // Refresh the table handle AND rebind the local so the retry writes
              // against the latest committed version. Discarding this return (the prior
              // bug) left every retry re-running against the same version-pinned snapshot,
              // so a Version-mismatch conflict re-failed all 5 attempts and the batch was
              // silently dropped under concurrent cross-process writes.
              table = await this.getFreshTable();
              continue;
            }
            throw err;
          }
        }
      });
    } finally {
      this.activeWrites.delete(writePromise);
      writeResolve!();
    }
  }

  private async getReranker(): Promise<lancedb.rerankers.RRFReranker> {
    if (!this.rrfReranker) {
      this.rrfReranker = await (await getLancedb()).rerankers.RRFReranker.create();
    }
    return this.rrfReranker;
  }

  async search(query: string, options: { limit?: number } = {}): Promise<StoreDocument[]> {
    // Coordinate with close(): register in activeWrites and skip cleanly if the store is
    // closing, so a teardown (Ctrl+C / dispose) can't run db.close() while this query is
    // executing against the connection (use-after-close on the native handle).
    return this.trackOperation('search', [] as StoreDocument[], async () => {
      const table = await this.getFreshTable();
      const scopeFilter = this.getScopeFilter();
      return this.circuitBreaker.execute(() =>
        this.withEmbedderReconnect(embedder =>
          searchStore(table, embedder, query, this.getReranker.bind(this), options.limit ?? 5, scopeFilter)
        )
      );
    });
  }

  async deleteByUrl(url: string): Promise<void> {
    // Coordinate the delete with close() (register in activeWrites, skip if closing) so a
    // teardown can't run db.close() while this mutation executes against the connection.
    return this.trackOperation('deleteByUrl', undefined, () => this.deleteByUrlInner(url));
  }

  private async deleteByUrlInner(url: string): Promise<void> {
    let retryCount = 0;
    const MAX_RETRIES = 5;
    const BASE_DELAY = 100;
    const scopeFilter = this.getScopeFilter();

    while (retryCount <= MAX_RETRIES) {
      const table = await this.getFreshTable();
      const startTime = Date.now();
      try {
        const escapedUrl = url.replace(/'/g, "''");
        await table.delete(`url = '${escapedUrl}' AND (${scopeFilter})`);
        const duration = Date.now() - startTime;
        metrics.observe('knowledge_store_delete_duration_ms', duration);
        metrics.increment('knowledge_store_delete_total', 1, { operation: 'by_url', status: 'success' });
        logger.log(`[store] Deleted chunks for ${url} (scoped)`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Version mismatch') || msg.includes('Lock error') || msg.includes('Commit error')) {
          retryCount++;
          if (retryCount > MAX_RETRIES) throw err;
          const delay = Math.floor(Math.random() * (BASE_DELAY * Math.pow(2, retryCount - 1)));
          logger.debug(`[store] Delete contention detected for ${url}, retrying ${retryCount}/${MAX_RETRIES} after ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        
        const duration = Date.now() - startTime;
        metrics.observe('knowledge_store_delete_duration_ms', duration, { status: 'error' });
        metrics.increment('knowledge_store_delete_total', 1, { operation: 'by_url', status: 'error' });
        throw err;
      }
    }
  }

  async deleteByUrlAndType(url: string, ingestionType: string): Promise<void> {
    // Coordinate with close() — see deleteByUrl.
    return this.trackOperation('deleteByUrlAndType', undefined, () => this.deleteByUrlAndTypeInner(url, ingestionType));
  }

  private async deleteByUrlAndTypeInner(url: string, ingestionType: string): Promise<void> {
    let retryCount = 0;
    const MAX_RETRIES = 5;
    const BASE_DELAY = 100;
    const scopeFilter = this.getScopeFilter();

    while (retryCount <= MAX_RETRIES) {
      const table = await this.getFreshTable();
      const startTime = Date.now();
      try {
        const escapedUrl = url.replace(/'/g, "''");
        const escapedType = ingestionType.replace(/'/g, "''");
        await table.delete(`url = '${escapedUrl}' AND ingestion_type = '${escapedType}' AND (${scopeFilter})`);
        const duration = Date.now() - startTime;
        metrics.observe('knowledge_store_delete_duration_ms', duration, { operation: 'by_url_and_type' });
        metrics.increment('knowledge_store_delete_total', 1, { operation: 'by_url_and_type', status: 'success' });
        logger.log(`[store] Deleted ${ingestionType} chunks for ${url} (scoped)`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Version mismatch') || msg.includes('Lock error') || msg.includes('Commit error')) {
          retryCount++;
          if (retryCount > MAX_RETRIES) throw err;
          const delay = Math.floor(Math.random() * (BASE_DELAY * Math.pow(2, retryCount - 1)));
          logger.debug(`[store] Delete-by-type contention detected for ${url}, retrying ${retryCount}/${MAX_RETRIES} after ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        const duration = Date.now() - startTime;
        metrics.observe('knowledge_store_delete_duration_ms', duration, { operation: 'by_url_and_type', status: 'error' });
        metrics.increment('knowledge_store_delete_total', 1, { operation: 'by_url_and_type', status: 'error' });
        throw err;
      }
    }
  }

  async findDocumentsByUrl(url: string): Promise<StoreDocument[]> {
    // Coordinate with close(): findByUrl runs via the writer-queue in the post-run
    // background window (link-description storage), exactly when a Ctrl+C-driven
    // close() is most likely to race it — read against a freed native handle otherwise.
    return this.trackOperation('findDocumentsByUrl', [] as StoreDocument[], async () => {
      const table = await this.getFreshTable();
      const scopeFilter = this.getScopeFilter();
      return findDocumentsByUrl(table, url, scopeFilter);
    });
  }

  async exportForWeb(outputPath: string): Promise<void> {
    // Reachable from the public SDK (exportKnowledge()) at any time — coordinate with
    // close() like the other reads so a concurrent teardown can't free the native handle
    // mid-query and surface a use-after-close to the caller.
    return this.trackOperation('exportForWeb', undefined, async () => {
    const table = await this.getFreshTable();
    const scopeFilter = this.getScopeFilter();

    logger.info(`[store] Exporting knowledge store for web to: ${outputPath} (scope=${scopeFilter})`);

    // 1. Fetch all synthesis-description entries
    // We only want the high-quality summaries and their vectors for semantic search in the UI.
    const results = await table
      .query()
      .where(`ingestion_type = 'synthesis-description' AND (${scopeFilter})`)
      .toArray();

    // 2. Format for web
    // We use a compact format to keep the JSON size manageable
    const exportData = results.map(r => {
      let metadata: Record<string, any> = {};
      try {
        metadata = JSON.parse(r.metadata as string);
      } catch {
        logger.debug('[store] Corrupted metadata for row in rebuildDocument');
        // Fallback for corrupted metadata
      }
      
      return {
        url: r.url as string,
        // The text is the summary/description
        text: r.text as string,
        // The vector is the model-dimension embedding
        v: Array.from(r.vector as Float32Array),
        // Minimal metadata needed for the UI
        m: {
          d: metadata['description'] || '',
          t: Number(r.timestamp),
        }
      };
    });

    // 3. Save to file
    try {
      const dir = path.dirname(outputPath);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(outputPath, JSON.stringify(exportData), 'utf-8');
      logger.info(`[store] Successfully exported ${exportData.length} entries to ${outputPath}`);
    } catch (err) {
      logger.error(`[store] Failed to export knowledge store for web:`, err);
      throw err;
    }
    });
  }

  async findByUrl(url: string): Promise<StoreDocument[]> {
    return this.findDocumentsByUrl(url);
  }

  async rebuildDocument(url: string): Promise<{ text: string; description: string | null; metadata: Record<string, any>; ageDays?: number } | null> {
    // Runs mid-research (scrape cache lookup); coordinate with close() so a teardown
    // can't free the native handle while this query is in flight.
    return this.trackOperation('rebuildDocument', null, async () => {
    const table = await this.getFreshTable();
    const scopeFilter = this.getScopeFilter();

    const startTime = Date.now();
    const escapedUrl = url.replace(/'/g, "''");

    const results = await table
      .query()
      .where(`url = '${escapedUrl}' AND ingestion_type = 'synthesis-description' AND (${scopeFilter})`)
      .limit(1)
      .toArray();

    const duration = Date.now() - startTime;
    metrics.observe('knowledge_store_query_duration_ms', duration, { operation: 'rebuild_document' });
    metrics.increment('knowledge_store_query_total', 1, { operation: 'rebuild_document' });

    if (results.length === 0) {
      metrics.increment('knowledge_store_cache_hits_total', 1, { status: 'miss' });
      return null;
    }

    const r = results[0];
    // Read-time freshness. The stored timestamp (ms) is otherwise discarded here;
    // compute the row's age so we can (a) optionally treat an over-age row as a
    // cache miss and (b) surface the age to callers so it never reaches the model
    // as timeless/authoritative content.
    const rawAgeMs = Date.now() - Number(r.timestamp);
    // Guard against a missing/corrupt timestamp: Math.max does NOT sanitize NaN, and an
    // undefined ageDays cleanly omits the age label rather than surfacing "~NaN day(s)".
    const hasAge = Number.isFinite(rawAgeMs);
    const ageMs = hasAge ? Math.max(0, rawAgeMs) : 0;
    const ageDays = hasAge ? Math.floor(ageMs / 86_400_000) : undefined;
    const maxServeAgeDays = this.options.maxServeAgeDays ?? 0;
    if (maxServeAgeDays > 0 && hasAge && ageMs > maxServeAgeDays * 86_400_000) {
      metrics.increment('knowledge_store_cache_hits_total', 1, { status: 'stale' });
      logger.log(`[store] Cache stale for ${url} (${ageDays}d > ${maxServeAgeDays}d serve limit) — treating as miss`);
      return null;
    }
    try {
      const metadata = JSON.parse(r.metadata as string);
      const description: string | null = typeof metadata.description === 'string' ? metadata.description : null;
      const textToReturn = (r.content as string) || (r.text as string) || description || '';
      metrics.increment('knowledge_store_cache_hits_total', 1, { status: 'hit' });
      logger.log(`[store] Cache hit: synthesis-description for ${url} (${textToReturn.length} chars, ~${ageDays ?? '?'}d old)`);
      return { text: textToReturn, description, metadata, ageDays };
    } catch {
      logger.debug(`[store] Parse error reading cached content for ${url}`);
      metrics.increment('knowledge_store_cache_hits_total', 1, { status: 'parse_error' });
      return null;
    }
    });
  }

  async findRelevantUrls(query: string, options: { limit?: number } = {}): Promise<{ url: string; description: string; provenance?: string }[]> {
    // Runs mid-research from both orchestrators + the knowledge-search tool. Keep the
    // circuitBreaker/embedder-reconnect INSIDE the tracked fn so a clean close-skip
    // returns [] rather than surfacing a use-after-close error that trips the breaker.
    return this.trackOperation('findRelevantUrls', [] as { url: string; description: string; provenance?: string }[], async () => {
      const table = await this.getFreshTable();
      const scopeFilter = this.getScopeFilter();
      return this.circuitBreaker.execute(() =>
        this.withEmbedderReconnect(embedder =>
          findRelevantUrls(table, embedder, query, this.getReranker.bind(this), options.limit ?? 20, scopeFilter)
        )
      );
    });
  }

  async rebuildFtsIndex(): Promise<boolean> {
    return this.trackOperation('FTS index rebuild', false, () => this._rebuildFtsIndex());
  }

  private async _rebuildFtsIndex(): Promise<boolean> {
    // Serialize under the same cross-process lock optimize() uses. rebuildFtsIndex and
    // optimize are a matched pair that both commit new manifest versions; two processes
    // finishing runs against a shared store could otherwise race two createIndex() calls,
    // wasting a full rebuild (LanceDB's optimistic commit surfaces the loser as a conflict).
    return this.options.withLock ? this.options.withLock(() => this._rebuildFtsIndexInner()) : this._rebuildFtsIndexInner();
  }

  private async _rebuildFtsIndexInner(): Promise<boolean> {
    const { table, stale } = await this.openFreshTable();
    try {
      const count = await table.countRows();
      if (count === 0) {
        logger.debug('[store] Skipping FTS index rebuild (table is empty)');
        return false;
      }
      // Skip when the table version is unchanged since our last rebuild: the existing
      // FTS index already covers exactly these rows, so a rebuild would only churn out a
      // new index version for no search benefit. The version advances on EVERY committed
      // transaction (add/delete/optimize), so unlike row count it detects an equal-count
      // re-ingest (delete N + add N) that changes the indexed row set — the case that would
      // otherwise silently leave new content out of the keyword/BM25 index.
      const version = await table.version();
      // Only trust the skip when we hold a genuinely fresh handle. If getFreshTable
      // fell back to a stale cached handle, version() may read an old snapshot that
      // happens to equal lastFtsVersion — skipping a rebuild that new content needs.
      // Fail safe: rebuild.
      if (!stale && this.lastFtsVersion === version) {
        logger.debug(`[store] Skipping FTS index rebuild (table version unchanged at ${version})`);
        return false;
      }
      logger.info('[store] Rebuilding FTS indexes...');
      const { Index } = await getLancedb();
      // FTS on 'text' — synthesis descriptions (for semantic/hybrid search)
      await table.createIndex('text', {
        config: Index.fts(),
        replace: true,
      });
      // FTS on 'content' — full article markdown (for keyword/BM25 grep)
      await table.createIndex('content', {
        config: Index.fts(),
        replace: true,
      });
      // Record the version AFTER indexing (createIndex commits its own transactions) so the
      // next call compares against this post-rebuild baseline and only rebuilds on real writes.
      this.lastFtsVersion = await (await this.getFreshTable()).version();
      logger.info('[store] FTS indexes rebuilt (text + content).');
      return true;
    } catch (err) {
      logger.warn('[store] FTS index rebuild failed:', err);
      return false;
    }
  }

  /**
   * Compact the table and prune stale versions/indices.
   *
   * LanceDB is append-/copy-on-write: every addDocuments, delete, and
   * createIndex (FTS rebuild) writes a new manifest version and leaves the old
   * data/index files behind. Nothing reclaims them automatically, so the store
   * grew to ~924 MB on disk for ~21 MB of live data (1939 manifest versions,
   * 752 MB of orphaned FTS indices). table.optimize() merges data fragments and
   * removes versions older than `cleanupOlderThan`.
   *
   * Defaults are conservative for a possibly-shared store: deleteUnverified stays
   * false so files younger than LanceDB's in-flight-transaction window are never
   * removed, and the call is wrapped in withLock (when provided) so a concurrent
   * process isn't mid-write. The `deleteUnverified`/`cleanupOlderThan` options are a
   * reserved knob for a future maintenance path that could reclaim aggressively once
   * the caller guarantees no other instance is running; no command exposes it today,
   * so every production call uses the conservative defaults.
   *
   * Returns true if optimize ran, false if it was skipped (closing/disabled).
   */
  async optimize(options: { cleanupOlderThan?: Date; deleteUnverified?: boolean } = {}): Promise<boolean> {
    return this.trackOperation('optimize', false, () => this._optimize(options));
  }

  private async _optimize(options: { cleanupOlderThan?: Date; deleteUnverified?: boolean } = {}): Promise<boolean> {
    if (this.options.knowledgeMode === 'none') return false;

    const run = async (): Promise<boolean> => {
      const { table, stale } = await this.openFreshTable();
      const startTime = Date.now();
      try {
        // optimize() commits a new manifest version (compaction) but never changes the
        // logical row set, so an FTS index that covered all rows before this call still
        // covers them after. Record whether our rebuild baseline was current going in: if
        // so, we advance it past optimize's version bump below. Otherwise rebuildFtsIndex's
        // unchanged-version skip guard is defeated and every steady-state run needlessly
        // rebuilds + re-optimizes (the disk-bloat regression). A stale baseline (index not
        // current, or never built) is left untouched so the next rebuild still detects the
        // pending change.
        const wasFtsIndexCurrent = !stale && this.lastFtsVersion !== null && this.lastFtsVersion === await table.version();
        // cleanupOlderThan defaults to now: prune every prunable old version. The
        // current version is always retained, and (with deleteUnverified=false)
        // physical files inside LanceDB's safety window are kept regardless.
        const cleanupOlderThan = options.cleanupOlderThan ?? new Date();
        const stats = await table.optimize({
          cleanupOlderThan,
          deleteUnverified: options.deleteUnverified ?? false,
        });
        const duration = Date.now() - startTime;
        metrics.observe('knowledge_store_optimize_duration_ms', duration);
        metrics.increment('knowledge_store_optimize_total', 1);
        const removed = stats?.prune?.oldVersionsRemoved ?? 0;
        const bytesRemoved = stats?.prune?.bytesRemoved ?? 0;
        logger.info(`[store] Optimize complete: removed ${removed} old version(s), reclaimed ${bytesRemoved} bytes (${duration}ms).`);
        // Keep the FTS skip-guard baseline in sync with optimize's layout-only version bump
        // so the next rebuildFtsIndex correctly skips when no content changed.
        if (wasFtsIndexCurrent) {
          this.lastFtsVersion = await (await this.getFreshTable()).version();
        }
        return true;
      } catch (err) {
        logger.warn('[store] Optimize failed:', err);
        return false;
      }
    };

    return this.options.withLock ? this.options.withLock(run) : run();
  }

  private async evictOldRecords(): Promise<void> {
    const table = await this.getFreshTable();

    try {
      const scopeFilter = this.getScopeFilter();
      // knowledgeMode='none' means no store is active — nothing to evict.
      if (scopeFilter === '1 = 0') return;

      const ttlDays = this.options.ttlDays ?? 30;
      const cutoffTimestamp = Date.now() - (ttlDays * 24 * 60 * 60 * 1000);
      // Scope eviction to this workspace only — do not evict other projects' data.
      await table.delete(`timestamp < ${BigInt(cutoffTimestamp)} AND (${scopeFilter})`);
      logger.log(`[store] Ran eviction for records older than ${ttlDays} days [scope: ${scopeFilter}]`);
    } catch (err) {
      logger.warn('[store] Failed to evict old records:', err);
    }
  }

  private async pruneOrphanedMigrationDirs(): Promise<void> {
    // Only prune once the canonical table is confirmed open. If it failed to
    // open, the real data may still live in a `_migration_`/`_backup_` dir that
    // the manifest points at — never reap dirs when we can't positively
    // establish which one is live.
    if (!this.table) return;
    try {
      // The dir the manifest currently points at is the live table — NEVER
      // delete it, even if its name contains `_migration_`/`_backup_` (a
      // persisted re-embed rename-failure leaves the live data in a temp dir).
      const activeDir = `${this.tableName}.lance`;
      const entries = await fsPromises.readdir(this.options.dbDir, { withFileTypes: true });

      const migrationDirs: string[] = [];
      const backupDirs: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (name === activeDir || !name.endsWith('.lance')) continue;
        // Check `_backup_` FIRST: a re-embed rename-failure can leave the table
        // named `..._migration_<ts>`, and a later backup of it produces
        // `..._migration_<ts>_backup_<ts2>` — an intentional, recoverable backup
        // that must NOT be misclassified as a reapable migration temp.
        if (name.includes('_backup_')) backupDirs.push(name);
        else if (name.includes('_migration_')) migrationDirs.push(name);
      }

      // `_migration_` dirs are transient temp tables from an interrupted
      // re-embed; the live one is excluded above, so the rest are safe garbage.
      for (const name of migrationDirs) {
        const fullPath = path.join(this.options.dbDir, name);
        logger.info(`[store] Removing orphaned migration temp directory: ${name}`);
        await fsPromises.rm(fullPath, { recursive: true, force: true });
      }

      // `_backup_` dirs are intentional, user-recoverable snapshots from the
      // 'backup' migration strategy. RETAIN the most recent one (deleting it
      // would make 'backup' silently equivalent to 'drop'); prune only older,
      // superseded backups so they don't accumulate. ISO-timestamp names sort
      // chronologically, so the last entry is newest.
      if (backupDirs.length > 1) {
        backupDirs.sort();
        for (const name of backupDirs.slice(0, -1)) {
          const fullPath = path.join(this.options.dbDir, name);
          logger.info(`[store] Removing superseded backup directory: ${name}`);
          await fsPromises.rm(fullPath, { recursive: true, force: true });
        }
      }
    } catch (err) {
      logger.warn('[store] Failed to prune orphaned migration directories:', err);
    }
  }

  async count(): Promise<number> {
    if (!this.db) return 0;
    // Track against close() — this read had no try/catch, so a teardown racing db.close()
    // here would surface as an uncaught use-after-close. trackOperation makes close() wait.
    return this.trackOperation('count', 0, async () => {
      const table = await this.getFreshTable();
      const scopeFilter = this.getScopeFilter();
      const count = await table.countRows(scopeFilter);
      metrics.setGauge('knowledge_store_total_documents', count);
      return count;
    });
  }

  /**
   * Get granular counts for local vs global entries.
   * @param workspace - Optional workspace to filter project-specific counts.
   *                    Defaults to the store's configured workspace.
   */
  async countScoped(workspace?: string): Promise<{ local: number; global: number; projects: number }> {
    if (!this.db) return { local: 0, global: 0, projects: 0 };

    // Coordinate with close() — runs from healthcheck + research-config status display.
    // Keep the contention-retry loop INSIDE the tracked fn so a clean close-skip returns
    // zeroed counts rather than throwing a non-retryable use-after-close.
    return this.trackOperation('countScoped', { local: 0, global: 0, projects: 0 }, async () => {
      let retryCount = 0;
      const MAX_RETRIES = 5;
      const BASE_DELAY = 100;

      while (retryCount <= MAX_RETRIES) {
        try {
          const table = await this.getFreshTable();
          const ws = normalizeWorkspacePath(workspace || this.getWorkspace());
          const escaped = ws.replace(/'/g, "''");

          const [local, global] = await Promise.all([
            table.countRows(`workspace = '${escaped}'`),
            table.countRows(`is_global = true`)
          ]);

          const allWorkspaces = await table.query()
            .select(['workspace'])
            .toArray();

          const uniqueWorkspaces = new Set<string>();
          for (const row of allWorkspaces) {
            if (row.workspace) uniqueWorkspaces.add(row.workspace as string);
          }

          return { local, global, projects: uniqueWorkspaces.size };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('Version mismatch') || msg.includes('Lock error') || msg.includes('Commit error')) {
            retryCount++;
            if (retryCount > MAX_RETRIES) throw err;
            const delay = Math.floor(Math.random() * (BASE_DELAY * Math.pow(2, retryCount - 1)));
            logger.debug(`[store] Read contention detected in countScoped, retrying ${retryCount}/${MAX_RETRIES} after ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          throw err;
        }
      }
      return { local: 0, global: 0, projects: 0 }; // Should not be reached
    });
  }

  async clear(filter?: string): Promise<void> {
    if (!this.db) throw new Error('Store not open');
    // Coordinate with close() — see deleteByUrl.
    return this.trackOperation('clear', undefined, () => this.clearInner(filter));
  }

  private async clearInner(filter?: string): Promise<void> {
    let retryCount = 0;
    const MAX_RETRIES = 5;
    const BASE_DELAY = 100;

    while (retryCount <= MAX_RETRIES) {
      try {
        const table = await this.getFreshTable();
        const scopeFilter = filter || this.getScopeFilter();
        const startTime = Date.now();

        // Scoped clear instead of dropping table to preserve other workspace data
        await table.delete(scopeFilter);

        const duration = Date.now() - startTime;
        metrics.observe('knowledge_store_clear_duration_ms', duration);
        metrics.increment('knowledge_store_clear_total', 1, { status: 'success' });
        metrics.setGauge('knowledge_store_total_documents', 0);
        logger.info(`[store] Knowledge store cleared for scope: ${scopeFilter}`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Version mismatch') || msg.includes('Lock error') || msg.includes('Commit error')) {
          retryCount++;
          if (retryCount > MAX_RETRIES) {
            metrics.increment('knowledge_store_clear_total', 1, { status: 'error' });
            throw err;
          }
          const delay = Math.floor(Math.random() * (BASE_DELAY * Math.pow(2, retryCount - 1)));
          logger.debug(`[store] Write contention detected in clear, retrying ${retryCount}/${MAX_RETRIES} after ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        metrics.increment('knowledge_store_clear_total', 1, { status: 'error' });
        logger.error('[store] Failed to clear knowledge store:', err);
        throw err;
      }
    }
  }

  isStoreClosed(): boolean {
    return this.isClosing;
  }

  async close(): Promise<void> {
    this.isClosing = true;

    if (this.activeWrites.size > 0) {
      const maxWaitMs = 10000;
      const writesCount = this.activeWrites.size;
      let timeoutId: NodeJS.Timeout | undefined;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Close timeout')), maxWaitMs);
        });
        // We don't need a .catch() on Promise.allSettled because it never rejects,
        // but we DO need to ensure the timeoutPromise rejection is caught if it fires AFTER the race.
        timeoutPromise.catch((err: Error) => logger.debug(`[store] Background timeout rejection: ${err.message}`));
        
        await Promise.race([
          Promise.allSettled(Array.from(this.activeWrites)),
          timeoutPromise
        ]);
      } catch (_err) {
        logger.warn(`[store] Closing with ${this.activeWrites.size} pending operations after timeout (started with ${writesCount})`);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    try {
      this.table = null;
      this.rrfReranker = null;
      if (this.db) {
        // close() is typed void, but the native LanceDB binding may dispatch
        // file-descriptor/manifest-flush teardown asynchronously. Await it (via
        // Promise.resolve so a sync void return is fine too) before dropping the
        // reference, so a rapid close→reconnect can't observe a half-flushed manifest.
        await Promise.resolve(this.db.close());
        this.db = null;
      }
    } catch (err) {
      logger.error('[store] Error during close:', err);
    }
  }
}