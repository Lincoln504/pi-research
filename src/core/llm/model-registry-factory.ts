/**
 * Shared Model Registry Factory
 *
 * Single source of truth for creating a ModelRegistry with the correct auth.
 * Used by the SDK entry point (src/sdk.ts), which also backs the bundled
 * `pi-research` CLI and the cross-harness agent skill.
 *
 * Previously this logic was duplicated (#29) — any bug fix now updates both paths.
 */

import { ModelRegistry, ModelRuntime, getAgentDir } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { Model } from '@earendil-works/pi-ai';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { logger } from '../../logger.ts';

/**
 * A structural subset of ModelRegistry that the research resolvers actually use.
 * The registry object can arrive from two places — our own factory and the pi
 * extension host (ctx.modelRegistry) — and a version skew
 * between the pi-coding-agent we build against and the one the host injects has
 * historically produced "modelRegistry.getAvailable is not a function" crashes
 * mid-research. Treating the registry structurally (and feature-detecting each
 * method) keeps researchers alive across that skew instead of throwing a raw
 * TypeError that aborts the run.
 */
export interface ModelRegistryLike {
  getAll?: () => Model<any>[];
  getAvailable?: () => Model<any>[];
  find?: (provider: string, id: string) => Model<any> | undefined;
  getApiKeyAndHeaders?: (model: Model<any>) => Promise<AuthResultLike>;
}

/**
 * Structural result of {@link ModelRegistryLike.getApiKeyAndHeaders}. Mirrors the
 * pi-coding-agent `ApiKeyAndHeaders` discriminated union without importing it, so
 * a host skew on the concrete type can't break our build.
 *
 * `headers` values are `string | null` (not just `string`) as of pi 0.84.0's
 * `ProviderHeaders` type — `null` is a legitimate header-DELETION marker (e.g.
 * stripping a placeholder credential before it reaches a gateway), not an
 * absent value. Every consumer of `headers` below must treat `null` as "omit
 * this header," not coerce it to the literal string `"null"`.
 */
export type AuthResultLike =
  | { ok: true; apiKey?: string; headers?: Record<string, string | null> }
  | { ok: false; error: string };

/** Safe `getAll()` — returns [] if the host registry lacks the method. */
export function safeGetAll(registry: ModelRegistryLike | null | undefined): Model<any>[] {
  if (registry && typeof registry.getAll === 'function') {
    try { return registry.getAll() ?? []; } catch (err) {
      logger.warn('[ModelRegistry] getAll() threw; treating as empty:', err);
    }
  }
  return [];
}

/**
 * Safe `getAvailable()` — the authed/usable subset. Falls back to getAll() when
 * the host registry does not expose getAvailable() (older/newer host skew), so a
 * missing method degrades to "treat every known model as available" rather than
 * crashing the researcher.
 */
export function safeGetAvailable(registry: ModelRegistryLike | null | undefined): Model<any>[] {
  if (registry && typeof registry.getAvailable === 'function') {
    try { return registry.getAvailable() ?? []; } catch (err) {
      logger.warn('[ModelRegistry] getAvailable() threw; falling back to getAll():', err);
    }
  } else if (registry) {
    logger.warn('[ModelRegistry] host registry has no getAvailable(); falling back to getAll(). Possible pi-coding-agent version skew.');
  }
  return safeGetAll(registry);
}

/**
 * Safe `getApiKeyAndHeaders()` — resolves LLM credentials for a model. The
 * registry can arrive from the pi extension host (ctx.modelRegistry), so a
 * version skew that renamed/removed this method must NOT throw a raw TypeError
 * mid-research (the same failure class {@link safeGetAvailable} guards against).
 * A missing method or a throw degrades to a structured `{ ok: false }` that every
 * caller already branches on, instead of aborting the run.
 */
export async function safeGetApiKeyAndHeaders(
  registry: ModelRegistryLike | null | undefined,
  model: Model<any>,
): Promise<AuthResultLike> {
  if (!registry || typeof registry.getApiKeyAndHeaders !== 'function') {
    logger.warn('[ModelRegistry] host registry has no getApiKeyAndHeaders(); cannot resolve LLM credentials. Possible pi-coding-agent version skew.');
    return { ok: false, error: 'model registry does not expose getApiKeyAndHeaders() (pi-coding-agent version skew)' };
  }
  try {
    return await registry.getApiKeyAndHeaders(model);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[ModelRegistry] getApiKeyAndHeaders() threw; treating as auth failure:', msg);
    return { ok: false, error: msg };
  }
}

/**
 * Headers commonly required by third-party LLM providers
 */
