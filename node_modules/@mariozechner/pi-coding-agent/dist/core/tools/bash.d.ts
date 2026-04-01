import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { type TruncationResult } from "./truncate.js";
declare const bashSchema: import("@sinclair/typebox").TObject<{
    command: import("@sinclair/typebox").TString;
    timeout: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
}>;
export type BashToolInput = Static<typeof bashSchema>;
export interface BashToolDetails {
    truncation?: TruncationResult;
    fullOutputPath?: string;
}
/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
    /**
     * Execute a command and stream output.
     * @param command The command to execute
     * @param cwd Working directory
     * @param options Execution options
     * @returns Promise resolving to exit code (null if killed)
     */
    exec: (command: string, cwd: string, options: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
    }) => Promise<{
        exitCode: number | null;
    }>;
}
/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export declare function createLocalBashOperations(): BashOperations;
export interface BashSpawnContext {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
}
export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;
export interface BashToolOptions {
    /** Custom operations for command execution. Default: local shell */
    operations?: BashOperations;
    /** Command prefix prepended to every command (for example shell setup commands) */
    commandPrefix?: string;
    /** Hook to adjust command, cwd, or env before execution */
    spawnHook?: BashSpawnHook;
}
type BashRenderState = {
    startedAt: number | undefined;
    endedAt: number | undefined;
    interval: NodeJS.Timeout | undefined;
};
export declare function createBashToolDefinition(cwd: string, options?: BashToolOptions): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState>;
export declare function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema>;
/** Default bash tool using process.cwd() for backwards compatibility. */
export declare const bashToolDefinition: ToolDefinition<import("@sinclair/typebox").TObject<{
    command: import("@sinclair/typebox").TString;
    timeout: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
}>, BashToolDetails | undefined, BashRenderState>;
export declare const bashTool: AgentTool<import("@sinclair/typebox").TObject<{
    command: import("@sinclair/typebox").TString;
    timeout: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
}>, any>;
export {};
//# sourceMappingURL=bash.d.ts.map