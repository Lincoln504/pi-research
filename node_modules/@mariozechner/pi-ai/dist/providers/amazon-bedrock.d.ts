import type { SimpleStreamOptions, StreamFunction, StreamOptions, ThinkingBudgets, ThinkingLevel } from "../types.js";
export interface BedrockOptions extends StreamOptions {
    region?: string;
    profile?: string;
    toolChoice?: "auto" | "any" | "none" | {
        type: "tool";
        name: string;
    };
    reasoning?: ThinkingLevel;
    thinkingBudgets?: ThinkingBudgets;
    interleavedThinking?: boolean;
    /** Key-value pairs attached to the inference request for cost allocation tagging.
     * Keys: max 64 chars, no `aws:` prefix. Values: max 256 chars. Max 50 pairs.
     * Tags appear in AWS Cost Explorer split cost allocation data.
     * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html */
    requestMetadata?: Record<string, string>;
}
export declare const streamBedrock: StreamFunction<"bedrock-converse-stream", BedrockOptions>;
export declare const streamSimpleBedrock: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions>;
//# sourceMappingURL=amazon-bedrock.d.ts.map