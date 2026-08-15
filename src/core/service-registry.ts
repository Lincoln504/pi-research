/**
 * Service Registry - Centralized Dependency Injection Container
 *
 * This module provides a service registry pattern to manage singleton services
 * throughout the pi-research application. It replaces global state management
 * with a proper dependency injection system.
 *
 * Benefits:
 * - Explicit dependency management
 * - Testability (easy to mock/replace services)
 * - Lifecycle management (init, cleanup)
 * - Type safety
 * - No more globalThis pollution
 */

import { logger } from '../logger.ts';
import { AsyncLocalStorage } from 'node:async_hooks';


/**
 * How long teardown waits for an initialization or a clear()/replace()
 * disposal that is still in flight. Long enough to cover a normal service
 * coming up or tearing down, short enough that a service blocked on
 * something slow (a model download) cannot hold shutdown open indefinitely.
 */
const DISPOSE_INFLIGHT_INIT_TIMEOUT_MS = 5_000;

/**
 * Service lifecycle stages
 */
export enum ServiceLifecycle {
  UNINITIALIZED = 'uninitialized',
  INITIALIZING = 'initializing',
  INITIALIZED = 'initialized',
  DISABLED = 'disabled',
  DISPOSING = 'disposing',
  DISPOSED = 'disposed',
}

/**
 * Base interface for all services
 */
export interface IService {
  /**
   * Unique identifier for this service
   */
  readonly name: string;

  /**
   * Current lifecycle state
   */
  lifecycle: ServiceLifecycle;

  /**
   * Initialize the service (called before first use)
   */
  initialize?(ctx?: any): Promise<void> | void;

  /**
   * Dispose the service (called during shutdown)
   */
  dispose?(): Promise<void> | void;
}

/**
 * Service factory function type
 */
export type ServiceFactory<T extends IService> = () => T | Promise<T>;

/**
 * Service container options
 */
export interface ServiceContainerOptions {
  /**
   * Whether to allow overwriting existing services
   * @default false (service replacement is not allowed)
   */
  allowOverwrite?: boolean;

  /**
   * Whether to log service lifecycle events
   * @default true
   */
  enableLogging?: boolean;
}

/**
 * Service registration metadata
 */
interface ServiceRegistration<T extends IService> {
  factory: ServiceFactory<T>;
  instance: T | null;
  initializationPromise: Promise<T> | null;
  // A clear()/replace() disposal currently tearing this service's instance
  // down. get() awaits this before touching registration.instance — without
  // it, a concurrent get() arriving mid-disposal (instance still non-null;
  // dispose() hasn't nulled it yet) would either re-initialize the very
  // instance being disposed (ctx branch) or hand a caller a reference that's
  // about to be (or already was) torn down.
  disposalPromise: Promise<void> | null;
  options: ServiceContainerOptions;
}

/**
 * AsyncLocalStorage to track which service is currently being initialized.
 * Used to build a dependency graph for safe teardown.
 */
const initializationContext = new AsyncLocalStorage<string>();

/**
 * Centralized service container for dependency injection
 */
export class ServiceContainer {
  private services: Map<string, ServiceRegistration<any>> = new Map();
  private dependencies: Map<string, Set<string>> = new Map();
  public isDisposing: boolean = false;
  // The single in-flight disposeAll() run, so concurrent disposeAll()/reset() calls
  // coalesce onto (and AWAIT) it rather than a second caller observing "disposed" while
  // teardown is still running, or reset() throwing mid-disposal.
  private _disposalPromise: Promise<void> | null = null;
  public isReady: boolean = false;
  public cwd: string = process.cwd();
  public config: any = null;
  private readonly defaultOptions: Required<ServiceContainerOptions>;

  constructor(options: ServiceContainerOptions = {}) {
    this.defaultOptions = {
      allowOverwrite: options.allowOverwrite ?? false,
      enableLogging: options.enableLogging ?? true,
    };
  }

