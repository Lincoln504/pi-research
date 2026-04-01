import type { SimpleStreamOptions, StreamFunction, StreamOptions } from "../types.js";
/**
 * Provider-specific options for the Mistral API.
 */
export interface MistralOptions extends StreamOptions {
    toolChoice?: "auto" | "none" | "any" | "required" | {
        type: "function";
        function: {
            name: string;
        };
    };
    promptMode?: "reasoning";
}
/**
 * Stream responses from Mistral using `chat.stream`.
 */
export declare const streamMistral: StreamFunction<"mistral-conversations", MistralOptions>;
/**
 * Maps provider-agnostic `SimpleStreamOptions` to Mistral options.
 */
export declare const streamSimpleMistral: StreamFunction<"mistral-conversations", SimpleStreamOptions>;
//# sourceMappingURL=mistral.d.ts.map