function buildHeaders(provider?: string): Record<string, string> {
  if (provider === 'openrouter') return { 'HTTP-Referer': 'https://pi.ai', 'X-Title': 'pi-research' };
  return {};
}

/**
 * Create a ModelRegistry with the given credentials.
 *
 * pi 0.80.8 replaced `AuthStorage`/`ModelRegistry.create()` with the async
 * `ModelRuntime`: `ModelRegistry` is now a SYNCHRONOUS compatibility facade that
 * wraps a `ModelRuntime` and still exposes `getAll`/`getAvailable`/`find`/
 * `getApiKeyAndHeaders` — so every consumer of the registry (resolveModel,
 * safeGet*, the research-model resolver) stays synchronous. Only this factory
 * became async (constructing the ModelRuntime is inherently async) and its two
 * callers await it. Mirrors how pi itself builds a registry
 * (`sdk.js`: `await ModelRuntime.create({ authPath, modelsPath })`).
 *
 * @param apiKey  - Optional explicit API key
 * @param provider - Optional provider name to key the API key under
 * @returns A configured ModelRegistry
 */
export async function buildModelRegistry(apiKey?: string, provider?: string): Promise<ModelRegistry> {
  const agentDir = getAgentDir();
  const modelsJsonPath = path.join(agentDir, 'models.json');
  const authPath = path.join(agentDir, 'auth.json');
  const hasModels = fs.existsSync(modelsJsonPath);
  const hasAuth = fs.existsSync(authPath);

  // Build the runtime from the user's pi config (models.json + auth.json) when
  // EITHER file is present, otherwise a bare runtime that reads env-var keys and
  // built-in providers. allowModelNetwork:false preserves the prior behavior of
  // NOT doing a network model-catalog refresh at construction (the old
  // ModelRegistry.create only read the local files). Env provider keys
  // (e.g. OPENAI_API_KEY) are resolved via pi-ai's provider auth CONTEXT, not the
  // credential store, so they are honored in every branch below; embedded
  // models.json apiKeys likewise — auth.json presence must not gate models.json.
  //
  // When auth.json does NOT exist, an explicit in-memory credential store is
  // passed instead of letting ModelRuntime default to the file at authPath:
  // AuthStorage's file backend CREATES ~/.pi/agent/ and an empty auth.json as a
  // construction side effect (mkdir+write). Without this, every CLI invocation —
  // including read-only ones like `status` — would silently create a pi config
  // dir on machines that never installed pi, and would hard-fail in read-only-
  // $HOME environments (containers/CI) where the old in-memory path needed no
  // filesystem write access at all.
  const runtime = await ModelRuntime.create({
    authPath: hasAuth ? authPath : undefined,
    credentials: hasAuth ? undefined : new InMemoryCredentialStore(),
    modelsPath: hasModels ? modelsJsonPath : null,
    allowModelNetwork: false,
  });

  // Explicit key: seed it on the runtime after construction. NOTE: unlike the old
  // AuthStorage.inMemory({ [provider]: ... }) seeding, this MERGES — the explicit
  // key wins for its own provider (runtime overrides are checked first), but any
  // providers already configured in auth.json remain visible in getAvailable().
  // That broadening is acceptable because explicit-key flows always pair the key
  // with an explicit model (enforced in cli.ts pre-flight), so resolution never
  // falls back to "first available".
  if (apiKey && provider) {
    // pi 0.84.0 removed `allowNetwork` from setRuntimeApiKey's own options
    // (AuthOperationOptions is now just `{ signal? }`) — but its internal
    // synchronizeCredentialState() now hardcodes `refresh({ allowNetwork:
    // false, ... })` unconditionally on every call, so the "no live catalog
    // connection, no indefinite hang in network-restricted environments"
    // guarantee this call originally needed still holds without asking for
    // it. Confirmed by reading pi-coding-agent's model-runtime.js directly,
    // not just the changelog prose — verify this again on the next pi bump
    // before assuming it's still unconditional.
    await runtime.setRuntimeApiKey(provider, apiKey);
  }

  // The sync facade all our resolvers consume. getAvailable()/getApiKeyAndHeaders()
  // read a cached snapshot populated by create(), so the sync reads below work
  // without further awaits.
  const registry = new ModelRegistry(runtime);
  registryRuntimes.set(registry, runtime);
  return registry;
}

/**
 * The ModelRuntime backing each registry this factory built. Researcher sessions
 * must be created with `modelRuntime` (pi 0.80.8+ replaced the old
 * `modelRegistry` session option): without it, createAgentSession() builds its
 * OWN runtime from the default ~/.pi/agent paths, which never sees an explicit
 * API key seeded via setRuntimeApiKey above — standalone PI_RESEARCH_API_KEY
 * users with no (or a different-provider) auth.json would pass pre-flight and
 * then fail auth on every researcher LLM call.
 */