  /**
   * Register a service with the container
   */
  register<T extends IService>(
    name: string,
    factory: ServiceFactory<T>,
    options: ServiceContainerOptions = {}
  ): void {
    if (this.isDisposing) {
      throw new Error(`Cannot register service '${name}' during container disposal`);
    }

    const mergedOptions = { ...this.defaultOptions, ...options };

    if (this.services.has(name)) {
      if (!mergedOptions.allowOverwrite) {
        throw new Error(`Service '${name}' is already registered. Use registerAndReplace() to overwrite.`);
      }
      if (mergedOptions.enableLogging) {
        logger.warn(`[ServiceContainer] Replacing service '${name}'`);
      }
    } else {
      if (mergedOptions.enableLogging) {
        logger.debug(`[ServiceContainer] Registering service '${name}'`);
      }
    }

    this.services.set(name, {
      factory,
      instance: null,
      initializationPromise: null,
      disposalPromise: null,
      options: mergedOptions,
    });
    
    // Reset dependencies for this service
    this.dependencies.set(name, new Set());
  }

  /**
   * Register a service, replacing any existing service
   */
  async registerAndReplace<T extends IService>(
    name: string,
    factory: ServiceFactory<T>,
    options: ServiceContainerOptions = {}
  ): Promise<void> {
    const mergedOptions = { ...this.defaultOptions, ...options, allowOverwrite: true };

    // Dispose existing service if present
    const registration = this.services.get(name);
    if (registration) {
      // Join an already-in-flight clear()/replace()/disposeAll() on this
      // registration before touching its instance — the same guard those paths
      // use on each other. Without it, a concurrent teardown and this call both
      // dispose the SAME instance, and register() below then swaps the whole
      // registration object out from under the in-flight one, orphaning any
      // instance it constructs.
      // while(), not if(): a newer disposal can begin while we are awaiting this
      // one, exactly as get() documents for the same field.
      while (registration.disposalPromise) {
        await registration.disposalPromise.catch(() => { /* disposal errors are logged by clear()/replace() */ });
      }
      // Settle an in-flight initialization too, so we never discard a service
      // that is still being built — mirrors replace().
      if (registration.initializationPromise) {
        await registration.initializationPromise.catch(() => { /* failed init cleaned up after itself */ });
      }
      if (registration.instance && registration.instance.dispose) {
        try {
          await registration.instance.dispose();
        } catch (err: unknown) {
          logger.warn(`[ServiceContainer] Error disposing replaced service '${name}':`, err);
        }
      }
    }

    this.register(name, factory, mergedOptions);
  }

  /**
   * Record a dependency between two services
   */
  private addDependency(dependent: string, dependency: string): void {
    let deps = this.dependencies.get(dependent);
    if (!deps) {
      deps = new Set();
      this.dependencies.set(dependent, deps);
    }
    deps.add(dependency);
  }

