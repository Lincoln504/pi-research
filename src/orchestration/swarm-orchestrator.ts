/**
 * Swarm Orchestrator
 * 
 * Manages the decentralized swarm research lifecycle:
 * 1. Initial Planning (One-shot) - exhaustive agenda creation
 * 2. Parallel Sibling Execution - with mid-flight report injection
 * 3. Last-Man-Standing Promotion - the final sibling handles evaluation/synthesis
 * 
 * State transitions are handled by the pure swarmReducer.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { ExtensionContext, AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { complete, type Model } from '@mariozechner/pi-ai';
import { SwarmStateManager } from './state-manager.ts';
import { swarmReducer, isRoundComplete } from './swarm-reducer.ts';
import type { SystemResearchState, ResearchSibling } from './swarm-types.ts';
import { createResearcherSession } from './researcher.ts';
import { injectCurrentDate } from '../utils/inject-date.ts';
import { formatParentContext } from './session-context.ts';
import { formatSharedLinksFromState } from '../utils/shared-links.ts';
import { logger } from '../logger.ts';
import { ensureAssistantResponse } from '../utils/text-utils.ts';
import { addSlice, activateSlice, completeSlice, removeSlice, flashSlice } from '../tui/research-panel.ts';
import { getDisplayNumber, getResearcherRoleContext } from './id-utils.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface SwarmOrchestratorOptions {
  ctx: ExtensionContext;
  model: Model<any>;
  query: string;
  complexity: 1 | 2 | 3;
  onTokens: (n: number) => void;
  onUpdate: () => void;
  searxngUrl: string;
  panelState: any; 
}

export class SwarmOrchestrator {
  private stateManager: SwarmStateManager;
  private state: SystemResearchState;
  private activeSessions = new Map<string, AgentSession>();
  private resolveCompletion: (result: string) => void = () => {};
  private rejectCompletion: (err: any) => void = () => {};

  constructor(private options: SwarmOrchestratorOptions) {
    this.stateManager = new SwarmStateManager(options.ctx);
    this.state = this.stateManager.initialize(options.query, options.complexity);
  }

  private resolveResult(result: string) {
    const final = result.length > 20000 
      ? result.slice(0, 20000) + '\n\n... (final report truncated for length) ...'
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

  private updateState(event: Parameters<typeof swarmReducer>[1]) {
    this.state = swarmReducer(this.state, event);
    this.stateManager.save(this.state);
  }

  private async kickoff(signal?: AbortSignal) {
    if (this.state.status === 'planning') await this.doPlanning(signal);
    if (this.state.status === 'researching') await this.startRound(signal);
    if (this.state.status === 'completed') this.resolveResult(this.state.finalSynthesis || '');
  }

  private getInitialSiblingCount(complexity: 1 | 2 | 3): number {
    switch(complexity) {
      case 1: return 1;        // Simple: start with 1
      case 2: return 2;        // Standard: start with 2
      case 3: return 3;        // Deep: start with 3
    }
  }

  private getMaxRounds(complexity: 1 | 2 | 3): number {
    switch(complexity) {
      case 1: return 2;        // Max 2 rounds for simple
      case 2: return 3;        // Max 3 rounds for standard
      case 3: return 3;        // Max 3 rounds for deep
    }
  }

  private getMaxSiblingsPerRound(complexity: 1 | 2 | 3): number {
    switch(complexity) {
      case 1: return 2;        // Up to 2 per round for simple
      case 2: return 3;        // Up to 3 per round for standard
      case 3: return 3;        // Up to 3 per round for deep
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
        logger.error('[swarm] Failed to parse planning agenda JSON:', err);
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
      logger.log(`[swarm] Round ${currentRound}: Launching ${pendingAspects.length} siblings.`);
      pendingAspects.forEach(aspect => this.executeSibling(aspect, signal));
      return;
    }

    // Perfection/Resumption: If no pending aspects but round isn't empty, check if it's complete
    if (roundAspects.length > 0 && isRoundComplete(this.state, currentRound)) {
       if (!this.state.promotedId && !this.state.finalSynthesis) {
          logger.log(`[swarm] Round ${currentRound} complete on kickoff, but no promotion found. Promoting first available sibling.`);
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

    const session = await createResearcherSession({
      cwd: this.options.ctx.cwd,
      ctxModel: this.options.model,
      modelRegistry: this.options.ctx.modelRegistry,
      settingsManager: (this.options.ctx as any).settingsManager,
      systemPrompt: researcherPrompt,
      searxngUrl: this.options.searxngUrl,
      extensionCtx: this.options.ctx,
      // Pass real closures for global state management
      // Tools now created with proper access to orchestrator state
      getGlobalState: () => this.state,
      updateGlobalLinks: (links: string[]) => {
        logger.log(`[swarm] Adding ${links.length} links to global pool (total: ${this.state.allScrapedLinks.length})`);
        this.updateState({ type: 'LINKS_SCRAPED', links });
        logger.log(`[swarm] Global link pool now: ${this.state.allScrapedLinks.length}`);
      }
    });

    this.activeSessions.set(aspect.id, session);

    session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const tokens = (event.message as any).usage?.totalTokens;
        if (tokens) this.options.onTokens(tokens);
      } else if (event.type === 'tool_execution_end') {
        const color = (event as any).isError ? 'red' : 'green';
        flashSlice(this.options.panelState, aspect.id, color, 1000, this.options.onUpdate);
      }
    });

    try {
      await session.prompt(aspect.query);
      const report = ensureAssistantResponse(session, aspect.id);
      this.updateState({ type: 'SIBLING_COMPLETED', id: aspect.id, report });
      completeSlice(this.options.panelState, aspect.id);
      this.options.onUpdate();

      await this.handleSiblingCompletion(aspect, session, signal);
    } catch (err) {
      logger.error(`[swarm] Sibling ${aspect.id} failed:`, err);
      this.updateState({ type: 'SIBLING_FAILED', id: aspect.id, error: String(err) });
      completeSlice(this.options.panelState, aspect.id);
      this.options.onUpdate();
      await this.handleSiblingCompletion(aspect, session, signal);
    }
  }

  private async handleSiblingCompletion(finished: ResearchSibling, session: AgentSession, signal?: AbortSignal) {
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
            logger.log(`[swarm] Injecting report from ${finished.id} into ${target.id}`);
            // Queue message to interrupt after current tool calls complete
            await targetSession.steer(injectionMessage);
            logger.log(`[swarm] Report successfully queued for ${target.id}`);
          } catch (err) {
            logger.error(`[swarm] Failed to inject report into ${target.id}:`, err);
          }
        }
      }
    }

    // 2. Last-Alive Detection & Promotion
    // Check if this is the last sibling to finish (all others completed or this is the only one)
    if (isRoundComplete(this.state, currentRound)) {
      // Check if a promotion is already in progress to avoid double-evaluation
      if (this.state.promotedId) {
        logger.log(`[swarm] Round ${currentRound} complete, but promotion already started for ${this.state.promotedId}`);
        return;
      }

      if (this.isLastAliveResearcher(finished)) {
        logger.log(`[swarm] ${finished.id} is last alive. Promoting to Lead Evaluator.`);
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
- **Tool Usage**: 4 gathering calls + 1 batch scrape allowed`;
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
    const maxRounds = this.getMaxRounds(this.state.complexity);
    const isLastRound = this.state.currentRound >= maxRounds;

    // Build ALL previous reports from all rounds
    const allReportsContext = this.buildAllFindingsContext();

    const leadPromptRaw = readFileSync(join(__dirname, '..', '..', 'prompts', 'system-lead-evaluator.md'), 'utf-8');
    let leadPrompt = leadPromptRaw
      .replace('{ROUND_NUMBER}', this.state.currentRound.toString())
      .replace('{MAX_ROUNDS}', maxRounds.toString());

    // If it's the last round, force synthesis in the prompt
    if (isLastRound) {
      leadPrompt += '\n\n⚠️ **CRITICAL: THIS IS THE FINAL ROUND.** You MUST provide a FINAL SYNTHESIS in Markdown format. Do NOT output a JSON array of next queries.';
    }

    const agendaSection = remainingAgenda.length > 0
      ? `\n### Unfulfilled Agenda Items\n${remainingAgenda.map(q => `- ${q}`).join('\n')}`
      : '\n### All Agenda Items Covered\nAll initial research agenda items have been addressed.';

    const promotionPrompt = leadPrompt + '\n\n' + allReportsContext + agendaSection;

    try {
      logger.log(`[swarm] Promoting ${_lead.id} to Lead Evaluator for Round ${this.state.currentRound}`);
      
      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.model);
      if (!auth.ok) throw new Error(`Failed to get API credentials: ${auth.error}`);
      
      const response = await complete(this.options.model, {
        messages: [{ role: 'user', content: [{ type: 'text', text: promotionPrompt }], timestamp: Date.now() }]
      }, { apiKey: auth.apiKey!, headers: auth.headers, signal });

      const decision = response.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
      if (response.usage?.totalTokens) {
        this.options.onTokens(response.usage.totalTokens);
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
        
        const willSynthesize = !Array.isArray(nextQueries) || nextQueries.length === 0 || isLastRound;

        this.updateState({
          type: 'PROMOTION_DECISION',
          nextQueries: willSynthesize ? [] : nextQueries.slice(0, this.getMaxSiblingsPerRound(this.state.complexity)),
          finalSynthesis: (willSynthesize || isLastRound) ? decision : undefined,
          maxRounds
        });

        if (willSynthesize) {
          // CRITICAL: System must exit cleanly after synthesis
          logger.log(`[swarm] Lead evaluator synthesizing (Round ${this.state.currentRound}/${maxRounds})`);
          
          let finalOutput = this.state.finalSynthesis || decision;
          if (isLastRound && Array.isArray(nextQueries) && nextQueries.length > 0 && !finalOutput.includes('#')) {
             finalOutput = `## Research Summary (Limit Reached)\n\nThe research limit of ${maxRounds} rounds was reached. The agents proposed further research directions but we must synthesize now:\n\n### Proposed Next Steps (Not Executed)\n${nextQueries.map(q => `- ${q}`).join('\n')}\n\n### Current Findings\n${allReportsContext}`;
             // Save the fallback to state too
             this.updateState({ 
               type: 'PROMOTION_DECISION', 
               nextQueries: [], 
               finalSynthesis: finalOutput, 
               maxRounds 
             });
          }

          this.resolveResult(finalOutput);
          return;
        } else {
          // Continue to next round
          logger.log(`[swarm] Lead evaluator delegating to Round ${this.state.currentRound + 1}`);
          if (this.state.status === 'researching') await this.startRound(signal);
          return;
        }
      } catch (err) {
        // Synthesis fallback
        logger.log(`[swarm] Lead evaluator decision parsing failed or forced synthesis: ${err}`);
        this.updateState({ type: 'PROMOTION_DECISION', nextQueries: [], finalSynthesis: decision, maxRounds });
        this.resolveResult(decision);
        return;
      }
    } catch (err) {
      logger.error(`[swarm] Lead evaluation failed:`, err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.rejectCompletion(new Error(`Lead evaluation failed: ${errorMsg}`));
    }
  }
}
