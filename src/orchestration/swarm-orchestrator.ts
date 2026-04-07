/**
 * Swarm Orchestrator
 * 
 * Manages the decentralized swarm research lifecycle:
 * 1. Initial Planning (One-shot) - exhaustive agenda creation
 * 2. Parallel Sibling Execution - with mid-flight report injection
 * 3. Last-Man-Standing Promotion - the final sibling handles evaluation/synthesis
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { ExtensionContext, AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { complete } from '@mariozechner/pi-ai';
import { SwarmStateManager } from './state-manager.ts';
import type { SystemResearchState, ResearchSibling } from './swarm-types.ts';
import { createResearcherSession } from './researcher.ts';
import { injectCurrentDate } from '../utils/inject-date.ts';
import { formatParentContext } from './session-context.ts';
import { formatSharedLinksFromState } from '../utils/shared-links.ts';
import { logger } from '../logger.ts';
import { ensureAssistantResponse } from '../utils/text-utils.ts';
import { addSlice, activateSlice, completeSlice, removeSlice, flashSlice } from '../tui/research-panel.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface SwarmOrchestratorOptions {
  ctx: ExtensionContext;
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

  /**
   * Ignites the research system.
   * Returns a promise that resolves when the entire system completes synthesis.
   */
  async run(signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;

      if (signal?.aborted) return reject(new Error('Research aborted'));
      signal?.addEventListener('abort', () => reject(new Error('Research aborted')));

      this.kickoff(signal).catch(reject);
    });
  }

  private async kickoff(signal?: AbortSignal) {
    if (this.state.status === 'planning') {
      await this.doPlanning(signal);
    }
    
    if (this.state.status === 'researching') {
      await this.startRound(signal);
    } else if (this.state.status === 'completed') {
      this.resolveCompletion(this.state.finalSynthesis || '');
    }
  }

  private async doPlanning(signal?: AbortSignal) {
    const sliceLabel = 'planning ...';
    addSlice(this.options.panelState, sliceLabel, sliceLabel, false);
    activateSlice(this.options.panelState, sliceLabel);
    this.options.onUpdate();

    try {
      const parentConvo = await formatParentContext(this.options.ctx);
      const plannerPrompt = `You are a Research Planner. Decompose this query into an EXHAUSTIVE list of research aspects.
Output ONLY a JSON array of strings. 

HISTORY: ${parentConvo}
QUERY: ${this.state.rootQuery}`;

      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.ctx.model!);
      if (!auth.ok) {
        throw new Error(auth.error);
      }
      const response = await complete(this.options.ctx.model!, {
        messages: [{ role: 'user', content: [{ type: 'text', text: plannerPrompt }], timestamp: Date.now() }]
      }, { apiKey: auth.apiKey, headers: auth.headers, signal });

      const text = response.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
      const agenda: string[] = JSON.parse(text.match(/\[.*\]/s)?.[0] || '[]');
      
      this.state.initialAgenda = agenda;
      const initialCount = this.state.complexity === 1 ? 1 : 3;
      agenda.slice(0, initialCount).forEach((q, i) => {
        const id = `1.${i + 1}`;
        this.state.aspects[id] = { id, query: q, status: 'pending' };
      });

      this.state.status = 'researching';
      this.stateManager.save(this.state);
    } finally {
      removeSlice(this.options.panelState, sliceLabel);
      this.options.onUpdate();
    }
  }

  private async startRound(signal?: AbortSignal) {
    const currentRound = this.state.currentRound;
    const roundAspects = Object.values(this.state.aspects).filter(a => a.id.startsWith(`${currentRound}.`) && a.status === 'pending');

    if (roundAspects.length === 0) {
      this.state.status = 'completed';
      this.resolveCompletion(this.state.finalSynthesis || 'Research ended.');
      return;
    }

    logger.log(`[swarm] Round ${currentRound}: Launching ${roundAspects.length} siblings.`);
    // Parallel launch, but we don't wait for Promise.all here because it's event-driven
    roundAspects.forEach(aspect => this.executeSibling(aspect, signal));
  }

  private async executeSibling(aspect: ResearchSibling, signal?: AbortSignal) {
    aspect.status = 'running';
    this.stateManager.save(this.state);

    const sliceLabel = aspect.id;
    addSlice(this.options.panelState, sliceLabel, sliceLabel, true);
    activateSlice(this.options.panelState, sliceLabel);
    this.options.onUpdate();

    const researcherPromptRaw = readFileSync(join(__dirname, '..', '..', 'prompts', 'researcher.md'), 'utf-8');
    const sharedLinksMarkdown = formatSharedLinksFromState(this.state.aspects);
    const researcherPrompt = injectCurrentDate(researcherPromptRaw, 'researcher') + '\n\n' + sharedLinksMarkdown;

    const session = await createResearcherSession({
      cwd: this.options.ctx.cwd,
      ctxModel: this.options.ctx.model,
      modelRegistry: this.options.ctx.modelRegistry,
      settingsManager: (this.options.ctx as any).settingsManager,
      systemPrompt: researcherPrompt,
      searxngUrl: this.options.searxngUrl,
      extensionCtx: this.options.ctx,
      getGlobalState: () => this.state,
      updateGlobalLinks: (links) => {
        this.state.allScrapedLinks = [...new Set([...this.state.allScrapedLinks, ...links])];
        this.stateManager.save(this.state);
      },
    });
    this.activeSessions.set(aspect.id, session);

    session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const tokens = (event.message as any).usage?.totalTokens;
        if (tokens) this.options.onTokens(tokens);
      } else if (event.type === 'tool_execution_end') {
        const color = (event as any).isError ? 'red' : 'green';
        flashSlice(this.options.panelState, sliceLabel, color, 1000, this.options.onUpdate);
      }
    });

    try {
      await session.prompt(aspect.query);
      aspect.report = ensureAssistantResponse(session, aspect.id);
      aspect.status = 'completed';
      completeSlice(this.options.panelState, sliceLabel);
      this.options.onUpdate();
      
      await this.handleSiblingCompletion(aspect, session, signal);
    } catch (err) {
      logger.error(`[swarm] Sibling ${aspect.id} failed:`, err);
      aspect.status = 'failed';
      this.stateManager.save(this.state);
      completeSlice(this.options.panelState, sliceLabel);
      this.options.onUpdate();
      await this.handleSiblingCompletion(aspect, session, signal);
    }
  }

  private async handleSiblingCompletion(finished: ResearchSibling, session: AgentSession, signal?: AbortSignal) {
    const currentRound = this.state.currentRound;
    const allSiblings = Object.values(this.state.aspects).filter(a => a.id.startsWith(`${currentRound}.`));
    const runningSiblings = allSiblings.filter(s => s.status === 'running' && s.id !== finished.id);

    // 1. Injection Chain: Push this report to all still-running siblings
    if (finished.report) {
      for (const target of runningSiblings) {
        const targetSession = this.activeSessions.get(target.id);
        if (targetSession) {
          logger.log(`[swarm] Injecting ${finished.id} -> ${target.id}`);
          targetSession.steer(`UPDATE: Sibling ${finished.id} just finished aspect "${finished.query}".\n\nFINDINGS:\n${finished.report}\n\nKeep these findings in mind as you continue your work.`)
            .catch((e: unknown) => logger.error(`[swarm] Failed to steer ${target.id}:`, e));
        }
      }
    }

    // 2. Check if this is the Last-Man-Standing
    const completedCount = allSiblings.filter(s => s.status === 'completed' || s.status === 'failed').length;
    if (completedCount === allSiblings.length) {
      logger.log(`[swarm] Round ${currentRound} complete. Sibling ${finished.id} promoted to Lead.`);
      await this.promoteToLead(finished, session, signal);
    }
  }

  private async promoteToLead(_lead: ResearchSibling, session: AgentSession, signal?: AbortSignal) {
    const currentRound = this.state.currentRound;
    const completedAspectQueries = Object.values(this.state.aspects).map(a => a.query);
    const remainingAgenda = this.state.initialAgenda.filter(q => !completedAspectQueries.includes(q));

    const maxRounds = 3;
    const isFinalRound = currentRound >= maxRounds;

    const promotionPrompt = `You are the Lead Evaluator. Every researcher in this round has finished.
Your context already contains injected reports from your siblings. 

INITIAL AGENDA ITEMS NOT YET RESEARCHED:
${remainingAgenda.length > 0 ? remainingAgenda.map(q => `- ${q}`).join('\n') : 'None'}

TASK:
1. Evaluate if we have enough info to satisfy: "${this.state.rootQuery}"
2. If YES or Round ${maxRounds} reached: Output FINAL SYNTHESIS in Markdown.
3. If NO: Output a JSON array of up to 2 new research aspects for the NEXT round. Prioritize unfulfilled agenda items if they are still the best next step.`;

    try {
      await session.prompt(promotionPrompt);
      const decision = ensureAssistantResponse(session, 'Lead');

      try {
        const nextQueries: string[] = JSON.parse(decision.match(/\[.*\]/s)?.[0] || '[]');
        if (nextQueries.length > 0 && !isFinalRound) {
          this.state.currentRound++;
          nextQueries.slice(0, 2).forEach((q, i) => {
            const id = `${this.state.currentRound}.${i + 1}`;
            this.state.aspects[id] = { id, query: q, status: 'pending' };
          });
          this.stateManager.save(this.state);
          await this.startRound(signal);
        } else {
          this.state.finalSynthesis = decision;
          this.state.status = 'completed';
          this.stateManager.save(this.state);
          this.resolveCompletion(decision);
        }
      } catch {
        this.state.finalSynthesis = decision;
        this.state.status = 'completed';
        this.stateManager.save(this.state);
        this.resolveCompletion(decision);
      }
    } catch (err) {
      this.rejectCompletion(err);
    }
  }
}
