/**
 * Tool metadata (`annotations`, `namespace`) for the three tools this extension
 * registers.
 *
 * pi reports these to the model-facing listings and to other extensions, and the
 * documented permission pattern reads `annotations` to decide which calls to
 * confirm. The hints are author-declared and unverified, so these tests pin the
 * deliberate under-claims rather than any behaviour: a change that marks a tool
 * read-only when it reaches the network or writes to the knowledge store would
 * silence a confirmation a user should have been asked for.
 */
import { describe, it, expect } from 'vitest';
import {
  HEALTH_TOOL_ANNOTATIONS,
  KNOWLEDGE_SEARCH_TOOL_ANNOTATIONS,
  PI_RESEARCH_TOOL_NAMESPACE,
  RESEARCH_TOOL_ANNOTATIONS,
} from '../../../src/tools/tool-metadata.ts';
import { createHealthTool } from '../../../src/tools/health-tool-definition.ts';
import { createResearchTool } from '../../../src/tools/research-tool-definition.ts';
import { createResearchKnowledgeSearchTool } from '../../../src/tools/research-knowledge-search.ts';

const ALL = {
  research: RESEARCH_TOOL_ANNOTATIONS,
  health: HEALTH_TOOL_ANNOTATIONS,
  research_knowledge_search: KNOWLEDGE_SEARCH_TOOL_ANNOTATIONS,
} as const;

describe('tool metadata', () => {
  it('puts all three tools in one namespace so codemode lists them together', () => {
    expect(PI_RESEARCH_TOOL_NAMESPACE.name).toBe('pi-research');
    expect(PI_RESEARCH_TOOL_NAMESPACE.description).toBeTruthy();
    expect(PI_RESEARCH_TOOL_NAMESPACE.instructions).toBeTruthy();

    // Same object, not three copies: a later edit cannot update one tool only.
    for (const tool of [createResearchTool('pi'), createHealthTool(), createResearchKnowledgeSearchTool('pi')]) {
      expect(tool.namespace).toBe(PI_RESEARCH_TOOL_NAMESPACE);
    }
  });

  it('every registered tool carries its annotations', () => {
    expect(createResearchTool('pi').annotations).toBe(RESEARCH_TOOL_ANNOTATIONS);
    expect(createHealthTool().annotations).toBe(HEALTH_TOOL_ANNOTATIONS);
    expect(createResearchKnowledgeSearchTool('pi').annotations).toBe(KNOWLEDGE_SEARCH_TOOL_ANNOTATIONS);
  });

  it('never claims read-only, because every tool can change something', () => {
    // research and research_knowledge_search write to the knowledge store and the
    // session; health with probe:true starts the browser pool and loads models.
    // readOnlyHint is the one hint that can SUPPRESS a confirmation, so it stays
    // false unless a future tool provably cannot change anything.
    for (const [name, a] of Object.entries(ALL)) {
      expect(a.readOnlyHint, name).toBe(false);
    }
  });

  it('marks the network-reaching tools open-world and the local one closed-world', () => {
    expect(RESEARCH_TOOL_ANNOTATIONS.openWorldHint).toBe(true);
    expect(KNOWLEDGE_SEARCH_TOOL_ANNOTATIONS.openWorldHint).toBe(true);
    expect(HEALTH_TOOL_ANNOTATIONS.openWorldHint).toBe(false);
  });

  it('claims destructive only where a call can delete or overwrite', () => {
    // None of the three deletes anything: research and knowledge search append,
    // health only reads. destructiveHint stays false unless that changes.
    for (const [name, a] of Object.entries(ALL)) {
      expect(a.destructiveHint, name).toBe(false);
    }
  });

  it('marks health idempotent and the research tools not', () => {
    expect(HEALTH_TOOL_ANNOTATIONS.idempotentHint).toBe(true);
    expect(RESEARCH_TOOL_ANNOTATIONS.idempotentHint).toBe(false);
    expect(KNOWLEDGE_SEARCH_TOOL_ANNOTATIONS.idempotentHint).toBe(false);
  });
});
