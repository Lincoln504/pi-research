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
  INITIAL_RESEARCHERS_LEVEL_4,
  MAX_ROUNDS_LEVEL_1,
  MAX_ROUNDS_LEVEL_2,
  MAX_ROUNDS_LEVEL_3,
  MAX_ROUNDS_LEVEL_4,
  MAX_CONCURRENT_RESEARCHERS,
  MAX_REPORT_LENGTH,
  DEFAULT_MODEL_CONTEXT_WINDOW,
} from '../constants.ts';
import { createResearcherSession } from './researcher.ts';
import { injectCurrentDate } from '../utils/inject-date.ts';
import { formatParentContext } from './session-context.ts';
import { formatSharedLinksFromState } from '../utils/shared-links.ts';
import { logger } from '../logger.ts';
import { ensureAssistantResponse } from '../utils/text-utils.ts';
import { addSlice, activateSlice, completeSlice, removeSlice, flashSlice, updateSliceTokens, type ResearchPanelState } from '../tui/research-panel.ts';
import { getDisplayNumber, getResearcherRoleContext } from './id-utils.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface DeepResearchOrchestratorOptions {
  ctx: ExtensionContext;
  model: Model<any>;
  query: string;
  complexity: 1 | 2 | 3 | 4;
  onTokens: (n: number) => void;
  onUpdate: () => void;
  searxngUrl: string;
  panelState: ResearchPanelState;
}

export class DeepResearchOrchestrator {
  private stateManager: DeepResearchStateManager;
  private state: SystemResearchState;
  private activeSessions = new Map<string, AgentSession>();
  private resolveCompletion: (result: string) => void = () => {};
  private rejectCompletion: (err: any) => void = () => {};
  private completionResolved = false; // Track if we've already resolved to prevent duplicate resolutions

  /** Per-sibling current context occupation (overwritten on every message_end). */
  private siblingTokens = new Map<string, number>();
  /** Tracks progress units already credited per sibling/evaluator to ensure full budget is met. */
  private progressCredits = new Map<string, number>();
  /** Resolved context window size for the selected model. */
  private contextWindowSize: number;

  private static readonly UNITS_PER_RESEARCHER = 10;
  private static readonly LEAD_EVAL_UNITS = 5;

  constructor(private options: DeepResearchOrchestratorOptions) {
    this.stateManager = new DeepResearchStateManager(options.ctx);
    this.state = this.stateManager.initialize(options.query, options.complexity);
    this.contextWindowSize = (options.model as any)?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  }

  private resolveResult(result: string) {
    // Prevent duplicate resolutions
    if (this.completionResolved) {
      logger.warn('[deep-research] Attempting to resolve already completed research, ignoring');
      return;
    }
    this.completionResolved = true;
    
    if (this.options.panelState.progress) {
      // Snap progress to 100% to ensure clean completion
      this.options.panelState.progress.made = this.options.panelState.progress.expected;
      this.options.onUpdate();
    }
    const final = result.length > MAX_REPORT_LENGTH
      ? result.slice(0, MAX_REPORT_LENGTH) + '\n\n... (final report truncated for length) ...'
      : result;
    logger.log('[deep-research] Research resolved with result of length:', final.length);
    this.resolveCompletion(final);
  }

