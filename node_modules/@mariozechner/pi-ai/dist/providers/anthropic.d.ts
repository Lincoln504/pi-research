import Anthropic from "@anthropic-ai/sdk";
import type { SimpleStreamOptions, StreamFunction, StreamOptions } from "../types.js";
export type AnthropicEffort = "low" | "medium" | "high" | "max";
export interface AnthropicOptions extends StreamOptions {
    /**
     * Enable extended thinking.
     * For Opus 4.6 and Sonnet 4.6: uses adaptive thinking (model decides when/how much to think).
     * For older models: uses budget-based thinking with thinkingBudgetTokens.
     */
    thinkingEnabled?: boolean;
    /**
     * Token budget for extended thinking (older models only).
     * Ignored for Opus 4.6 and Sonnet 4.6, which use adaptive thinking.
     */
    thinkingBudgetTokens?: number;
    /**
     * Effort level for adaptive thinking (Opus 4.6 and Sonnet 4.6).
     * Controls how much thinking Claude allocates:
     * - "max": Always thinks with no constraints (Opus 4.6 only)
     * - "high": Always thinks, deep reasoning (default)
     * - "medium": Moderate thinking, may skip for simple queries
     * - "low": Minimal thinking, skips for simple tasks
     * Ignored for older models.
     */
    effort?: AnthropicEffort;
    interleavedThinking?: boolean;
    toolChoice?: "auto" | "any" | "none" | {
        type: "tool";
        name: string;
    };
    /**
     * Pre-built Anthropic client instance. When provided, skips internal client
     * construction entirely. Use this to inject alternative SDK clients such as
     * `AnthropicVertex` that shares the same messaging API.
     */
    client?: Anthropic;
}
export declare const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions>;
export declare const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions>;
//# sourceMappingURL=anthropic.d.ts.map