const registryRuntimes = new WeakMap<ModelRegistry, ModelRuntime>();

/**
 * Return the ModelRuntime behind a registry built by {@link buildModelRegistry},
 * or undefined for registries built elsewhere (e.g. the pi host's own
 * ExtensionContext.modelRegistry — for those, createAgentSession()'s default
 * runtime construction from the host's agent dir is exactly right).
 */
export function getRuntimeForRegistry(registry: unknown): ModelRuntime | undefined {
  return registry instanceof Object ? registryRuntimes.get(registry as ModelRegistry) : undefined;
}

/**
 * Construct a minimal Model object directly from provider + modelId + apiKey.
 *
 * Used when the user provides credentials but has no pi config directory
 * (e.g., SDK / CLI / agent-skill users without pi installed).
 * Bypasses the full ModelRegistry which would fail without models.json.
 */
export function constructMinimalModel(provider: string, modelId: string, _apiKey: string): Model<any> {
  return {
    provider,
    id: modelId,
    name: modelId,
    // Map to a REAL pi-ai api id — "<provider>-conversations" is not one, and a
    // keyed no-registry setup would pass pre-flight then die on the first call.
    // Unknown providers default to the OpenAI-compatible protocol, which is what
    // virtually every third-party endpoint (openrouter, groq, cerebras, …) speaks.
    api: ({
      openai: 'openai-completions',
      anthropic: 'anthropic-messages',
      google: 'google-generative-ai',
      gemini: 'google-generative-ai',
      mistral: 'mistral-conversations',
    } as Record<string, string>)[provider] ?? 'openai-completions',
    baseUrl: '', // Provider-specific base URLs are handled by pi-ai internal registry
    reasoning: false,
    input: ['text'],
    // No catalog is available on this path, so there is no price data and no real
    // context/output ceiling to read. The zeros below are "unknown", NOT "free":
    // cost reporting for this model will read $0.00 (see warnIfUnpriced in
    // utils/llm-usage.ts), and the window figures are conservative guesses, not the
    // model's true limits — so docs/CONFIGURATION.md's "clamped to the model's real
    // ceiling" guarantee does not hold here. Anyone relying on accurate cost or the
    // full context window should give pi a credential so it can fetch the real catalog.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_768,
    headers: buildHeaders(provider),
  } as unknown as Model<any>;
}

/**
 * Resolve a Model instance from a registry based on an optional model string or provider.
 *
 * @param registry - The ModelRegistry to search in
 * @param modelSpec - Optional model string ("provider/modelId" or "modelId")
 * @param provider - Optional provider name to use as fallback
 * @param apiKey - Optional API key to construct a fallback model when registry is empty
 * @returns The resolved Model instance
 * @throws Error if no model can be resolved
 */
export function resolveModel(registry: ModelRegistry, modelSpec?: string, provider?: string, apiKey?: string): Model<any> {
  // 1. Explicit model string: "provider/modelId" or "modelId"
  if (modelSpec) {
    const slashIdx = modelSpec.indexOf('/');
    if (slashIdx > 0) {
      const prov = modelSpec.slice(0, slashIdx);
      const modelId = modelSpec.slice(slashIdx + 1);
      const found = typeof registry.find === 'function'
        ? registry.find(prov, modelId)
        : safeGetAll(registry).find(m => m.provider === prov && m.id === modelId);
      if (found) return found;
      
      // Fallback for SDK / CLI / skill users without pi config: construct model from credentials
      if (apiKey && provider) {
        return constructMinimalModel(prov, modelId, apiKey);
      }
      
      throw new Error(buildModelNotFoundMessage(modelSpec));
    }
    
    // Validate format: must contain a slash OR be found as a bare model ID.
    // A bare id can exist under several providers (a user-configured authed one
    // plus pi's built-in unauthed one); prefer an authed provider so we don't
    // resolve to a keyless entry that fails at the first call.
    const allModels = safeGetAll(registry);
    const sameId = allModels.filter(m => m.id === modelSpec);
    const authedKeys = new Set(safeGetAvailable(registry).map(m => `${m.provider}/${m.id}`));
    const found = sameId.find(m => authedKeys.has(`${m.provider}/${m.id}`)) ?? sameId[0];
    if (found) return found;

    throw new Error(`Invalid model string "${modelSpec}". Expected "provider/id" e.g. "openai/gpt-4o".`);
  }

  // 2. Provider-only: pick first available model from that provider
  if (provider) {
    const allModels = safeGetAll(registry);
    const found = allModels.find(m => m.provider === provider);
    if (found) return found;
  }

  // 3. First available model — prefer providers in the user's models.json order.
  //    pi-ai loads built-in providers in a fixed catalog order (openrouter is 26th).
  //    User-configured providers in models.json (e.g. glm-coding) are appended after
  //    the built-ins, so getAvailable()[0] would otherwise always pick a built-in
  //    provider even when the user has a preferred custom one. Walk models.json provider
  //    order first to respect the user's explicit configuration.
  const available = safeGetAvailable(registry);
  if (available.length > 0) {
    return pickPreferredAvailable(available, readModelsJsonProviderOrder())!;
  }

  // 4. Any model at all
  const all = safeGetAll(registry);
  if (all.length > 0) return all[0]!;

  // 5. Fallback: construct minimal model from credentials when registry is empty
  // (Re-checking modelSpec with slash check is redundant but kept for logic safety)
  if (apiKey && provider && modelSpec) {
    const slashIdx = modelSpec.indexOf('/');
    if (slashIdx > 0) {
      return constructMinimalModel(
        modelSpec.slice(0, slashIdx),
        modelSpec.slice(slashIdx + 1),
        apiKey,
      );
    }
    // No slash: use the explicit provider and the modelSpec as the ID
    return constructMinimalModel(provider, modelSpec, apiKey);
  }

  throw new Error(buildNoModelAvailableMessage());
}

