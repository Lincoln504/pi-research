/**
 * Shared metadata for the tools this extension registers.
 *
 * pi 0.99 added two MCP-shaped fields to `ToolDefinition`: `annotations` and
 * `namespace`. Neither changes how a tool runs. They are what pi reports and what
 * other extensions read:
 *
 *   - `pi.getAllTools()` reports each tool's `exposure`, `namespace` and
 *     `annotations`, and the documented permission pattern reads the annotations
 *     to decide which calls to confirm.
 *   - codemode lists the tools of one namespace under a single heading with the
 *     namespace `description`; `instructions` is returned on request by
 *     `describeNamespace(name)` and is not part of any tool listing.
 *
 * The hints come from the tool's author and are NOT verified by pi, so the rule
 * here is to under-claim. `readOnlyHint` is true only for a tool that cannot
 * change anything the user would have to undo, and `openWorldHint` is true for
 * anything that can reach the network. A permission extension that trusts these
 * hints to skip a confirmation must not be able to skip one for a call that
 * starts a browser, spends money on a provider, or writes to the knowledge store.
 *
 * MCP defaults for absent hints are "not read-only, may be destructive, may reach
 * an open world", so declaring a hint can only ever narrow what a permission
 * extension confirms — with one exception: `readOnlyHint: true` on a tool that
 * does write would silence a confirmation it should have asked for. That is the
 * claim to be most careful about.
 */

import type { ToolAnnotations, ToolNamespace } from '@earendil-works/pi-coding-agent';

/**
 * One namespace for every tool this extension registers, so codemode lists them
 * together instead of scattering three unrelated entries through its tool list.
 */
export const PI_RESEARCH_TOOL_NAMESPACE: ToolNamespace = {
  name: 'pi-research',
  description: 'Web research, knowledge-store search, and system health checks.',
  instructions:
    'research_knowledge_search is a local lookup and should be tried before research: ' +
    'a complete hit answers the question without any live work. research runs a ' +
    'multi-agent web investigation and takes minutes. health reports local service ' +
    'status and is the cheapest of the three.',
};

/**
 * `research`: reaches the open web, spawns sub-agents, spends provider tokens, and
 * appends to the knowledge store and the session report. Additive, so not
 * destructive, and every run is a new investigation, so not idempotent.
 */
export const RESEARCH_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * `research_knowledge_search`: reads the local store, and on a miss can go live
 * (network, provider tokens) and write what it learned back. Not read-only for the
 * same reason as `research`.
 */
export const KNOWLEDGE_SEARCH_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * `health`: reports local status. Not read-only because `probe: true` forces
 * liveness checks that can start the browser pool and load models, and repeating a
 * probe has no further effect, so it is idempotent. It reaches the local machine,
 * not the open web.
 */
export const HEALTH_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
