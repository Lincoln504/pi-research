/**
 * Single integration point for pi-ai's stateless completion primitive.
 *
 * pi-research resolves a `Model` externally (via pi's `ModelRegistry` / models.json,
 * which includes CUSTOM providers such as `glm-coding`, `cerebras`, `zai`) and then
 * makes a stateless, one-shot completion with explicit per-call `apiKey`/`headers`,
 * outside any AgentSession. The pi-ai API that fits this today is the standalone
 * `completeSimple` from `@earendil-works/pi-ai/compat`.
 *
 * Why not the modern instance API (`createModels()` / `builtinModels()`):
 *  - `Models.completeSimple` dispatches by `model.provider` and throws
 *    `Unknown provider: <id>` for any provider not registered on that instance
 *    (`@earendil-works/pi-ai` models.ts). `builtinModels()` registers only the
 *    built-in providers, so it would reject every custom provider we use.
 *  - The standalone `completeSimple` instead dispatches custom models by
 *    `model.api` (e.g. `openai-completions`) with pi-ai's `detectCompat` fallback —
 *    the exact behavior pi RESTORED in 0.80.2 (the `streamSimpleOpenAICompletions`
 *    aliases and `detectCompat` fallback) precisely because removing it broke
 *    custom OpenAI-compatible models.
 *  - pi's own `ModelRegistry` keeps its configured `Models` private and exposes no
 *    `completeSimple`/`stream`, so there is no public modern instance that already
 *    carries the custom providers either.
 *
 * This is therefore the correct, actively-maintained API for the use case — not
 * legacy cruft. pi-ai documents that the `/compat` entrypoint will be removed "in a
 * future release with a migration guide"; when that lands, switch THIS module to the
 * new provider-factory API and every caller follows automatically.
 */
export { completeSimple } from '@earendil-works/pi-ai/compat';
