/**
 * Deep Research Orchestrator
 *
 * Manages the decentralized deep research lifecycle:
 * 1. Initial Planning (One-shot) - exhaustive agenda creation
 * 2. Parallel Sibling Execution - with mid-flight report injection
 * 3. Last-Man-Standing Promotion - the final sibling handles evaluation/synthesis
 *
 * State transitions are handled by the pure deepResearchReducer.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { ExtensionContext, AgentSession } from '@mariozechner/pi-coding-agent';
import type { ExtendedAgentSessionEvent } from '../types/extension-context.ts';
import { complete, type Model } from '@mariozechner/pi-ai';
import { DeepResearchStateManager } from './state-manager.ts';
import { deepResearchReducer, isRoundComplete } from './deep-research-reducer.ts';
import type { SystemResearchState, ResearchSibling } from './deep-research-types.ts';
import {
  INITIAL_RESEARCHERS_LEVEL_1,
  INITIAL_RESEARCHERS_LEVEL_2,
  INITIAL_RESEARCHERS_LEVEL_3,
  MAX_ROUNDS_LEVEL_1,
  MAX_ROUNDS_LEVEL_2,
  MAX_ROUNDS_LEVEL_3,
  MAX_SIBLINGS_ROUND_1,
  MAX_SIBLINGS_ROUND_2,
  MAX_SIBLINGS_ROUND_3,
  MAX_REPORT_LENGTH,
  DEFAULT_MODEL_CONTEXT_WINDOW,
} from '../constants.ts';
import { createResearcherSession } from './researcher.ts';
import { injectCurrentDate } from '../utils/inject-date.ts';
import { formatParentContext } from './session-context.ts';
import { formatSharedLinksFromState } from '../utils/shared-links.ts';
import { logger } from '../logger.ts';
import { ensureAssistantResponse } from '../utils/text-utils.ts';
import { addSlice, activateSlice, completeSlice, removeSlice, flashSlice, updateSliceTokens } from '../tui/research-panel.ts';
import { getDisplayNumber, getResearcherRoleContext } from './id-utils.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface DeepResearchOrchestratorOptions {
  ctx: ExtensionContext;
  model: Model<any>;
  query: string;
  complexity: 1 | 2 | 3;
  onTokens: (n: number) => void;
  onUpdate: () => void;
  searxngUrl: string;
  panelState: any;
}

export class DeepResearchOrchestrator {
  private stateManager: DeepResearchStateManager;
  private state: SystemResearchState;
  private activeSessions = new Map<string, AgentSession>();
  private resolveCompletion: (result: string) => void = () => {};
  private rejectCompletion: (err: any) => void = () => {};

  /** Per-sibling cumulative token counter (updated on every message_end). */
  private siblingTokens = new Map<string, number>();
  /** Tracks progress units already credited per sibling/evaluator to ensure full budget is met. */
  private progressCredits = new Map<string, number>();
  /** Resolved context window size for the selected model. */
  private contextWindowSize: number;

  constructor(private options: DeepResearchOrchestratorOptions) {
    this.stateManager = new DeepResearchStateManager(options.ctx);
    this.state = this.stateManager.initialize(options.query, options.complexity);
    this.contextWindowSize = (options.model as any)?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  }

  private resolveResult(result: string) {
    if (this.options.panelState.progress) {
      this.options.panelState.progress.made = this.options.panelState.progress.expected;
      logger.log(`[deep-research] Progress: Snapped to 100% (${this.options.panelState.progress.made}/${this.options.panelState.progress.expected})`);
      this.options.onUpdate();
    }
    const final = result.length > MAX_REPORT_LENGTH
      ? result.slice(0, MAX_REPORT_LENGTH) + '\n\n... (final report truncated for length) ...'
      : result;
    this.resolveCompletion(final);
  }

  async run(signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
      if (signal?.aborted) return reject(new Error('Research aborted'));
      signal?.addEventListener('abort', () => reject(new Error('Research aborted')));
      this.kickoff(signal).catch(reject);
    });
  }

  private updateState(event: Parameters<typeof deepResearchReducer>[1]) {
    this.state = deepResearchReducer(this.state, event);
    this.stateManager.save(this.state);
  }

  private async kickoff(signal?: AbortSignal) {
    if (this.state.status === 'planning') await this.doPlanning(signal);
    if (this.state.status === 'researching') await this.startRound(signal);
    if (this.state.status === 'completed') this.resolveResult(this.state.finalSynthesis || '');
  }

  private getInitialSiblingCount(complexity: 1 | 2 | 3): number {
    switch(complexity) {
      case 1: return INITIAL_RESEARCHERS_LEVEL_1;
      case 2: return INITIAL_RESEARCHERS_LEVEL_2;
      case 3: return INITIAL_RESEARCHERS_LEVEL_3;
    }
  }

  private getMaxRounds(complexity: 1 | 2 | 3): number {
    switch(complexity) {
      case 1: return MAX_ROUNDS_LEVEL_1;
      case 2: return MAX_ROUNDS_LEVEL_2;
      case 3: return MAX_ROUNDS_LEVEL_3;
    }
  }

  private getMaxSiblingsPerRound(complexity: 1 | 2 | 3): number {
    switch(complexity) {
      case 1: return MAX_SIBLINGS_ROUND_1;
      case 2: return MAX_SIBLINGS_ROUND_2;
      case 3: return MAX_SIBLINGS_ROUND_3;
    }
  }

  private async doPlanning(signal?: AbortSignal) {
    const sliceLabel = 'planning ...';
    addSlice(this.options.panelState, sliceLabel, sliceLabel, false);
    activateSlice(this.options.panelState, sliceLabel);
    this.options.onUpdate();

    try {
      const parentConvo = await formatParentContext(this.options.ctx);
      const coordinatorPromptRaw = readFileSync(join(__dirname, '..', '..', 'prompts', 'system-coordinator.md'), 'utf-8');
      const plannerPrompt = coordinatorPromptRaw + `\n\nHISTORY:\n${parentConvo}\n\nQUERY: ${this.state.rootQuery}`;

      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.model);
      if (!auth.ok) throw new Error(`Failed to get API credentials: ${auth.error}`);
      const response = await complete(this.options.model, {
        messages: [{ role: 'user', content: [{ type: 'text', text: plannerPrompt }], timestamp: Date.now() }]
      }, { apiKey: auth.apiKey!, headers: auth.headers, signal });

      const text = response.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
      let agenda: string[] = [];
      try {
        const match = text.match(/\[.*\]/s);
        if (match) {
           agenda = JSON.parse(match[0]);
        }
      } catch (err) {
        logger.error('[deep-research] Failed to parse planning agenda JSON:', err);
      }

      if (agenda.length === 0) {
        // Fallback: use root query as sole agenda item
        agenda = [this.state.rootQuery];
      }

      const initialCount = this.getInitialSiblingCount(this.state.complexity);

      this.updateState({
        type: 'PLANNING_COMPLETE',
        agenda,
        initialCount
      });

      // Initialise progress tracking.
      // Budget for the full potential scope of research up-front so the percentage
      // represents "how far through the total possible work" rather than just round 1.
      //   • 10 units per researcher (8 tool calls + 2-unit final-report weight)
      //   • 5 units per lead-evaluator call (one per round boundary + final synthesis)
      const UNITS_PER_RESEARCHER = 10;
      const LEAD_EVAL_UNITS = 5;
      const maxRounds = this.getMaxRounds(this.state.complexity);
      const maxSibsPerRound = this.getMaxSiblingsPerRound(this.state.complexity);

      // BUDGET FIX: Round 1 might have fewer researchers launched than the complexity's initialCount
      // if the agenda is small. Budget for what we actually launch.
      const round1Count = Math.min(initialCount, agenda.length);
      let fullScopeExpected = round1Count * UNITS_PER_RESEARCHER; // Round 1
      for (let r = 2; r <= maxRounds; r++) {
        fullScopeExpected += LEAD_EVAL_UNITS + maxSibsPerRound * UNITS_PER_RESEARCHER;
      }
      fullScopeExpected += LEAD_EVAL_UNITS; // Final synthesis call

      this.options.panelState.progress = {
        expected: fullScopeExpected,
        made: 0,
        extended: false,
      };
      logger.log(`[deep-research] Progress initialised: expected=${fullScopeExpected}, initialCount=${initialCount}, round1Count=${round1Count}, complexity=${this.state.complexity}`);
    } finally {
      removeSlice(this.options.panelState, sliceLabel);
      this.options.onUpdate();
    }
  }

  private async startRound(signal?: AbortSignal) {
    const currentRound = this.state.currentRound;
    const roundAspects = Object.values(this.state.aspects).filter(a => a.id.startsWith(`${currentRound}.`));
    const pendingAspects = roundAspects.filter(a => a.status === 'pending');

    if (pendingAspects.length > 0) {
      logger.log(`[deep-research] Round ${currentRound}: Launching ${pendingAspects.length} siblings.`);

      // Stagger launches to avoid simultaneous provider rate limits and tool resource contention
      for (let i = 0; i < pendingAspects.length; i++) {
        if (i > 0) await new Promise(resolve => setTimeout(resolve, 2000));
        if (signal?.aborted) break;
        this.executeSibling(pendingAspects[i]!, signal);
      }
      return;
    }

    // Perfection/Resumption: If no pending aspects but round isn't empty, check if it's complete
    if (roundAspects.length > 0 && isRoundComplete(this.state, currentRound)) {
       if (!this.state.promotedId && !this.state.finalSynthesis) {
          // ROBUSTNESS: Check if we have ANY findings at all before promoting
          const allCompletedWithReports = Object.values(this.state.aspects).filter(a => a.status === 'completed' && a.report);
          if (allCompletedWithReports.length === 0) {
            const allFailed = Object.values(this.state.aspects).filter(a => a.status === 'failed');
            const errors = allFailed.map(a => `• Researcher ${getDisplayNumber(this.state, a.id)}: ${a.error}`).join('\n');
            const error = new Error(`Research failed on resumption. All researchers in round ${currentRound} encountered errors and no usable information was found:\n\n${errors}`);
            logger.error(`[deep-research] Total failure on resumption - no researchers succeeded in round ${currentRound}`);
            this.rejectCompletion(error);
            return;
          }

          logger.log(`[deep-research] Round ${currentRound} complete on kickoff, but no promotion found. Promoting first available sibling.`);
          const firstSibling = roundAspects.find(a => a.status === 'completed' || a.status === 'failed');
          if (firstSibling) {
             // We don't have an active session in a new process, so we must recreate one
             this.executeSibling(firstSibling, signal);
             return;
          }
       }
    }

    if (this.state.status !== 'completed') {
      this.state.status = 'completed';
      this.stateManager.save(this.state);
      this.resolveResult(this.state.finalSynthesis || 'Research ended.');
    }
  }

  private async executeSibling(aspect: ResearchSibling, signal?: AbortSignal) {
    this.updateState({ type: 'SIBLING_STARTED', id: aspect.id });

    const displayNum = getDisplayNumber(this.state, aspect.id);
    const roleContext = getResearcherRoleContext(this.state, aspect.id);

    // Use display number for UI, internal ID for tracking
    addSlice(this.options.panelState, aspect.id, displayNum, true);
    activateSlice(this.options.panelState, aspect.id);
    this.options.onUpdate();

    const researcherPromptRaw = readFileSync(join(__dirname, '..', '..', 'prompts', 'researcher.md'), 'utf-8');
    const sharedLinksMarkdown = formatSharedLinksFromState(this.state.aspects);
    const allFindingsMarkdown = this.buildAllFindingsContext();
    const roleContextMarkdown = this.buildRoleContext(aspect, roleContext);
    const researcherPrompt = injectCurrentDate(researcherPromptRaw, 'researcher')
      + '\n\n' + roleContextMarkdown
      + '\n\n' + allFindingsMarkdown
      + '\n\n' + sharedLinksMarkdown;

    // Initialise per-sibling token counter for context-aware scrape gating
    this.siblingTokens.set(aspect.id, 0);
    const getTokensUsed = () => this.siblingTokens.get(aspect.id) ?? 0;

    let session: AgentSession | undefined;
    try {
      session = await createResearcherSession({
        cwd: this.options.ctx.cwd,
        ctxModel: this.options.model,
        modelRegistry: this.options.ctx.modelRegistry,
        settingsManager: (this.options.ctx as any).settingsManager,
        systemPrompt: researcherPrompt,
        searxngUrl: this.options.searxngUrl,
        extensionCtx: this.options.ctx,
        getGlobalState: () => this.state,
        updateGlobalLinks: (links: string[]) => {
          logger.log(`[deep-research] Adding ${links.length} links to global pool (total: ${this.state.allScrapedLinks.length})`);
          this.updateState({ type: 'LINKS_SCRAPED', links });
          logger.log(`[deep-research] Global link pool now: ${this.state.allScrapedLinks.length}`);
        },
        getTokensUsed,
        contextWindowSize: this.contextWindowSize,
      });

      this.activeSessions.set(aspect.id, session);

      // Helper to calculate cost from usage
      const calculateUsageCost = (usage: any): number => {
        if (!usage || !this.options.model?.cost) return 0;
        const modelCost = this.options.model.cost;
        const inputCost = (modelCost.input / 1_000_000) * (usage.input || 0);
        const outputCost = (modelCost.output / 1_000_000) * (usage.output || 0);
        const cacheReadCost = (modelCost.cacheRead / 1_000_000) * (usage.cacheRead || 0);
        const cacheWriteCost = (modelCost.cacheWrite / 1_000_000) * (usage.cacheWrite || 0);
        return inputCost + outputCost + cacheReadCost + cacheWriteCost;
      };

      const subscription = session.subscribe((event: ExtendedAgentSessionEvent) => {
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          const usage = event.message?.usage;
          if (usage) {
            const cost = calculateUsageCost(usage);
            const tokens = usage.totalTokens || (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);

            if (tokens > 0) {
              // Update per-sibling token counter (drives context-aware scrape gating)
              this.siblingTokens.set(aspect.id, (this.siblingTokens.get(aspect.id) ?? 0) + tokens);

              this.options.onTokens(tokens);
              updateSliceTokens(this.options.panelState, aspect.id, tokens, cost);
              this.updateState({ type: 'SIBLING_TOKENS', id: aspect.id, tokens, cost });
              this.options.onUpdate();
            }
          }
        } else if (event.type === 'tool_execution_end') {
          const isError = event.isError ?? false;
          const color = isError ? 'red' : 'green';
          const duration = isError ? 400 : 60;
          flashSlice(this.options.panelState, aspect.id, color, duration, this.options.onUpdate);

          // Advance progress bar (up to 8 tool calls credited per researcher)
          if (this.options.panelState.progress) {
            const current = this.progressCredits.get(aspect.id) ?? 0;
            if (current < 8) {
              const newVal = (this.progressCredits.get(aspect.id) ?? 0) + 1;
              this.progressCredits.set(aspect.id, newVal);
              this.options.panelState.progress.made += 1;
              logger.log(`[deep-research] Progress: Sibling ${aspect.id} tool call credited. made=${this.options.panelState.progress.made}/${this.options.panelState.progress.expected}`);
              this.options.onUpdate();
            }
          }
        }
      });

      await session.prompt(aspect.query);

      // If the run was aborted while the session was executing, skip state updates
      // and promotion — the orchestrator's promise already rejected.
      if (signal?.aborted) {
        if (typeof subscription === 'function') subscription();
        logger.log(`[deep-research] Sibling ${aspect.id} finished after abort — skipping state update`);
        return;
      }

      const report = ensureAssistantResponse(session, aspect.id);

      // Cleanup subscription before continuing to promotion
      if (typeof subscription === 'function') {
        subscription();
      }

      this.updateState({ type: 'SIBLING_COMPLETED', id: aspect.id, report });
      completeSlice(this.options.panelState, aspect.id);
      // Top up to the full 10-unit budget for this researcher now that they've finished.
      if (this.options.panelState.progress) {
        const alreadyCredited = this.progressCredits.get(aspect.id) ?? 0;
        const topUp = 10 - alreadyCredited;
        if (topUp > 0) {
          this.options.panelState.progress.made += topUp;
          this.progressCredits.set(aspect.id, 10);
          logger.log(`[deep-research] Progress: Sibling ${aspect.id} completed (top-up ${topUp}). made=${this.options.panelState.progress.made}/${this.options.panelState.progress.expected}`);
        }
      }
      this.options.onUpdate();

      await this.handleSiblingCompletion(aspect, session, signal);
    } catch (err) {
      // If aborted, the orchestrator's promise already rejected cleanly — just log and exit.
      if (signal?.aborted) {
        logger.log(`[deep-research] Sibling ${aspect.id} caught error after abort — suppressing`);
        return;
      }
      const errorMsg = String(err);
      logger.error(`[deep-research] Sibling ${aspect.id} failed:`, err);
      this.updateState({ type: 'SIBLING_FAILED', id: aspect.id, error: errorMsg });
      flashSlice(this.options.panelState, aspect.id, 'red', 400, this.options.onUpdate);
      completeSlice(this.options.panelState, aspect.id);
      
      // Still top up to the full 10-unit budget for this researcher if they fail.
      if (this.options.panelState.progress) {
        const alreadyCredited = this.progressCredits.get(aspect.id) ?? 0;
        const topUp = 10 - alreadyCredited;
        if (topUp > 0) {
          this.options.panelState.progress.made += topUp;
          this.progressCredits.set(aspect.id, 10);
          logger.log(`[deep-research] Progress: Sibling ${aspect.id} failed (top-up ${topUp}). made=${this.options.panelState.progress.made}/${this.options.panelState.progress.expected}`);
        }
      }
      this.options.onUpdate();

      // If we have a session, we can still call handleSiblingCompletion (it won't have a report)
      // If session failed to create, we still need to call it to trigger last-man-standing logic
      await this.handleSiblingCompletion(aspect, session, signal);
    } finally {
      this.activeSessions.delete(aspect.id);
    }
  }

  private async handleSiblingCompletion(finished: ResearchSibling, _session?: AgentSession, signal?: AbortSignal) {
    // If the run was aborted, skip injection and promotion entirely.
    if (signal?.aborted) return;

    const currentRound = this.state.currentRound;
    const allInRound = Object.values(this.state.aspects).filter(a => a.id.startsWith(`${currentRound}.`));
    const runningSiblings = allInRound.filter(s => s.status === 'running' && s.id !== finished.id);

    // 1. Injection Chain: Queue sibling reports to running researchers
    // Uses steer() to interrupt current operation with new findings
    if (finished.report) {
      for (const target of runningSiblings) {
        const targetSession = this.activeSessions.get(target.id);
        if (targetSession) {
          const finishedDisplayNum = getDisplayNumber(this.state, finished.id);
          const injectionMessage = `## UPDATE: Sibling ${finishedDisplayNum} Completed Research\n\n${finished.report}`;

          try {
            logger.log(`[deep-research] Injecting report from ${finished.id} into ${target.id}`);
            // Queue message to interrupt after current tool calls complete
            await targetSession.steer(injectionMessage);
            logger.log(`[deep-research] Report successfully queued for ${target.id}`);
          } catch (err) {
            logger.error(`[deep-research] Failed to inject report into ${target.id}:`, err);
          }
        }
      }
    }

    // 2. Last-Alive Detection & Promotion
    // Check if this is the last sibling to finish (all others completed or this is the only one)
    if (isRoundComplete(this.state, currentRound)) {
      // Check if a promotion is already in progress to avoid double-evaluation
      if (this.state.promotedId) {
        logger.log(`[deep-research] Round ${currentRound} complete, but promotion already started for ${this.state.promotedId}`);
        return;
      }

      if (this.isLastAliveResearcher(finished)) {
        // ROBUSTNESS: Check if we have ANY findings at all before promoting to Lead Evaluator
        // If everyone in Round 1 failed and we have no findings, fail the task
        const allCompleted = Object.values(this.state.aspects).filter(a => a.status === 'completed' && a.report);
        if (allCompleted.length === 0) {
          const allFailed = Object.values(this.state.aspects).filter(a => a.status === 'failed');
          const errors = allFailed.map(a => `• Researcher ${getDisplayNumber(this.state, a.id)}: ${a.error}`).join('\n');
          const error = new Error(`Research failed. All researchers encountered errors and no usable information was found:\n\n${errors}`);
          logger.error('[deep-research] Total failure - no researchers succeeded across all rounds');
          this.rejectCompletion(error);
          return;
        }

        // Delay promotion slightly to ensure UI settles and researcher 'breathes' between tasks
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (signal?.aborted) return;

        logger.log(`[deep-research] ${finished.id} is last alive. Promoting to Lead Evaluator.`);
        this.updateState({ type: 'PROMOTION_STARTED', id: finished.id });
        await this.promoteToLead(finished, signal);
      }
    }
  }

  private buildRoleContext(aspect: ResearchSibling, roleContext: ReturnType<typeof getResearcherRoleContext>): string {
    const { displayNumber, roundNumber, totalInRound, isLastInRound } = roleContext;
    const siblingNumInRound = parseInt(aspect.id.split('.')[1] ?? '1');
    return `## Your Role

You are **Researcher ${displayNumber}** (${siblingNumInRound} of ${totalInRound} in Round ${roundNumber}).
- **Topic**: ${aspect.query}
- **Round**: ${roundNumber} of 3
${isLastInRound ? '\n⚠️ **You are the LAST researcher in this round.** After you report, you may be promoted to Lead Evaluator.' : ''}
- **Tool Usage**: 4 gathering calls + up to 3 context-gated scrape batches (Batch 1 ≤3 URLs, Batch 2 ≤2 URLs, Batch 3 ≤3 URLs if context < 40%)`;
  }

  private buildAllFindingsContext(): string {
    const allCompleted = Object.values(this.state.aspects)
      .filter(a => a.status === 'completed' && a.report)
      .sort((a, b) => {
        const aRound = parseInt(a.id.split('.')[0] ?? '0');
        const bRound = parseInt(b.id.split('.')[0] ?? '0');
        if (aRound !== bRound) return aRound - bRound;
        const aNum = parseInt(a.id.split('.')[1] ?? '0');
        const bNum = parseInt(b.id.split('.')[1] ?? '0');
        return aNum - bNum;
      });

    if (allCompleted.length === 0) {
      return '## Research Findings So Far\n\n*No earlier researchers have completed their findings yet.*';
    }

    let output = '## Research Findings So Far\n\n';
    let currentRound = 0;

    for (const completed of allCompleted) {
      const round = parseInt(completed.id.split('.')[0] ?? '0');
      if (round !== currentRound) {
        currentRound = round;
        output += `\n### Round ${round}\n\n`;
      }
      const displayNum = getDisplayNumber(this.state, completed.id);
      
      // Truncate extremely long reports to prevent context overflow in Lead Evaluator
      const report = completed.report || '';
      const truncatedReport = report.length > 12000
        ? report.slice(0, 12000) + '\n\n... (report truncated for length) ...'
        : report;
        
      output += `#### Researcher ${displayNum}: ${completed.query}\n\n${truncatedReport}\n\n`;
    }

    return output;
  }

  private isLastAliveResearcher(aspect: ResearchSibling): boolean {
    const currentRound = this.state.currentRound;
    const allInRound = Object.values(this.state.aspects)
      .filter(a => a.id.startsWith(`${currentRound}.`));

    // We are the last one if NO other sibling in this round is pending or running
    const othersStillWorking = allInRound.some(a => a.id !== aspect.id && (a.status === 'pending' || a.status === 'running'));
    return !othersStillWorking;
  }

  private async promoteToLead(_lead: ResearchSibling, signal?: AbortSignal) {
    const completedAspectQueries = Object.values(this.state.aspects).map(a => a.query);
    const remainingAgenda = this.state.initialAgenda.filter(q => !completedAspectQueries.includes(q));
    const targetRounds = this.getMaxRounds(this.state.complexity);
    // Allow an emergency extension round if the evaluator really insists, but cap it at target + 1.
    const hardLimit = targetRounds + 1;
    const isAtTarget = this.state.currentRound >= targetRounds;
    const isAtHardLimit = this.state.currentRound >= hardLimit;

    // Build ALL previous reports from all rounds
    const allReportsContext = this.buildAllFindingsContext();

    const leadPromptRaw = readFileSync(join(__dirname, '..', '..', 'prompts', 'system-lead-evaluator.md'), 'utf-8');
    const originalAgendaStr = this.state.initialAgenda.map(q => `• ${q}`).join('\n');
    let leadPrompt = leadPromptRaw
      .replace('{ROOT_QUERY}', this.state.rootQuery)
      .replace('{ORIGINAL_AGENDA}', originalAgendaStr)
      .replace('{ROUND_NUMBER}', this.state.currentRound.toString())
      .replace('{MAX_ROUNDS}', targetRounds.toString());

    // If it's the hard limit, strictly force synthesis
    if (isAtHardLimit) {
      leadPrompt += '\n\n⚠️ **CRITICAL: ABSOLUTE MAXIMUM LIMIT REACHED.** You MUST provide a FINAL SYNTHESIS in Markdown format. The system will NOT accept a JSON array of next queries.';
    } else if (isAtTarget) {
      leadPrompt += '\n\n⚠️ **NOTICE: TARGET DEPTH REACHED.** You should ideally synthesize now. Only delegate further if the ORIGINAL AGENDA has critical, unfulfilled gaps.';
    }

    const agendaSection = remainingAgenda.length > 0
      ? `\n### Unfulfilled Agenda Items\n${remainingAgenda.map(q => `- ${q}`).join('\n')}`
      : '\n### All Agenda Items Covered\nAll initial research agenda items have been addressed.';

    const promotionPrompt = leadPrompt + '\n\n' + allReportsContext + agendaSection;

    try {
      logger.log(`[deep-research] Promoting ${_lead.id} to Lead Evaluator for Round ${this.state.currentRound}`);
      
      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.model);
      if (!auth.ok) throw new Error(`Failed to get API credentials: ${auth.error}`);
      
      const response = await complete(this.options.model, {
        messages: [{ role: 'user', content: [{ type: 'text', text: promotionPrompt }], timestamp: Date.now() }]
      }, { apiKey: auth.apiKey!, headers: auth.headers, signal });

      const decision = response.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
      if (response.usage?.totalTokens) {
        this.options.onTokens(response.usage.totalTokens);
      }
      // Credit the lead evaluator call (5 units) against the pre-budgeted scope.
      // Use a unique key per round to ensure we don't double-credit if resumed.
      if (this.options.panelState.progress) {
        const evalKey = `eval.${this.state.currentRound}`;
        if (!this.progressCredits.has(evalKey)) {
          this.options.panelState.progress.made += 5;
          this.progressCredits.set(evalKey, 5);
          logger.log(`[deep-research] Progress: Lead Evaluator R${this.state.currentRound} credited. made=${this.options.panelState.progress.made}/${this.options.panelState.progress.expected}`);
          this.options.onUpdate();
        }
      }

      try {
        // More robust JSON extraction: find the LAST [ and ] that encapsulate an array
        const lastOpen = decision.lastIndexOf('[');
        const lastClose = decision.lastIndexOf(']');
        let nextQueries: string[] = [];
        
        if (lastOpen !== -1 && lastClose !== -1 && lastClose > lastOpen) {
           const jsonStr = decision.substring(lastOpen, lastClose + 1);
           try {
             nextQueries = JSON.parse(jsonStr);
           } catch {
             // Fallback to simpler match if complex one fails
             const simpleMatch = decision.match(/\[\s*".*"\s*\]/s);
             if (simpleMatch) nextQueries = JSON.parse(simpleMatch[0]);
           }
        }
        
        const willSynthesize = !Array.isArray(nextQueries) || nextQueries.length === 0 || isAtHardLimit;

        // BUDGET ADJUSTMENT: If we take a shortcut, credit the "unused" budget immediately.
        if (this.options.panelState.progress) {
          const maxSibs = this.getMaxSiblingsPerRound(this.state.complexity);
          if (willSynthesize) {
            // If we are synthesizing, credit ALL potential future work.
            const currentRound = this.state.currentRound;
            const remainingRounds = targetRounds - currentRound;
            // 1. Credit unused siblings of the round that WOULD have been next.
            if (currentRound < targetRounds) {
               this.options.panelState.progress.made += (maxSibs * 10);
            }
            // 2. Credit all rounds BEYOND the next one (lead eval + max sibs).
            if (remainingRounds > 1) {
              const unitsPerFutureRound = 5 + (maxSibs * 10);
              this.options.panelState.progress.made += ((remainingRounds - 1) * unitsPerFutureRound);
            }
            logger.log(`[deep-research] Progress: Synthesizing early. Adjusted made=${this.options.panelState.progress.made}/${this.options.panelState.progress.expected}`);
          } else {
            // If we are delegating, only credit the difference between max and actual siblings for the NEXT round.
            const actualSibs = nextQueries.length;
            const unusedSibs = maxSibs - actualSibs;
            if (unusedSibs > 0) {
              const credit = unusedSibs * 10;
              this.options.panelState.progress.made += credit;
              logger.log(`[deep-research] Progress: Delegating ${actualSibs}/${maxSibs} siblings. Credited ${credit} for unused. made=${this.options.panelState.progress.made}/${this.options.panelState.progress.expected}`);
            }
          }
          this.options.onUpdate();
        }

        this.updateState({
          type: 'PROMOTION_DECISION',
          nextQueries: willSynthesize ? [] : nextQueries.slice(0, this.getMaxSiblingsPerRound(this.state.complexity)),
          finalSynthesis: (willSynthesize || isAtHardLimit) ? decision : undefined,
          maxRounds: targetRounds
        });

        if (willSynthesize) {
          // CRITICAL: System must exit cleanly after synthesis
          logger.log(`[deep-research] Lead evaluator synthesizing (Round ${this.state.currentRound}/${targetRounds})`);
          
          let finalOutput = this.state.finalSynthesis || decision;
          if (isAtHardLimit && Array.isArray(nextQueries) && nextQueries.length > 0 && !finalOutput.includes('#')) {
             finalOutput = `## Research Summary (Hard Limit Reached)\n\nThe absolute research limit of ${hardLimit} rounds was reached. The agents proposed further research directions but we must synthesize now:\n\n### Proposed Next Steps (Not Executed)\n${nextQueries.map(q => `- ${q}`).join('\n')}\n\n### Current Findings\n${allReportsContext}`;
             // Save the fallback to state too
             this.updateState({ 
               type: 'PROMOTION_DECISION', 
               nextQueries: [], 
               finalSynthesis: finalOutput, 
               maxRounds: targetRounds 
             });
          }

          this.resolveResult(finalOutput);
          return;
        } else {
          // Continue to next round
          logger.log(`[deep-research] Lead evaluator delegating to Round ${this.state.currentRound + 1}`);
          if (this.state.status === 'researching') await this.startRound(signal);
          return;
        }
      } catch (err) {
        // Synthesis fallback
        logger.log(`[deep-research] Lead evaluator decision parsing failed or forced synthesis: ${err}`);
        this.updateState({ type: 'PROMOTION_DECISION', nextQueries: [], finalSynthesis: decision, maxRounds });
        this.resolveResult(decision);
        return;
      }
    } catch (err) {
      logger.error(`[deep-research] Lead evaluation failed:`, err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.rejectCompletion(new Error(`Lead evaluation failed: ${errorMsg}`));
    }
  }
}