  /**
   * Get a service instance, initializing it if necessary
   */
  async get<T extends IService>(name: string, ctx?: any): Promise<T> {
    if (this.isDisposing) {
      throw new Error(`Cannot get service '${name}' during container disposal`);
    }

    // Track dependency if we are currently inside an initialization or use-case of another service
    const caller = initializationContext.getStore();
    if (caller && caller !== name) {
      this.addDependency(caller, name);
    }

    const registration = this.services.get(name);
    if (!registration) {
      throw new Error(`Service '${name}' is not registered`);
    }

    // A clear()/replace() disposal in flight must settle before anything below
    // reads registration.instance — otherwise this call could re-initialize
    // (ctx branch) or hand back a reference to the very instance currently
    // being torn down. while(), not if(): a newer disposal can start again
    // while we're awaiting (mirrors the initializationPromise wait pattern
    // used throughout this method).
    while (registration.disposalPromise) {
      await registration.disposalPromise.catch(() => { /* disposal errors are logged by clear()/replace() */ });
    }

    // Return existing instance if already initialized.
    if (registration.instance) {
      // `_initializeService` publishes `registration.instance` BEFORE awaiting the
      // service's own initialize(), deliberately: a service whose initialize()
      // resolves a peer that resolves it back would otherwise deadlock, and the
      // partial instance is what breaks that cycle. But the same early publish
      // hands a HALF-BUILT service to unrelated concurrent callers — e.g.
      // StateManagerService only assigns its inner manager after nine awaited
      // getService() calls, so every method on it throws "not initialized" until
      // then, and the embedding factory resolves it and immediately calls
      // updateState(). Worse, the ctx branch below would re-run initialize() on an
      // instance that is still running it, constructing a second StateManager and
      // discarding the first.
      //
      // So: if it is still initializing, wait for that to finish. The cycle case is
      // exactly the case where `caller` is set (we are inside some service's
      // initialize()), and there we must NOT wait — that is the deadlock the early
      // publish exists to avoid. Outside an initialization there is no cycle to
      // break and waiting is always correct.
      if (registration.initializationPromise && caller === undefined) {
        await registration.initializationPromise.catch(() => { /* surfaced below */ });
        if (!registration.instance) {
          // Initialization failed and cleaned up after itself — fall through and
          // retry from scratch rather than returning a torn-down instance.
          return this.get<T>(name, ctx);
        }
      }
      // Re-initialize if ctx is provided and service supports it
      if (ctx && registration.instance.initialize) {
        // Wrap in initializationContext so nested get() calls are tracked
        const reinit = initializationContext.run(name, async () => {
          await registration.instance!.initialize!(ctx);
          return registration.instance as T;
        });
        // Recorded like a first init: a re-init is just as in-flight. Without
        // this, disposeAll's settle-wait cannot see it (it would dispose the
        // instance under a running initialize()), and concurrent callers
        // received the instance mid-re-initialization.
        registration.initializationPromise = reinit as Promise<IService>;
        // Identity-guarded: only touch shared state if THIS reinit is still the
        // one the registration is currently tracking — a newer reinit/init that
        // superseded it (and already published its own result) must not be
        // clobbered by a stale settlement arriving after it.
        const isStillCurrent = () => registration.initializationPromise === (reinit as Promise<IService>);
        reinit.then(
          () => { if (isStillCurrent()) registration.initializationPromise = null; },
          () => {
            // A re-init failure can leave THIS SAME instance in an inconsistent
            // internal state — e.g. KnowledgeStoreService disposes its old
            // handles before rebuilding on a cwd/mode change, then can still
            // throw mid-rebuild. Unlike a fresh _initializeService() failure
            // (which nulls registration.instance so the next get() rebuilds via
            // the factory), this path used to leave the registry believing the
            // same now-broken object was still a valid instance indefinitely.
            // Mirror _initializeService's own failure handling for consistency.
            if (!isStillCurrent()) return;
            registration.initializationPromise = null;
            if (registration.instance) {
              registration.instance.lifecycle = ServiceLifecycle.UNINITIALIZED;
              registration.instance = null;
            }
          },
        );
        return reinit;
      }
      return registration.instance as T;
    }

    // Return existing initialization promise if in progress
    if (registration.initializationPromise) {
      return registration.initializationPromise as Promise<T>;
    }

    // Initialize the service within the tracking context
    registration.initializationPromise = initializationContext.run(name, () => 
      this._initializeService(registration, ctx)
    );

    try {
      const instance = await registration.initializationPromise;
      return instance as T;
    } catch (error) {
      // Clear initialization promise on error so next call retries
      registration.initializationPromise = null;
      throw error;
    }
  }

  /**
   * Get a service instance synchronously (returns null if not registered or not
   * yet constructed).
   *
   * Deliberately returns instances in NON-settled lifecycles too. This is a
   * lifecycle *inspector* as much as an accessor: the health check resolves the
   * knowledge store through it precisely so it can report `initializing` /
   * `disabled` / `disposed (not running)` WITHOUT forcing initialization (forcing
   * it was a past cause of 45 s CI stalls). Filtering those states out here would
   * make every one of them indistinguishable from "absent".
   *
   * The trade-off: because `_initializeService` publishes the instance before
   * awaiting its `initialize()` (to break dependency cycles), a caller that
   * immediately *uses* the result can catch a half-built service. Callers that
   * need a ready service must use the async `get()`, which waits — see the note
   * there. Callers that only inspect `lifecycle` are safe by construction.
   */
  tryGet<T extends IService>(name: string): T | null {
    if (this.isDisposing) {
      return null;
    }

    const registration = this.services.get(name);
    if (!registration) {
      return null;
    }

    return registration.instance as T | null;
  }

