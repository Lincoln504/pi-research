/**
 * ExtensionToolContext adapter for direct ToolDefinition.execute() calls.
 *
 * pi 0.99 widened the context `ToolDefinition.execute()` receives from
 * `ExtensionContext` to `ExtensionToolContext`, which adds two members for
 * nested tool calls: `tools` (the callable tool list) and `executeTool()`
 * (how the codemode tool and other orchestrators run another tool).
 *
 * pi-research never orchestrates other tools from inside a tool: its tools use
 * `ctx` for cwd, `hasUI`, `ui`, `signal`, the model registry and the session
 * manager, and none of them reads `tools` or calls `executeTool()`. The call
 * sites that invoke our own tools directly — the `/research` and
 * `/knowledge-store` command handlers and the SDK's `searchKnowledge` — hold an
 * `ExtensionContext` (or the SDK's synthetic one), which the host has not given
 * the two extra members because it is not a nested call.
 *
 * One documented cast beats inventing a fake `executeTool()` that could one day
 * be called and silently do nothing. If a tool ever starts using `ctx.tools` or
 * `ctx.executeTool()`, this helper is where the missing plumbing will surface,
 * and direct invocation of that tool must move to `pi`'s nested-call path
 * (`ctx.executeTool()`) instead.
 */

import type { ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';

/** View an `ExtensionContext` as the `ExtensionToolContext` a tool call expects. */
export function asToolExecContext(ctx: ExtensionContext): ExtensionToolContext {
  return ctx as ExtensionToolContext;
}
