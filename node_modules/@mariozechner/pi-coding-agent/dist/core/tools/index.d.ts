export { type BashOperations, type BashSpawnContext, type BashSpawnHook, type BashToolDetails, type BashToolInput, type BashToolOptions, bashTool, bashToolDefinition, createBashTool, createBashToolDefinition, createLocalBashOperations, } from "./bash.js";
export { createEditTool, createEditToolDefinition, type EditOperations, type EditToolDetails, type EditToolInput, type EditToolOptions, editTool, editToolDefinition, } from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export { createFindTool, createFindToolDefinition, type FindOperations, type FindToolDetails, type FindToolInput, type FindToolOptions, findTool, findToolDefinition, } from "./find.js";
export { createGrepTool, createGrepToolDefinition, type GrepOperations, type GrepToolDetails, type GrepToolInput, type GrepToolOptions, grepTool, grepToolDefinition, } from "./grep.js";
export { createLsTool, createLsToolDefinition, type LsOperations, type LsToolDetails, type LsToolInput, type LsToolOptions, lsTool, lsToolDefinition, } from "./ls.js";
export { createReadTool, createReadToolDefinition, type ReadOperations, type ReadToolDetails, type ReadToolInput, type ReadToolOptions, readTool, readToolDefinition, } from "./read.js";
export { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationOptions, type TruncationResult, truncateHead, truncateLine, truncateTail, } from "./truncate.js";
export { createWriteTool, createWriteToolDefinition, type WriteOperations, type WriteToolInput, type WriteToolOptions, writeTool, writeToolDefinition, } from "./write.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import { type BashToolOptions } from "./bash.js";
import { type ReadToolOptions } from "./read.js";
export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export declare const codingTools: Tool[];
export declare const readOnlyTools: Tool[];
export declare const allTools: {
    read: AgentTool<import("@sinclair/typebox").TObject<{
        path: import("@sinclair/typebox").TString;
        offset: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    }>, any>;
    bash: AgentTool<import("@sinclair/typebox").TObject<{
        command: import("@sinclair/typebox").TString;
        timeout: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    }>, any>;
    edit: AgentTool<import("@sinclair/typebox").TObject<{
        path: import("@sinclair/typebox").TString;
        edits: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            oldText: import("@sinclair/typebox").TString;
            newText: import("@sinclair/typebox").TString;
        }>>;
    }>, any>;
    write: AgentTool<import("@sinclair/typebox").TObject<{
        path: import("@sinclair/typebox").TString;
        content: import("@sinclair/typebox").TString;
    }>, any>;
    grep: AgentTool<import("@sinclair/typebox").TObject<{
        pattern: import("@sinclair/typebox").TString;
        path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        glob: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        ignoreCase: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        literal: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        context: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    }>, any>;
    find: AgentTool<import("@sinclair/typebox").TObject<{
        pattern: import("@sinclair/typebox").TString;
        path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    }>, any>;
    ls: AgentTool<import("@sinclair/typebox").TObject<{
        path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    }>, any>;
};
export declare const allToolDefinitions: {
    read: ToolDefinition<import("@sinclair/typebox").TObject<{
        path: import("@sinclair/typebox").TString;
        offset: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    }>, import("./read.js").ReadToolDetails | undefined, any>;
    bash: ToolDefinition<import("@sinclair/typebox").TObject<{
        command: import("@sinclair/typebox").TString;
        timeout: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    }>, import("./bash.js").BashToolDetails | undefined, {
        startedAt: number | undefined;
        endedAt: number | undefined;
        interval: NodeJS.Timeout | undefined;
    }>;
    edit: ToolDefinition<import("@sinclair/typebox").TObject<{
        path: import("@sinclair/typebox").TString;
        edits: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            oldText: import("@sinclair/typebox").TString;
            newText: import("@sinclair/typebox").TString;
        }>>;
    }>, import("./edit.js").EditToolDetails | undefined, {
        [x: string]: never;
    }>;
    write: ToolDefinition<import("@sinclair/typebox").TObject<{
        path: import("@sinclair/typebox").TString;
        content: import("@sinclair/typebox").TString;
    }>, undefined, any>;
    grep: ToolDefinition<import("@sinclair/typebox").TObject<{
        pattern: import("@sinclair/typebox").TString;
        path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        glob: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        ignoreCase: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        literal: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        context: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    }>, import("./grep.js").GrepToolDetails | undefined, any>;
    find: ToolDefinition<import("@sinclair/typebox").TObject<{
        pattern: import("@sinclair/typebox").TString;
        path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    }>, import("./find.js").FindToolDetails | undefined, any>;
    ls: ToolDefinition<import("@sinclair/typebox").TObject<{
        path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    }>, import("./ls.js").LsToolDetails | undefined, any>;
};
export type ToolName = keyof typeof allTools;
export interface ToolsOptions {
    read?: ReadToolOptions;
    bash?: BashToolOptions;
}
export declare function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[];
export declare function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[];
export declare function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef>;
export declare function createCodingTools(cwd: string, options?: ToolsOptions): Tool[];
export declare function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[];
export declare function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool>;
//# sourceMappingURL=index.d.ts.map