  /**
   * Check if a service is registered
   */
  has(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * Check if a service is initialized
   */
  isInitialized(name: string): boolean {
    const registration = this.services.get(name);
    // Must check registration exists FIRST — undefined?.instance gives undefined,
    // and undefined !== null is true, which would incorrectly report unregistered
    // services as initialized.
    if (!registration) return false;
    return registration.instance !== null;
  }

  /**
   * Clear (reset) a service instance, forcing re-initialization on next access
   */
  async clear(name: string): Promise<void> {
    const registration = this.services.get(name);
    if (!registration) {
      throw new Error(`Service '${name}' is not registered`);
    }

    // Join an already-in-flight clear()/replace() rather than starting a
    // second disposal of the same registration.
    if (registration.disposalPromise) {
      return registration.disposalPromise;
    }

    // Published for the whole body (not just the dispose() call below) so a
    // concurrent get() — which now awaits this before touching
    // registration.instance — cannot slip in during the init-settle wait
    // either, not only during the dispose() call itself.
    registration.disposalPromise = (async () => {
      try {
        // Settle an in-flight initialization first. Disposing the early-published
        // instance while its initialize() is still running hands the awaiting get()
        // caller a service that was disposed under it — observed as store-closed
        // errors when /research-config cleared the knowledge store during a
        // concurrent first search.
        if (registration.initializationPromise) {
          await registration.initializationPromise.catch(() => { /* failed init cleaned up after itself */ });
        }

        if (registration.instance && registration.instance.dispose) {
          await registration.instance.dispose().catch((err: unknown) => {
            logger.warn(`[ServiceContainer] Error disposing service '${name}':`, err);
          });
        }

        registration.instance = null;
        registration.initializationPromise = null;

        if (registration.options.enableLogging) {
          logger.debug(`[ServiceContainer] Cleared service '${name}'`);
        }
      } finally {
        registration.disposalPromise = null;
      }
    })();

    return registration.disposalPromise;
  }

  /**
   * Replace a service instance with a new one
   */
  async replace<T extends IService>(name: string, newInstance: T): Promise<void> {
    const registration = this.services.get(name);
    if (!registration) {
      throw new Error(`Service '${name}' is not registered`);
    }

    // Join an already-in-flight clear()/replace() — see clear().
    if (registration.disposalPromise) {
      await registration.disposalPromise;
    }

    // Published for the whole body — see clear()'s comment for why.
    registration.disposalPromise = (async () => {
      try {
        // Settle an in-flight initialization before swapping — see clear().
        if (registration.initializationPromise) {
          await registration.initializationPromise.catch(() => { /* failed init cleaned up after itself */ });
        }

        // Dispose old instance if present
        if (registration.instance && registration.instance.dispose) {
          await registration.instance.dispose().catch((err: unknown) => {
            logger.warn(`[ServiceContainer] Error disposing old service '${name}':`, err);
          });
        }

        registration.instance = newInstance;
        registration.initializationPromise = null;

        if (registration.options.enableLogging) {
          logger.debug(`[ServiceContainer] Replaced service '${name}'`);
        }
      } finally {
        registration.disposalPromise = null;
      }
    })();

    return registration.disposalPromise;
  }

  /**
   * Dispose all services using a true Directed Acyclic Graph (DAG) teardown.
   * This guarantees that services are only disposed after all their dependents
   * have been successfully torn down.
   */
  async disposeAll(): Promise<void> {
    // Synchronous re-entrancy guard: isDisposing is set as _runDisposeAll's first
    // statement (before any await), so a service whose dispose() re-enters disposeAll()
    // gets a safe no-op instead of recursing. Also publish the in-flight run as
    // _disposalPromise so reset() (a separate, non-re-entrant caller) can AWAIT the
    // teardown instead of throwing on the race — the Windows CI teardown fix.
    if (this.isDisposing) return;
    this._disposalPromise = this._runDisposeAll().finally(() => { this._disposalPromise = null; });
    return this._disposalPromise;
  }

  private async _runDisposeAll(): Promise<void> {
    this.isDisposing = true;
    if (this.defaultOptions.enableLogging) {
      logger.log('[ServiceContainer] Disposing all services (DAG-ordered teardown)...');
    }

    try {
      // Settle any initialization still in flight BEFORE snapshotting what to tear
      // down. `activeServices` is "instances that are non-null right now", so a
      // get() whose factory has not resolved yet is invisible to it — and nothing
      // else awaits it. Such a service installs itself into the registry AFTER
      // teardown reports completion and is never disposed: for BrowserTaskScheduler
      // that is a listening HTTP server plus a cluster pool and Camoufox children
      // outliving shutdown; for KnowledgeStoreService an ONNX session and LanceDB
      // handles. (SchedulerService.dispose hand-rolls this same guard for itself,
      // which does not help when the leaked service IS SchedulerService.)
      //
      // Bounded: a service blocked on something slow (a model download) must not
      // hold teardown open indefinitely. On timeout we proceed — the snapshot below
      // still catches anything that landed in the meantime.
      const inFlight = Array.from(this.services.values())
        .map((r) => r.initializationPromise)
        .filter((p): p is Promise<IService> => p != null);
      if (inFlight.length > 0) {
        if (this.defaultOptions.enableLogging) {
          logger.debug(`[ServiceContainer] Waiting for ${inFlight.length} in-flight initialization(s) before teardown`);
        }
        let settleTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled(inFlight),
          new Promise<void>((resolve) => {
            settleTimer = setTimeout(() => {
              logger.warn('[ServiceContainer] Timed out waiting for in-flight service initialization; proceeding with teardown');
              resolve();
            }, DISPOSE_INFLIGHT_INIT_TIMEOUT_MS);
            settleTimer.unref?.();
          }),
        ]);
        if (settleTimer) clearTimeout(settleTimer);
      }

      // A concurrent clear()/replace() can be mid-disposal right now: its
      // async IIFE has already called instance.dispose() (or is about to)
      // but hasn't yet nulled/replaced registration.instance. Snapshotting
      // activeServices without waiting for this would include that service,
      // and the loop below would call instance.dispose() a SECOND time on
      // the very same instance concurrently with clear()/replace()'s own
      // call — get() already guards against reading mid-disposal state (see
      // its own disposalPromise wait above); teardown needs the same guard
      // before it reads/touches registration.instance below. Bounded for the
      // same reason as the init wait: a service stuck disposing must not
      // hold overall teardown open indefinitely — the snapshot below still
      // catches whatever state is left after the timeout.
      const inFlightDisposals = Array.from(this.services.values())
        .map((r) => r.disposalPromise)
        .filter((p): p is Promise<void> => p != null);
      if (inFlightDisposals.length > 0) {
        if (this.defaultOptions.enableLogging) {
          logger.debug(`[ServiceContainer] Waiting for ${inFlightDisposals.length} in-flight disposal(s) before teardown`);
        }
        let disposalSettleTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled(inFlightDisposals),
          new Promise<void>((resolve) => {
            disposalSettleTimer = setTimeout(() => {
              logger.warn('[ServiceContainer] Timed out waiting for in-flight service disposal; proceeding with teardown');
              resolve();
            }, DISPOSE_INFLIGHT_INIT_TIMEOUT_MS);
            disposalSettleTimer.unref?.();
          }),
        ]);
        if (disposalSettleTimer) clearTimeout(disposalSettleTimer);
      }

      const activeServices = Array.from(this.services.keys()).filter(name =>
        this.services.get(name)?.instance !== null
      );
      
      const disposed = new Set<string>();
      
      // Perform iterative disposal of services that have no active dependents
      while (disposed.size < activeServices.length) {
        const toDispose: string[] = [];
        
        for (const name of activeServices) {
          if (disposed.has(name)) continue;
          
          // A service can be disposed if no OTHER active service depends on it
          // that hasn't been disposed yet.
          const hasUndisposedDependents = activeServices.some(other => 
            !disposed.has(other) && 
            other !== name && 
            this.dependencies.get(other)?.has(name)
          );
          
          if (!hasUndisposedDependents) {
            toDispose.push(name);
          }
        }
        
        if (toDispose.length === 0) {
          // Circular dependency detected or logic error
          const remaining = activeServices.filter(n => !disposed.has(n));
          logger.warn(`[ServiceContainer] Circular dependency or stuck disposal detected for: ${remaining.join(', ')}. Falling back to reverse-registration order.`);
          
          const reverseRegistrations = Array.from(this.services.entries()).reverse();
          for (const [name, registration] of reverseRegistrations) {
            if (!disposed.has(name) && registration.instance && registration.instance.dispose) {
              try { await registration.instance.dispose(); } catch (err) { logger.warn(`[ServiceContainer] Error disposing '${name}':`, err); }
              registration.instance = null;
              registration.initializationPromise = null;
            }
          }
          break;
        }
        
        // IMPORTANT: Sort toDispose in reverse-registration order. 
        // This ensures that if multiple services are independent, we still dispose
        // the one registered latest first, maintaining strict LIFO behavior by default.
        const serviceNamesInOrder = Array.from(this.services.keys());
        toDispose.sort((a, b) => serviceNamesInOrder.indexOf(b) - serviceNamesInOrder.indexOf(a));
        
        // Dispose independent services in parallel (but sequentially within this batch 
        // if we want to be 100% sure about order, though Promise.all is fine if they are truly independent)
        // Actually, to satisfy the test expectations of strict order, we should do them sequentially.
        for (const name of toDispose) {
          const registration = this.services.get(name)!;
          if (registration.instance && registration.instance.dispose) {
            try {
              await registration.instance.dispose();
            } catch (err: unknown) {
              logger.warn(`[ServiceContainer] Error disposing service '${name}':`, err);
            }
          }
          registration.instance = null;
          registration.initializationPromise = null;
          disposed.add(name);
        }
      }
    } finally {
      this.isDisposing = false;
      if (this.defaultOptions.enableLogging) {
        logger.log('[ServiceContainer] All services disposed (registrations preserved)');
      }
    }
  }

  /**
   * Get the number of registered services
   */
  get size(): number {
    return this.services.size;
  }

  /**
   * Get names of all registered services
   */
  getServiceNames(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Get lifecycle state of a service
   */
  getServiceLifecycle(name: string): ServiceLifecycle | null {
    const registration = this.services.get(name);
    if (!registration) {
      return null;
    }

    // Promise first: the instance is published BEFORE its initialize() completes
    // (the early publish that lets dependency cycles resolve), so instance-first
    // ordering reported a mid-initialization service as INITIALIZED.
    if (registration.initializationPromise) {
      return ServiceLifecycle.INITIALIZING;
    }

    if (registration.instance) {
      return ServiceLifecycle.INITIALIZED;
    }

    return ServiceLifecycle.UNINITIALIZED;
  }

  /**
   * Reset the container, clearing all services
   * This is primarily used for testing to ensure clean state between test runs
   */
  async reset(): Promise<void> {
    // If a disposal is already in flight (e.g. a test's un-awaited shutdown, or a
    // concurrent teardown), WAIT for it rather than throwing — reset()'s contract is to
    // end up disposed+cleared, which the in-flight disposal is already doing. This fixed
    // a Windows-only CI teardown race that surfaced as unhandled
    // "Cannot reset container while disposing" rejections from an afterEach.
    if (this._disposalPromise) {
      await this._disposalPromise.catch(() => { /* disposal errors are logged in _runDisposeAll */ });
    }

    if (this.defaultOptions.enableLogging) {
      logger.debug('[ServiceContainer] Resetting container...');
    }

    // Use the safe DAG disposal logic
    await this.disposeAll();

    // Drain any disposal still in flight before clearing registrations. disposeAll()
    // returns immediately (isDisposing guard) when ANOTHER caller's disposal is already
    // running, so our await above may not have waited for it — and a concurrent
    // disposeAll iterating this.services while we clear() would make its services.get()
    // throw. Loop until no disposal promise remains (each clears _disposalPromise in its
    // finally). Non-reentrant and terminating: no new disposal can start once we hold the
    // sync path here with isDisposing still true.
    while (this._disposalPromise) {
      await this._disposalPromise.catch(() => { /* logged in _runDisposeAll */ });
    }

    // Clear all registrations
    this.services.clear();
    this.dependencies.clear();
    this.isDisposing = false;
    this.isReady = false;

    if (this.defaultOptions.enableLogging) {
      logger.debug('[ServiceContainer] Container reset complete');
    }
  }

  /**
   * Internal method to initialize a service
   */
  private async _initializeService<T extends IService>(
    registration: ServiceRegistration<T>,
    ctx?: any
  ): Promise<T> {
    let instance: T | null = null;
    try {
      instance = await registration.factory();
      registration.instance = instance;

      // Update lifecycle to initializing
      instance.lifecycle = ServiceLifecycle.INITIALIZING;

      // Call initialize hook if present
      if (instance.initialize) {
        await instance.initialize(ctx);
      }

      // Update lifecycle to initialized — but PRESERVE a DISABLED verdict the service's own
      // initialize() set for itself (e.g. the knowledge store when Knowledge Mode is 'none', or
      // a missing native binding). Unconditionally forcing INITIALIZED here left the store
      // "initialized" with null components: it mis-reported as "initializing" instead of
      // "disabled", and — because the mode-reenable revival keys off lifecycle === DISABLED — it
      // defeated live re-enabling via /research-config, so the store stayed dead until a restart.
      // Cast defeats control-flow narrowing: TS still thinks lifecycle is INITIALIZING (set
      // above), unaware that the awaited initialize() may have mutated it to DISABLED via `this`.
      if ((instance.lifecycle as ServiceLifecycle) !== ServiceLifecycle.DISABLED) {
        instance.lifecycle = ServiceLifecycle.INITIALIZED;
      }
      registration.initializationPromise = null;

      if (registration.options.enableLogging) {
        logger.debug(`[ServiceContainer] Service '${instance.name}' initialized`);
      }

      return instance;
    } catch (error) {
      // Clean up instance on failure
      if (instance) {
        instance.lifecycle = ServiceLifecycle.UNINITIALIZED;
        registration.instance = null;
      }
      registration.initializationPromise = null;
      throw error;
    }
  }
}