/**
 * Credential-first guidance for model-resolution failures.
 *
 * These messages used to say only "Check ~/.pi/agent/models.json", which is the
 * WRONG remedy for a provider pi ships built in: the fix there is a credential,
 * after which pi fetches the provider's catalog (with real pricing and context
 * limits) on its own. Following the old advice, users hand-wrote `models[]`
 * entries — and because such an entry REPLACES pi's catalog entry wholesale
 * rather than merging into it, that silently zeroed out pricing and capped
 * context/output windows. Lead with the credential path; scope models.json to
 * genuinely custom providers; name `modelOverrides` for single-field tweaks.
 */
function credentialGuidance(): string {
  const agentDir = getAgentDir();
  return (
    `  • Provider pi supports built-in (openrouter, anthropic, openai, …): add a credential — run \`pi\` and use /login, ` +
    `set the provider's API-key environment variable, or add it to ${path.join(agentDir, 'auth.json')}. ` +
    `pi then fetches that provider's model catalog automatically.\n` +
    `  • Custom or self-hosted provider (Ollama, vLLM, a proxy): declare it in ${path.join(agentDir, 'models.json')}.\n` +
    `    Note: a models.json entry REPLACES pi's catalog entry for the same model id, discarding its pricing and\n` +
    `    context/output limits. To adjust a single field of a built-in model, use "modelOverrides" instead — it merges.`
  );
}

export function buildModelNotFoundMessage(modelSpec: string): string {
  return `Model "${modelSpec}" not found in pi's model registry.\n${credentialGuidance()}`;
}

export function buildNoModelAvailableMessage(): string {
  return `No LLM model available.\n${credentialGuidance()}\n  • Or pass an explicit apiKey.`;
}

/**
 * Read the user's provider order from ~/.pi/agent/models.json.
 * Returns provider keys in document (insertion) order, or [] when the file is
 * absent or malformed. Kept separate from {@link pickPreferredAvailable} so the
 * selection logic stays pure and unit-testable without touching the filesystem.
 */
export function readModelsJsonProviderOrder(): string[] {
  const modelsJsonPath = path.join(getAgentDir(), 'models.json');
  if (!fs.existsSync(modelsJsonPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf-8'));
    return Object.keys(raw?.providers ?? {});
  } catch (err) {
    // Malformed models.json only affects provider-preference ordering (benign), but log
    // a warn to match every other registry fault in this file rather than swallowing it.
    logger.warn(`[ModelRegistry] Could not read provider order from models.json: ${err}`);
    return [];
  }
}

/**
 * Pick the first available model whose provider appears earliest in the user's
 * configured provider order; fall back to the first available model when no
 * provider in `providerOrder` is available. Pure — no filesystem access — so it
 * is the single source of truth for "first available" fallback ordering shared
 * by both {@link resolveModel} and the research-model resolver.
 */
export function pickPreferredAvailable<T extends { provider: string }>(
  available: T[],
  providerOrder: string[],
): T | undefined {
  for (const prov of providerOrder) {
    const match = available.find(m => m.provider === prov);
    if (match) return match;
  }
  return available[0];
}
