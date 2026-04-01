/**
 * Model registry - manages built-in and custom models, provides API key resolution.
 */
import { getModels, getProviders, registerApiProvider, resetApiProviders, } from "@mariozechner/pi-ai";
import { registerOAuthProvider, resetOAuthProviders } from "@mariozechner/pi-ai/oauth";
import { Type } from "@sinclair/typebox";
import AjvModule from "ajv";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../config.js";
import { clearConfigValueCache, resolveConfigValueOrThrow, resolveConfigValueUncached, resolveHeadersOrThrow, } from "./resolve-config-value.js";
const Ajv = AjvModule.default || AjvModule;
const ajv = new Ajv();
// Schema for OpenRouter routing preferences
const OpenRouterRoutingSchema = Type.Object({
    only: Type.Optional(Type.Array(Type.String())),
    order: Type.Optional(Type.Array(Type.String())),
});
// Schema for Vercel AI Gateway routing preferences
const VercelGatewayRoutingSchema = Type.Object({
    only: Type.Optional(Type.Array(Type.String())),
    order: Type.Optional(Type.Array(Type.String())),
});
// Schema for OpenAI compatibility settings
const ReasoningEffortMapSchema = Type.Object({
    minimal: Type.Optional(Type.String()),
    low: Type.Optional(Type.String()),
    medium: Type.Optional(Type.String()),
    high: Type.Optional(Type.String()),
    xhigh: Type.Optional(Type.String()),
});
const OpenAICompletionsCompatSchema = Type.Object({
    supportsStore: Type.Optional(Type.Boolean()),
    supportsDeveloperRole: Type.Optional(Type.Boolean()),
    supportsReasoningEffort: Type.Optional(Type.Boolean()),
    reasoningEffortMap: Type.Optional(ReasoningEffortMapSchema),
    supportsUsageInStreaming: Type.Optional(Type.Boolean()),
    maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
    requiresToolResultName: Type.Optional(Type.Boolean()),
    requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
    requiresThinkingAsText: Type.Optional(Type.Boolean()),
    thinkingFormat: Type.Optional(Type.Union([
        Type.Literal("openai"),
        Type.Literal("openrouter"),
        Type.Literal("zai"),
        Type.Literal("qwen"),
        Type.Literal("qwen-chat-template"),
    ])),
    openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
    vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
    supportsStrictMode: Type.Optional(Type.Boolean()),
});
const OpenAIResponsesCompatSchema = Type.Object({});
const OpenAICompatSchema = Type.Union([OpenAICompletionsCompatSchema, OpenAIResponsesCompatSchema]);
// Schema for custom model definition
// Most fields are optional with sensible defaults for local models (Ollama, LM Studio, etc.)
const ModelDefinitionSchema = Type.Object({
    id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    api: Type.Optional(Type.String({ minLength: 1 })),
    baseUrl: Type.Optional(Type.String({ minLength: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
    input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
    cost: Type.Optional(Type.Object({
        input: Type.Number(),
        output: Type.Number(),
        cacheRead: Type.Number(),
        cacheWrite: Type.Number(),
    })),
    contextWindow: Type.Optional(Type.Number()),
    maxTokens: Type.Optional(Type.Number()),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    compat: Type.Optional(OpenAICompatSchema),
});
// Schema for per-model overrides (all fields optional, merged with built-in model)
const ModelOverrideSchema = Type.Object({
    name: Type.Optional(Type.String({ minLength: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
    input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
    cost: Type.Optional(Type.Object({
        input: Type.Optional(Type.Number()),
        output: Type.Optional(Type.Number()),
        cacheRead: Type.Optional(Type.Number()),
        cacheWrite: Type.Optional(Type.Number()),
    })),
    contextWindow: Type.Optional(Type.Number()),
    maxTokens: Type.Optional(Type.Number()),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    compat: Type.Optional(OpenAICompatSchema),
});
const ProviderConfigSchema = Type.Object({
    baseUrl: Type.Optional(Type.String({ minLength: 1 })),
    apiKey: Type.Optional(Type.String({ minLength: 1 })),
    api: Type.Optional(Type.String({ minLength: 1 })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    compat: Type.Optional(OpenAICompatSchema),
    authHeader: Type.Optional(Type.Boolean()),
    models: Type.Optional(Type.Array(ModelDefinitionSchema)),
    modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});
const ModelsConfigSchema = Type.Object({
    providers: Type.Record(Type.String(), ProviderConfigSchema),
});
ajv.addSchema(ModelsConfigSchema, "ModelsConfig");
function emptyCustomModelsResult(error) {
    return { models: [], overrides: new Map(), modelOverrides: new Map(), error };
}
function mergeCompat(baseCompat, overrideCompat) {
    if (!overrideCompat)
        return baseCompat;
    const base = baseCompat;
    const override = overrideCompat;
    const merged = { ...base, ...override };
    const baseCompletions = base;
    const overrideCompletions = override;
    const mergedCompletions = merged;
    if (baseCompletions?.openRouterRouting || overrideCompletions.openRouterRouting) {
        mergedCompletions.openRouterRouting = {
            ...baseCompletions?.openRouterRouting,
            ...overrideCompletions.openRouterRouting,
        };
    }
    if (baseCompletions?.vercelGatewayRouting || overrideCompletions.vercelGatewayRouting) {
        mergedCompletions.vercelGatewayRouting = {
            ...baseCompletions?.vercelGatewayRouting,
            ...overrideCompletions.vercelGatewayRouting,
        };
    }
    return merged;
}
/**
 * Deep merge a model override into a model.
 * Handles nested objects (cost, compat) by merging rather than replacing.
 */
function applyModelOverride(model, override) {
    const result = { ...model };
    // Simple field overrides
    if (override.name !== undefined)
        result.name = override.name;
    if (override.reasoning !== undefined)
        result.reasoning = override.reasoning;
    if (override.input !== undefined)
        result.input = override.input;
    if (override.contextWindow !== undefined)
        result.contextWindow = override.contextWindow;
    if (override.maxTokens !== undefined)
        result.maxTokens = override.maxTokens;
    // Merge cost (partial override)
    if (override.cost) {
        result.cost = {
            input: override.cost.input ?? model.cost.input,
            output: override.cost.output ?? model.cost.output,
            cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
            cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
        };
    }
    // Deep merge compat
    result.compat = mergeCompat(model.compat, override.compat);
    return result;
}
/** Clear the config value command cache. Exported for testing. */
export const clearApiKeyCache = clearConfigValueCache;
/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
export class ModelRegistry {
    authStorage;
    modelsJsonPath;
    models = [];
    providerRequestConfigs = new Map();
    modelRequestHeaders = new Map();
    registeredProviders = new Map();
    loadError = undefined;
    constructor(authStorage, modelsJsonPath) {
        this.authStorage = authStorage;
        this.modelsJsonPath = modelsJsonPath;
        this.loadModels();
    }
    static create(authStorage, modelsJsonPath = join(getAgentDir(), "models.json")) {
        return new ModelRegistry(authStorage, modelsJsonPath);
    }
    static inMemory(authStorage) {
        return new ModelRegistry(authStorage, undefined);
    }
    /**
     * Reload models from disk (built-in + custom from models.json).
     */
    refresh() {
        this.providerRequestConfigs.clear();
        this.modelRequestHeaders.clear();
        this.loadError = undefined;
        // Ensure dynamic API/OAuth registrations are rebuilt from current provider state.
        resetApiProviders();
        resetOAuthProviders();
        this.loadModels();
        for (const [providerName, config] of this.registeredProviders.entries()) {
            this.applyProviderConfig(providerName, config);
        }
    }
    /**
     * Get any error from loading models.json (undefined if no error).
     */
    getError() {
        return this.loadError;
    }
    loadModels() {
        // Load custom models and overrides from models.json
        const { models: customModels, overrides, modelOverrides, error, } = this.modelsJsonPath ? this.loadCustomModels(this.modelsJsonPath) : emptyCustomModelsResult();
        if (error) {
            this.loadError = error;
            // Keep built-in models even if custom models failed to load
        }
        const builtInModels = this.loadBuiltInModels(overrides, modelOverrides);
        let combined = this.mergeCustomModels(builtInModels, customModels);
        // Let OAuth providers modify their models (e.g., update baseUrl)
        for (const oauthProvider of this.authStorage.getOAuthProviders()) {
            const cred = this.authStorage.get(oauthProvider.id);
            if (cred?.type === "oauth" && oauthProvider.modifyModels) {
                combined = oauthProvider.modifyModels(combined, cred);
            }
        }
        this.models = combined;
    }
    /** Load built-in models and apply provider/model overrides */
    loadBuiltInModels(overrides, modelOverrides) {
        return getProviders().flatMap((provider) => {
            const models = getModels(provider);
            const providerOverride = overrides.get(provider);
            const perModelOverrides = modelOverrides.get(provider);
            return models.map((m) => {
                let model = m;
                // Apply provider-level baseUrl/headers/compat override
                if (providerOverride) {
                    model = {
                        ...model,
                        baseUrl: providerOverride.baseUrl ?? model.baseUrl,
                        compat: mergeCompat(model.compat, providerOverride.compat),
                    };
                }
                // Apply per-model override
                const modelOverride = perModelOverrides?.get(m.id);
                if (modelOverride) {
                    model = applyModelOverride(model, modelOverride);
                }
                return model;
            });
        });
    }
    /** Merge custom models into built-in list by provider+id (custom wins on conflicts). */
    mergeCustomModels(builtInModels, customModels) {
        const merged = [...builtInModels];
        for (const customModel of customModels) {
            const existingIndex = merged.findIndex((m) => m.provider === customModel.provider && m.id === customModel.id);
            if (existingIndex >= 0) {
                merged[existingIndex] = customModel;
            }
            else {
                merged.push(customModel);
            }
        }
        return merged;
    }
    loadCustomModels(modelsJsonPath) {
        if (!existsSync(modelsJsonPath)) {
            return emptyCustomModelsResult();
        }
        try {
            const content = readFileSync(modelsJsonPath, "utf-8");
            const config = JSON.parse(content);
            // Validate schema
            const validate = ajv.getSchema("ModelsConfig");
            if (!validate(config)) {
                const errors = validate.errors?.map((e) => `  - ${e.instancePath || "root"}: ${e.message}`).join("\n") ||
                    "Unknown schema error";
                return emptyCustomModelsResult(`Invalid models.json schema:\n${errors}\n\nFile: ${modelsJsonPath}`);
            }
            // Additional validation
            this.validateConfig(config);
            const overrides = new Map();
            const modelOverrides = new Map();
            for (const [providerName, providerConfig] of Object.entries(config.providers)) {
                if (providerConfig.baseUrl || providerConfig.compat) {
                    overrides.set(providerName, {
                        baseUrl: providerConfig.baseUrl,
                        compat: providerConfig.compat,
                    });
                }
                this.storeProviderRequestConfig(providerName, providerConfig);
                if (providerConfig.modelOverrides) {
                    modelOverrides.set(providerName, new Map(Object.entries(providerConfig.modelOverrides)));
                    for (const [modelId, modelOverride] of Object.entries(providerConfig.modelOverrides)) {
                        this.storeModelHeaders(providerName, modelId, modelOverride.headers);
                    }
                }
            }
            return { models: this.parseModels(config), overrides, modelOverrides, error: undefined };
        }
        catch (error) {
            if (error instanceof SyntaxError) {
                return emptyCustomModelsResult(`Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`);
            }
            return emptyCustomModelsResult(`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${modelsJsonPath}`);
        }
    }
    validateConfig(config) {
        for (const [providerName, providerConfig] of Object.entries(config.providers)) {
            const hasProviderApi = !!providerConfig.api;
            const models = providerConfig.models ?? [];
            const hasModelOverrides = providerConfig.modelOverrides && Object.keys(providerConfig.modelOverrides).length > 0;
            if (models.length === 0) {
                // Override-only config: needs baseUrl, compat, modelOverrides, or some combination.
                if (!providerConfig.baseUrl && !providerConfig.compat && !hasModelOverrides) {
                    throw new Error(`Provider ${providerName}: must specify "baseUrl", "compat", "modelOverrides", or "models".`);
                }
            }
            else {
                // Custom models are merged into provider models and require endpoint + auth.
                if (!providerConfig.baseUrl) {
                    throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
                }
                if (!providerConfig.apiKey) {
                    throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models.`);
                }
            }
            for (const modelDef of models) {
                const hasModelApi = !!modelDef.api;
                if (!hasProviderApi && !hasModelApi) {
                    throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`);
                }
                if (!modelDef.id)
                    throw new Error(`Provider ${providerName}: model missing "id"`);
                // Validate contextWindow/maxTokens only if provided (they have defaults)
                if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0)
                    throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
                if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0)
                    throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
            }
        }
    }
    parseModels(config) {
        const models = [];
        for (const [providerName, providerConfig] of Object.entries(config.providers)) {
            const modelDefs = providerConfig.models ?? [];
            if (modelDefs.length === 0)
                continue; // Override-only, no custom models
            for (const modelDef of modelDefs) {
                const api = modelDef.api || providerConfig.api;
                if (!api)
                    continue;
                const compat = mergeCompat(providerConfig.compat, modelDef.compat);
                this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);
                // Provider baseUrl is required when custom models are defined.
                // Individual models can override it with modelDef.baseUrl.
                const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
                models.push({
                    id: modelDef.id,
                    name: modelDef.name ?? modelDef.id,
                    api: api,
                    provider: providerName,
                    baseUrl: modelDef.baseUrl ?? providerConfig.baseUrl,
                    reasoning: modelDef.reasoning ?? false,
                    input: (modelDef.input ?? ["text"]),
                    cost: modelDef.cost ?? defaultCost,
                    contextWindow: modelDef.contextWindow ?? 128000,
                    maxTokens: modelDef.maxTokens ?? 16384,
                    headers: undefined,
                    compat,
                });
            }
        }
        return models;
    }
    /**
     * Get all models (built-in + custom).
     * If models.json had errors, returns only built-in models.
     */
    getAll() {
        return this.models;
    }
    /**
     * Get only models that have auth configured.
     * This is a fast check that doesn't refresh OAuth tokens.
     */
    getAvailable() {
        return this.models.filter((m) => this.hasConfiguredAuth(m));
    }
    /**
     * Find a model by provider and ID.
     */
    find(provider, modelId) {
        return this.models.find((m) => m.provider === provider && m.id === modelId);
    }
    /**
     * Get API key for a model.
     */
    hasConfiguredAuth(model) {
        return (this.authStorage.hasAuth(model.provider) ||
            this.providerRequestConfigs.get(model.provider)?.apiKey !== undefined);
    }
    getModelRequestKey(provider, modelId) {
        return `${provider}:${modelId}`;
    }
    storeProviderRequestConfig(providerName, config) {
        if (!config.apiKey && !config.headers && !config.authHeader) {
            return;
        }
        this.providerRequestConfigs.set(providerName, {
            apiKey: config.apiKey,
            headers: config.headers,
            authHeader: config.authHeader,
        });
    }
    storeModelHeaders(providerName, modelId, headers) {
        const key = this.getModelRequestKey(providerName, modelId);
        if (!headers || Object.keys(headers).length === 0) {
            this.modelRequestHeaders.delete(key);
            return;
        }
        this.modelRequestHeaders.set(key, headers);
    }
    /**
     * Get API key and request headers for a model.
     */
    async getApiKeyAndHeaders(model) {
        try {
            const providerConfig = this.providerRequestConfigs.get(model.provider);
            const apiKeyFromAuthStorage = await this.authStorage.getApiKey(model.provider, { includeFallback: false });
            const apiKey = apiKeyFromAuthStorage ??
                (providerConfig?.apiKey
                    ? resolveConfigValueOrThrow(providerConfig.apiKey, `API key for provider "${model.provider}"`)
                    : undefined);
            const providerHeaders = resolveHeadersOrThrow(providerConfig?.headers, `provider "${model.provider}"`);
            const modelHeaders = resolveHeadersOrThrow(this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id)), `model "${model.provider}/${model.id}"`);
            let headers = model.headers || providerHeaders || modelHeaders
                ? { ...model.headers, ...providerHeaders, ...modelHeaders }
                : undefined;
            if (providerConfig?.authHeader) {
                if (!apiKey) {
                    return { ok: false, error: `No API key found for "${model.provider}"` };
                }
                headers = { ...headers, Authorization: `Bearer ${apiKey}` };
            }
            return {
                ok: true,
                apiKey,
                headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
            };
        }
        catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    /**
     * Get API key for a provider.
     */
    async getApiKeyForProvider(provider) {
        const apiKey = await this.authStorage.getApiKey(provider, { includeFallback: false });
        if (apiKey !== undefined) {
            return apiKey;
        }
        const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
        return providerApiKey ? resolveConfigValueUncached(providerApiKey) : undefined;
    }
    /**
     * Check if a model is using OAuth credentials (subscription).
     */
    isUsingOAuth(model) {
        const cred = this.authStorage.get(model.provider);
        return cred?.type === "oauth";
    }
    /**
     * Register a provider dynamically (from extensions).
     *
     * If provider has models: replaces all existing models for this provider.
     * If provider has only baseUrl/headers: overrides existing models' URLs.
     * If provider has oauth: registers OAuth provider for /login support.
     */
    registerProvider(providerName, config) {
        this.validateProviderConfig(providerName, config);
        this.applyProviderConfig(providerName, config);
        this.registeredProviders.set(providerName, config);
    }
    /**
     * Unregister a previously registered provider.
     *
     * Removes the provider from the registry and reloads models from disk so that
     * built-in models overridden by this provider are restored to their original state.
     * Also resets dynamic OAuth and API stream registrations before reapplying
     * remaining dynamic providers.
     * Has no effect if the provider was never registered.
     */
    unregisterProvider(providerName) {
        if (!this.registeredProviders.has(providerName))
            return;
        this.registeredProviders.delete(providerName);
        this.refresh();
    }
    validateProviderConfig(providerName, config) {
        if (config.streamSimple && !config.api) {
            throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
        }
        if (!config.models || config.models.length === 0) {
            return;
        }
        if (!config.baseUrl) {
            throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
        }
        if (!config.apiKey && !config.oauth) {
            throw new Error(`Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`);
        }
        for (const modelDef of config.models) {
            const api = modelDef.api || config.api;
            if (!api) {
                throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
            }
        }
    }
    applyProviderConfig(providerName, config) {
        // Register OAuth provider if provided
        if (config.oauth) {
            // Ensure the OAuth provider ID matches the provider name
            const oauthProvider = {
                ...config.oauth,
                id: providerName,
            };
            registerOAuthProvider(oauthProvider);
        }
        if (config.streamSimple) {
            const streamSimple = config.streamSimple;
            registerApiProvider({
                api: config.api,
                stream: (model, context, options) => streamSimple(model, context, options),
                streamSimple,
            }, `provider:${providerName}`);
        }
        this.storeProviderRequestConfig(providerName, config);
        if (config.models && config.models.length > 0) {
            // Full replacement: remove existing models for this provider
            this.models = this.models.filter((m) => m.provider !== providerName);
            // Parse and add new models
            for (const modelDef of config.models) {
                const api = modelDef.api || config.api;
                this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);
                this.models.push({
                    id: modelDef.id,
                    name: modelDef.name,
                    api: api,
                    provider: providerName,
                    baseUrl: config.baseUrl,
                    reasoning: modelDef.reasoning,
                    input: modelDef.input,
                    cost: modelDef.cost,
                    contextWindow: modelDef.contextWindow,
                    maxTokens: modelDef.maxTokens,
                    headers: undefined,
                    compat: modelDef.compat,
                });
            }
            // Apply OAuth modifyModels if credentials exist (e.g., to update baseUrl)
            if (config.oauth?.modifyModels) {
                const cred = this.authStorage.get(providerName);
                if (cred?.type === "oauth") {
                    this.models = config.oauth.modifyModels(this.models, cred);
                }
            }
        }
        else if (config.baseUrl || config.headers) {
            // Override-only: update baseUrl for existing models. Request headers are resolved per request.
            this.models = this.models.map((m) => {
                if (m.provider !== providerName)
                    return m;
                return {
                    ...m,
                    baseUrl: config.baseUrl ?? m.baseUrl,
                };
            });
        }
    }
}
//# sourceMappingURL=model-registry.js.map