import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { type TruncationResult } from "./truncate.js";
declare const findSchema: import("@sinclair/typebox").TObject<{
    pattern: import("@sinclair/typebox").TString;
    path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
}>;
export type FindToolInput = Static<typeof findSchema>;
export interface FindToolDetails {
    truncation?: TruncationResult;
    resultLimitReached?: number;
}
/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface FindOperations {
    /** Check if path exists */
    exists: (absolutePath: string) => Promise<boolean> | boolean;
    /** Find files matching glob pattern. Returns relative or absolute paths. */
    glob: (pattern: string, cwd: string, options: {
        ignore: string[];
        limit: number;
    }) => Promise<string[]> | string[];
}
export interface FindToolOptions {
    /** Custom operations for find. Default: local filesystem plus fd */
    operations?: FindOperations;
}
export declare function createFindToolDefinition(cwd: string, options?: FindToolOptions): ToolDefinition<typeof findSchema, FindToolDetails | undefined>;
export declare function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema>;
/** Default find tool using process.cwd() for backwards compatibility. */
export declare const findToolDefinition: ToolDefinition<import("@sinclair/typebox").TObject<{
    pattern: import("@sinclair/typebox").TString;
    path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
}>, FindToolDetails | undefined, any>;
export declare const findTool: AgentTool<import("@sinclair/typebox").TObject<{
    pattern: import("@sinclair/typebox").TString;
    path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
}>, any>;
export {};
//# sourceMappingURL=find.d.ts.map