  async run(signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = (err: any) => {
        if (this.completionResolved) {
          logger.warn('[deep-research] Attempting to reject already completed research, ignoring');
          return;
        }
        this.completionResolved = true;
        reject(err);
      };
      if (signal?.aborted) return reject(new Error('Research aborted'));
      signal?.addEventListener('abort', () => reject(new Error('Research aborted')));
      this.kickoff(signal).catch(reject);
    });
  }

  private updateState(event: Parameters<typeof deepResearchReducer>[1]) {
    this.state = deepResearchReducer(this.state, event);
    this.stateManager.save(this.state);
  }

  private calculateUsageCost(usage: any): number {
    if (!usage || !this.options.model?.cost) return 0;
    const modelCost = this.options.model.cost;
    const inputCost = (modelCost.input / 1_000_000) * (usage.input || 0);
    const outputCost = (modelCost.output / 1_000_000) * (usage.output || 0);
    const cacheReadCost = (modelCost.cacheRead / 1_000_000) * (usage.cacheRead || 0);
    const cacheWriteCost = (modelCost.cacheWrite / 1_000_000) * (usage.cacheWrite || 0);
    return inputCost + outputCost + cacheReadCost + cacheWriteCost;
  }

  private async kickoff(signal?: AbortSignal) {
    logger.log(`[deep-research] Kickoff: status=${this.state.status}`);
    if (this.state.status === 'planning') await this.doPlanning(signal);
    if (this.state.status === 'researching') await this.startRound(signal);
    if (this.state.status === 'completed') {
      logger.log('[deep-research] Already in completed state, resolving with synthesis');
      this.resolveResult(this.state.finalSynthesis || '');
    }
  }

  private getInitialSiblingCount(complexity: 1 | 2 | 3 | 4): number {
    switch(complexity) {
      case 1: return INITIAL_RESEARCHERS_LEVEL_1;
      case 2: return INITIAL_RESEARCHERS_LEVEL_2;
      case 3: return INITIAL_RESEARCHERS_LEVEL_3;
      case 4: return INITIAL_RESEARCHERS_LEVEL_4;
    }
  }

  private getMaxRounds(complexity: 1 | 2 | 3 | 4): number {
    switch(complexity) {
      case 1: return MAX_ROUNDS_LEVEL_1;
      case 2: return MAX_ROUNDS_LEVEL_2;
      case 3: return MAX_ROUNDS_LEVEL_3;
      case 4: return MAX_ROUNDS_LEVEL_4;
    }
  }

  private async doPlanning(signal?: AbortSignal) {
    this.options.panelState.statusMessage = 'planning...';
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

      const usage = response.usage;
      if (usage) {
        const tokens = usage.totalTokens || (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
        if (tokens > 0) {
          this.options.onTokens(tokens);
          this.options.onUpdate();
        }
      }

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
        agenda = [this.state.rootQuery];
      }

      const initialCount = this.getInitialSiblingCount(this.state.complexity);
      logger.log(`[deep-research] Planning complete: ${agenda.length} agenda items. Initial count: ${initialCount}`);

      this.updateState({
        type: 'PLANNING_COMPLETE',
        agenda,
        initialCount
      });

      // Initialise progress budget — start with only round 1 + one lead-eval; expand dynamically
      // when the lead evaluator spawns additional rounds in promoteToLead.
      const round1Count = Math.min(initialCount, agenda.length);
      const initialExpected = round1Count * DeepResearchOrchestrator.UNITS_PER_RESEARCHER
        + DeepResearchOrchestrator.LEAD_EVAL_UNITS;

      this.options.panelState.progress = { expected: initialExpected, made: 0, extended: false };
      this.options.onUpdate();

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('[deep-research] Planning failed:', err);
      this.rejectCompletion(new Error(`Research planning failed: ${errorMsg}`));
    } finally {
      this.options.panelState.statusMessage = undefined;
      this.options.onUpdate();
    }
  }

  private async startRound(signal?: AbortSignal) {
    const currentRound = this.state.currentRound;
    const roundAspects = Object.values(this.state.aspects).filter(a => a.id.startsWith(`${currentRound}.`));
    const runningAspects = roundAspects.filter(a => a.status === 'running');
    const pendingAspects = roundAspects.filter(a => a.status === 'pending');

    if (pendingAspects.length > 0) {
      // TUI Optimization: If we are starting a fresh round (generation 1),
      // remove slices from previous rounds to prevent horizontal crowding.
      const isFirstGenOfRound = roundAspects.length === pendingAspects.length;
      if (isFirstGenOfRound && currentRound > 1) {
        const prevRoundPrefix = `${currentRound - 1}.`;
        const prevCoordId = `coord.${currentRound - 1}`;
        const toRemove = Array.from(this.options.panelState.slices.keys())
          .filter(id => id.startsWith(prevRoundPrefix) || id === prevCoordId);
        for (const id of toRemove) {
          removeSlice(this.options.panelState, id);
        }
        this.options.onUpdate();
      }

      const allowedToLaunch = Math.max(0, MAX_CONCURRENT_RESEARCHERS - runningAspects.length);
      
      if (allowedToLaunch > 0) {
        const toLaunch = pendingAspects.slice(0, allowedToLaunch);
        logger.log(`[deep-research] Round ${currentRound}: Launching ${toLaunch.length} siblings (Concurrency limit: ${MAX_CONCURRENT_RESEARCHERS}).`);

        for (let i = 0; i < toLaunch.length; i++) {
          if (i > 0) await new Promise(resolve => setTimeout(resolve, 1500));
          if (signal?.aborted) break;
          this.executeSibling(toLaunch[i]!, signal);
        }
      }
      return;
    }

    if (runningAspects.length > 0) {
      return;
    }

    if (roundAspects.length > 0 && isRoundComplete(this.state, currentRound)) {
      if (!this.state.promotedId && !this.state.finalSynthesis) {
        const allCompletedWithReports = roundAspects.filter(a => a.status === 'completed' && a.report);
        if (allCompletedWithReports.length === 0) {
          const allFailed = roundAspects.filter(a => a.status === 'failed');
          const errors = allFailed.map(a => `• Researcher ${getDisplayNumber(this.state, a.id)}: ${a.error}`).join('\n');
          this.rejectCompletion(new Error(`Research failed. All researchers encountered errors:\n\n${errors}`));
          return;
        }
        this.runCoordinatorEval(signal);
        return;
      } else if (this.state.promotedId) {
        return;
      }
    }

    if (this.state.status !== 'completed') {
      if (this.state.finalSynthesis) {
        this.resolveResult(this.state.finalSynthesis);
      } else {
        this.state.status = 'completed';
        this.stateManager.save(this.state);
        this.resolveResult('Research ended.');
      }
    }
  }

  private async executeSibling(aspect: ResearchSibling, signal?: AbortSignal) {
    this.updateState({ type: 'SIBLING_STARTED', id: aspect.id });

    const displayNum = getDisplayNumber(this.state, aspect.id);
    const roleContext = getResearcherRoleContext(this.state, aspect.id);

    addSlice(this.options.panelState, aspect.id, displayNum, false);
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

    const initialPromptEstimate = Math.ceil(researcherPrompt.length / 4);
    this.siblingTokens.set(aspect.id, initialPromptEstimate);
    const getTokensUsed = () => this.siblingTokens.get(aspect.id) ?? 0;

    updateSliceTokens(this.options.panelState, aspect.id, initialPromptEstimate, 0);
    this.options.onUpdate();

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
          this.updateState({ type: 'LINKS_SCRAPED', links });
        },
        getTokensUsed,
        contextWindowSize: this.contextWindowSize,
      });

      this.activeSessions.set(aspect.id, session);

      const subscription = session.subscribe((event: ExtendedAgentSessionEvent) => {
        if (event.type === 'message_end') {
          const usage = event.message?.usage;
          if (usage) {
            const cost = this.calculateUsageCost(usage);
            const tokens = usage.totalTokens || (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);

            if (tokens > 0) {
              if (event.message?.role === 'assistant') {
                this.siblingTokens.set(aspect.id, tokens);
                this.options.onTokens(tokens);
                updateSliceTokens(this.options.panelState, aspect.id, tokens, cost);
                this.updateState({ type: 'SIBLING_TOKENS', id: aspect.id, tokens, cost });
                this.options.onUpdate();
              }
            }
          }
        } else if (event.type === 'tool_execution_end') {
          const isError = event.isError ?? false;
          const color = isError ? 'red' : 'green';
          const duration = isError ? 1000 : 500;
          flashSlice(this.options.panelState, aspect.id, color, duration, this.options.onUpdate);

          if (this.options.panelState.progress) {
            const current = this.progressCredits.get(aspect.id) ?? 0;
            if (current < 8) {
              const newVal = current + 1;
              this.progressCredits.set(aspect.id, newVal);
              this.options.panelState.progress.made += 1;
              this.options.onUpdate();
            }
          }
        }
      });

      await session.prompt(aspect.query);

      if (signal?.aborted) {
        if (typeof subscription === 'function') subscription();
        return;
      }

      const report = ensureAssistantResponse(session, aspect.id);
      if (typeof subscription === 'function') subscription();

      this.updateState({ type: 'SIBLING_COMPLETED', id: aspect.id, report });

      const currentRound = this.state.currentRound;
      const isLastStanding = isRoundComplete(this.state, currentRound);

      completeSlice(this.options.panelState, aspect.id);

      if (this.options.panelState.progress) {
        const alreadyCredited = this.progressCredits.get(aspect.id) ?? 0;
        const topUp = DeepResearchOrchestrator.UNITS_PER_RESEARCHER - alreadyCredited;
        if (topUp > 0) {
          this.options.panelState.progress.made += topUp;
          this.progressCredits.set(aspect.id, DeepResearchOrchestrator.UNITS_PER_RESEARCHER);
        }
      }
      this.options.onUpdate();

      if (isLastStanding) {
        await this.handleSiblingCompletion(aspect, signal);
      } else {
        await this.injectFindingsIntoRunningSiblings(aspect);
      }

    } catch (err) {
      if (signal?.aborted) return;
      const errorMsg = String(err);
      logger.error(`[deep-research] Sibling ${aspect.id} failed:`, err);
      this.updateState({ type: 'SIBLING_FAILED', id: aspect.id, error: errorMsg });
      flashSlice(this.options.panelState, aspect.id, 'red', 1000, this.options.onUpdate);
      completeSlice(this.options.panelState, aspect.id);

      if (this.options.panelState.progress) {
        const alreadyCredited = this.progressCredits.get(aspect.id) ?? 0;
        const topUp = DeepResearchOrchestrator.UNITS_PER_RESEARCHER - alreadyCredited;
        if (topUp > 0) {
          this.options.panelState.progress.made += topUp;
          this.progressCredits.set(aspect.id, DeepResearchOrchestrator.UNITS_PER_RESEARCHER);
        }
      }
      this.options.onUpdate();

      const currentRound = this.state.currentRound;
      if (isRoundComplete(this.state, currentRound)) {
        await this.handleSiblingCompletion(aspect, signal);
      }
    } finally {
      this.activeSessions.delete(aspect.id);
      this.startRound(signal).catch(() => {});
    }
  }

  private async injectFindingsIntoRunningSiblings(finished: ResearchSibling) {
    if (!finished.report) return;
    const currentRound = this.state.currentRound;
    const allInRound = Object.values(this.state.aspects).filter(a => a.id.startsWith(`${currentRound}.`));
    const runningSiblings = allInRound.filter(s => s.status === 'running' && s.id !== finished.id);

    for (const target of runningSiblings) {
      const targetSession = this.activeSessions.get(target.id);
      if (targetSession) {
        const finishedDisplayNum = getDisplayNumber(this.state, finished.id);
        const injectionMessage = `## UPDATE: Sibling ${finishedDisplayNum} Completed Research\n\n${finished.report}`;
        try {
          await targetSession.steer(injectionMessage);
        } catch { /* suppress */ }
      }
    }
  }

  private async handleSiblingCompletion(_finished: ResearchSibling, signal?: AbortSignal) {
    if (signal?.aborted) return;
    if (this.state.promotedId || this.state.finalSynthesis) return;

    const currentRound = this.state.currentRound;
    const roundAspects = Object.values(this.state.aspects).filter(a => a.id.startsWith(`${currentRound}.`));
    const allCompletedWithReports = roundAspects.filter(a => a.status === 'completed' && a.report);

    if (allCompletedWithReports.length === 0) {
      const allFailed = roundAspects.filter(a => a.status === 'failed');
      const errors = allFailed.map(a => `• Researcher ${getDisplayNumber(this.state, a.id)}: ${a.error}`).join('\n');
      this.rejectCompletion(new Error(`Research failed. All researchers encountered errors:\n\n${errors}`));
      return;
    }

    await this.runCoordinatorEval(signal);
  }

  private async runCoordinatorEval(signal?: AbortSignal) {
    const evaluatedRound = this.state.currentRound;
    const coordId = `coord.${evaluatedRound}`;

    // Add evaluator slice AFTER all previous round slices are complete (grey)
    // The evaluator does not count toward the 3 max concurrent researchers limit
    addSlice(this.options.panelState, coordId, 'Eval', false);
    activateSlice(this.options.panelState, coordId);
    this.options.onUpdate();

    // Track ONLY completed aspect queries to determine remaining agenda items
    // This ensures pending aspects (new round not started yet) don't falsely
    // appear as completed when filtering the initial agenda
    const completedAspectQueries = Object.values(this.state.aspects)
      .filter(a => a.status === 'completed')
      .map(a => a.query);
    const remainingAgenda = this.state.initialAgenda.filter(q => !completedAspectQueries.includes(q));
    const targetRounds = this.getMaxRounds(this.state.complexity);
    const isAtTarget = this.state.currentRound >= targetRounds;
    const isAtHardLimit = this.state.currentRound > targetRounds;

    // Provide ALL completed findings (including the lead's own) — fresh context via complete()
    // This includes ALL researchers from ALL rounds that have completed with reports
    const allCompleted = Object.values(this.state.aspects).filter(a => a.status === 'completed' && a.report);
    
    logger.log(`[deep-research] Evaluator Round ${evaluatedRound}: Analyzing ${allCompleted.length} completed researchers from all rounds`);
    
    const allReportsContext = allCompleted.length > 0
      ? `## All Research Findings:\n\n` +
        allCompleted.map(a => {
          const report = a.report || '';
          const truncated = report.length > 8000 ? report.slice(0, 8000) + '\n... (truncated) ...' : report;
          const roundNum = a.id.split('.')[0] ?? '?';
          return `### Researcher ${getDisplayNumber(this.state, a.id)} (Round ${roundNum}): ${a.query}\n${truncated}`;
        }).join('\n\n---\n\n')
      : '';

    const leadPromptRaw = readFileSync(join(__dirname, '..', '..', 'prompts', 'system-lead-evaluator.md'), 'utf-8');
    const originalAgendaStr = this.state.initialAgenda.map(q => `• ${q}`).join('\n');
    let leadPrompt = leadPromptRaw
      .replace('{ROOT_QUERY}', this.state.rootQuery)
      .replace('{ORIGINAL_AGENDA}', originalAgendaStr)
      .replace('{ROUND_NUMBER}', this.state.currentRound.toString())
      .replace('{MAX_ROUNDS}', targetRounds.toString());

    if (isAtHardLimit) {
      leadPrompt += '\n\n⚠️ **CRITICAL: ABSOLUTE MAXIMUM LIMIT REACHED.** You MUST provide a FINAL SYNTHESIS in Markdown format.';
    } else if (isAtTarget) {
      leadPrompt += '\n\n⚠️ **NOTICE: TARGET DEPTH REACHED.** You should ideally synthesize now.';
    }

    const agendaSection = remainingAgenda.length > 0
      ? `\n### Unfulfilled Agenda Items\n${remainingAgenda.map(q => `- ${q}`).join('\n')}`
      : '\n### All Agenda Items Covered\nAll initial research agenda items have been addressed.';

    const promotionPrompt = leadPrompt + '\n\n' + allReportsContext + agendaSection;

    try {
      this.updateState({ type: 'PROMOTION_STARTED', id: coordId });

      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.model);
      if (!auth.ok) throw new Error(`Failed to get API credentials: ${auth.error}`);

      const heartbeat = setInterval(() => this.options.onUpdate(), 2000);
      let response: Awaited<ReturnType<typeof complete>>;
      try {
        response = await complete(this.options.model, {
          messages: [{ role: 'user', content: [{ type: 'text', text: promotionPrompt }], timestamp: Date.now() }]
        }, { apiKey: auth.apiKey!, headers: auth.headers, signal });
      } finally {
        clearInterval(heartbeat);
      }

      const decision = response.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
      const usage = response.usage;
      if (usage) {
        const tokens = usage.totalTokens || (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
        const cost = this.calculateUsageCost(usage);
        if (tokens > 0) {
          this.options.onTokens(tokens);
          updateSliceTokens(this.options.panelState, coordId, tokens, cost);
        }
      }

      const isSynthesis = decision.trim().startsWith('#');
      let nextQueries: string[] = [];
      if (!isSynthesis) {
        try {
          const lastOpen = decision.lastIndexOf('[');
          const lastClose = decision.lastIndexOf(']');
          if (lastOpen !== -1 && lastClose !== -1 && lastClose > lastOpen) {
            const parsed = JSON.parse(decision.slice(lastOpen, lastClose + 1));
            if (Array.isArray(parsed)) {
              nextQueries = parsed;
            } else {
              logger.warn('[deep-research] Promotion JSON parsed but is not an array; treating as synthesis.');
            }
          } else {
            logger.warn('[deep-research] Promotion response contained no valid JSON array; treating as synthesis.');
          }
        } catch (err) {
          logger.warn('[deep-research] Failed to parse promotion JSON:', err);
        }
      }
      
      logger.log(`[deep-research] Evaluator decision for Round ${evaluatedRound}: ${
        isSynthesis ? 'SYNTHESIS - completing research' : `DELEGATION - spawning ${nextQueries.length} new researchers in Round ${evaluatedRound + 1}`
      }`);

      this.updateState({
        type: 'PROMOTION_DECISION',
        finalSynthesis: isSynthesis ? decision : undefined,
        nextQueries,
        maxRounds: targetRounds
      });

      // Credit the evaluator work using the round number captured BEFORE the state transition
      if (this.options.panelState.progress) {
        const evalKey = `eval.${evaluatedRound}`;
        if (!this.progressCredits.has(evalKey)) {
          this.options.panelState.progress.made += DeepResearchOrchestrator.LEAD_EVAL_UNITS;
          this.progressCredits.set(evalKey, DeepResearchOrchestrator.LEAD_EVAL_UNITS);
        }
        // Extend the progress budget if the evaluator spawned a new round
        if (!isSynthesis && nextQueries.length > 0) {
          this.options.panelState.progress.expected +=
            nextQueries.length * DeepResearchOrchestrator.UNITS_PER_RESEARCHER
            + DeepResearchOrchestrator.LEAD_EVAL_UNITS;
        }
      }

      completeSlice(this.options.panelState, coordId);
      this.options.onUpdate();

      // CRITICAL: Must trigger next step after evaluator completes
      // The evaluator does NOT run through executeSibling(), so there's no
      // finally block to call startRound(). We must call it explicitly.
      
      // Give state a moment to propagate the update
      await new Promise(resolve => setTimeout(resolve, 50));
      
      if (isSynthesis) {
        // Evaluator chose to synthesize - resolve the research
        logger.log('[deep-research] Evaluator chose SYNTHESIS - resolving research');
        if (this.state.finalSynthesis) {
          this.resolveResult(this.state.finalSynthesis);
        } else {
          // If finalSynthesis not in state yet, wait and check again
          setTimeout(() => {
            if (this.state.finalSynthesis) {
              this.resolveResult(this.state.finalSynthesis);
            } else {
              logger.error('[deep-research] Final synthesis not found in state after evaluator completed');
              this.rejectCompletion(new Error('Evaluator chose synthesis but no final synthesis in state'));
            }
          }, 100);
        }
      } else {
        // Evaluator delegated more researchers - start next round
        logger.log(`[deep-research] Evaluator chose DELEGATION - starting Round ${evaluatedRound + 1}`);
        await this.startRound(signal);
      }

    } catch (err) {
      logger.error(`[deep-research] Coordinator evaluation failed for round ${evaluatedRound}:`, err);
      this.rejectCompletion(err);
    }
  }

  private buildRoleContext(aspect: ResearchSibling, roleContext: ReturnType<typeof getResearcherRoleContext>): string {
    const { displayNumber, roundNumber, totalInRound } = roleContext;
    const siblingNumInRound = parseInt(aspect.id.split('.')[1] ?? '1');
    return `## Your Role

You are **Researcher ${displayNumber}** (${siblingNumInRound} of ${totalInRound} in Round ${roundNumber}).
- **Topic**: ${aspect.query}
- **Round**: ${roundNumber} of ${this.getMaxRounds(this.state.complexity)}
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
    let currentRoundNum = 0;

    for (const completed of allCompleted) {
      const round = parseInt(completed.id.split('.')[0] ?? '0');
      if (round !== currentRoundNum) {
        currentRoundNum = round;
        output += `\n### Round ${round}\n\n`;
      }
      const displayNum = getDisplayNumber(this.state, completed.id);
      const report = completed.report || '';
      const truncatedReport = report.length > 12000
        ? report.slice(0, 12000) + '\n\n... (report truncated for length) ...'
        : report;
        
      output += `#### Researcher ${displayNum}: ${completed.query}\n\n${truncatedReport}\n\n`;
    }

    return output;
  }
}