// ============================================================================
// Global Service Container Instance
// ============================================================================

/**
 * Global service container instance
 * This is the default container for the application.
 * CLI mode typically uses this instance.
 */
let globalServiceContainer = new ServiceContainer({
  allowOverwrite: false,
  enableLogging: true,
});

/**
 * Get the global service container instance
 */
export function getServiceContainer(): ServiceContainer {
  return globalServiceContainer;
}

/**
 * Create a new service container instance
 */
export function createServiceContainer(options: ServiceContainerOptions = {}): ServiceContainer {
  return new ServiceContainer(options);
}

/**
 * Convenience function to register a service
 */
export function registerService<T extends IService>(
  name: string,
  factory: ServiceFactory<T>,
  options?: ServiceContainerOptions,
  container: ServiceContainer = globalServiceContainer
): void {
  container.register(name, factory, options);
}

/**
 * Convenience function to replace a service
 */
export function replaceService<T extends IService>(
  name: string,
  factory: ServiceFactory<T>,
  options?: ServiceContainerOptions,
  container: ServiceContainer = globalServiceContainer
): Promise<void> {
  return container.registerAndReplace(name, factory, options);
}

/**
 * Convenience function to get a service
 */
export function getService<T extends IService>(name: string, ctx?: any, container: ServiceContainer = globalServiceContainer): Promise<T> {
  return container.get<T>(name, ctx);
}

/**
 * Convenience function to try getting a service synchronously
 */
export function tryGetService<T extends IService>(name: string, container: ServiceContainer = globalServiceContainer): T | null {
  return container.tryGet<T>(name);
}

/**
 * Convenience function to clear a service
 */
export function clearService(name: string, container: ServiceContainer = globalServiceContainer): Promise<void> {
  return container.clear(name);
}

/**
 * Convenience function to check if a service is registered
 */
export function hasService(name: string, container: ServiceContainer = globalServiceContainer): boolean {
  return container.has(name);
}

/**
 * Convenience function to check if a service is initialized
 */
export function isServiceInitialized(name: string, container: ServiceContainer = globalServiceContainer): boolean {
  return container.isInitialized(name);
}

/**
 * Helper to extract a service container from a context object, if present.
 */
export function tryGetServiceContainerFromCtx(ctx: any): ServiceContainer {
  if (ctx?.container && typeof ctx.container.get === 'function' && typeof ctx.container.register === 'function') {
    return ctx.container;
  }
  return globalServiceContainer;
}

/**
 * Dispose all services
 */
export function disposeAllServices(container: ServiceContainer = globalServiceContainer): Promise<void> {
  return container.disposeAll();
}

/**
 * Reset the global service container
 */
export function resetServiceContainer(container: ServiceContainer = globalServiceContainer): Promise<void> {
  return container.reset();
}