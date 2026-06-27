/**
 * Planning Service State Reset Tests
 *
 * Tests that verify planning state is properly reset between research sessions
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { resetConfig } from '../../../src/config.ts';
import { registerCoreServices, initializeCoreServices, disposeCoreServices } from '../../../src/core/service-initialization.ts';
import { registerInfrastructureServices } from '../../../src/infrastructure/service-initialization.ts';
import { registerOrchestrationServices } from '../../../src/orchestration/service-initialization.ts';
import { resetServiceContainer, getService } from '../../../src/core/service-registry.ts';
import { ServiceNames, type IResearchOrchestration, type IPlanningService } from '../../../src/core/service-interfaces.ts';

describe('Planning Service State Reset', () => {
  let orchestrationService: IResearchOrchestration;
  let prevKnowledgeMode: string | undefined;

  beforeAll(() => {
    // Disable the knowledge store for this suite. cleanupResearchServices()
    // otherwise resolves the real KNOWLEDGE_STORE (default mode 'global'), whose
    // embedder probes a GPU; on headless CI with no GPU that probe hangs (~150s),
    // timing the test out and cascading "Cannot reset container while disposing"
    // into sibling tests. Planning-state reset is independent of the store, so
    // mode 'none' keeps the suite hermetic and fast.
    prevKnowledgeMode = process.env['PI_RESEARCH_KNOWLEDGE_STORE_MODE'];
    process.env['PI_RESEARCH_KNOWLEDGE_STORE_MODE'] = 'none';
  });

  afterAll(() => {
    if (prevKnowledgeMode === undefined) delete process.env['PI_RESEARCH_KNOWLEDGE_STORE_MODE'];
    else process.env['PI_RESEARCH_KNOWLEDGE_STORE_MODE'] = prevKnowledgeMode;
    resetConfig();
  });

  beforeEach(async () => {
    resetConfig(); // re-read config so KNOWLEDGE_STORE_MODE='none' takes effect
    await resetServiceContainer();
    registerCoreServices();
    registerInfrastructureServices();
    registerOrchestrationServices();
    
    const mockCtx = {
      cwd: process.cwd(),
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
        hasConfiguredAuth: () => true,
      },
    };
    await initializeCoreServices(mockCtx);
    orchestrationService = await getService<IResearchOrchestration>(ServiceNames.RESEARCH_ORCHESTRATION);
  });

  afterEach(async () => {
    await disposeCoreServices();
  });

  describe('State Accumulation Issue', () => {
    it('should reset currentPlan after cleanup', async () => {
      const planningService = await getService<IPlanningService>(ServiceNames.PLANNING);
      
      // Simulate setting a plan by calling generatePlan with a mock response
      // Or just use internal knowledge of how it works if we can't easily mock LLM here
      // Since this is a state reset test, we can manually manipulate the Map if we have access,
      // but it's better to use the public API.
      
      // We'll use addToQueryHistory as a proxy for state presence if we can't set currentPlan easily
      planningService.addToQueryHistory('test-session', ['q1']);
      expect(planningService.getQueryHistory('test-session')).toHaveLength(1);
      
      // Clean up research services
      await orchestrationService.cleanupResearchServices('test-session');
      
      // State should be cleared
      expect(planningService.getQueryHistory('test-session')).toHaveLength(0);
      expect(planningService.getCurrentPlan('test-session')).toBeNull();
    });

    it('should reset queryHistory after cleanup', async () => {
      const planningService = await getService<IPlanningService>(ServiceNames.PLANNING);
      
      planningService.clearPlanningState();
      
      // Add some queries to history
      planningService.addToQueryHistory('test-session', ['query1', 'query2', 'query3']);
      
      const historyBefore = planningService.getQueryHistory('test-session');
      expect(historyBefore.length).toBeGreaterThan(0);
      
      // Clean up research services
      await orchestrationService.cleanupResearchServices('test-session');
      
      // Query history should be cleared
      const historyAfter = planningService.getQueryHistory('test-session');
      expect(historyAfter.length).toBe(0);
    });

    it('should reset totalResearchersPlanned after cleanup', async () => {
      const planningService = await getService<IPlanningService>(ServiceNames.PLANNING);
      
      planningService.clearPlanningState();
      
      // Manually increment the counter (simulating researcher planning)
      planningService.incrementTotalResearchersPlanned('test-session', 3);
      
      const countBefore = planningService.getTotalResearchersPlanned('test-session');
      expect(countBefore).toBeGreaterThan(0);
      
      // Clean up research services
      await orchestrationService.cleanupResearchServices('test-session');
      
      // Counter should be reset to 0
      const countAfter = planningService.getTotalResearchersPlanned('test-session');
      expect(countAfter).toBe(0);
    });

    it('should reset state between multiple research runs', async () => {
      const planningService = await getService<IPlanningService>(ServiceNames.PLANNING);
      
      // First research run
      planningService.clearPlanningState();
      planningService.incrementTotalResearchersPlanned('test-session', 2);
      planningService.addToQueryHistory('test-session', ['query1', 'query2', 'query3']);
      
      const count1 = planningService.getTotalResearchersPlanned('test-session');
      const history1 = planningService.getQueryHistory('test-session');
      
      expect(count1).toBeGreaterThan(0);
      expect(history1.length).toBeGreaterThan(0);
      
      // Cleanup (simulating end of first research run)
      await orchestrationService.cleanupResearchServices('test-session');
      
      // Second research run
      planningService.incrementTotalResearchersPlanned('test-session', 1);
      planningService.addToQueryHistory('test-session', ['query5']);
      
      const count2 = planningService.getTotalResearchersPlanned('test-session');
      const history2 = planningService.getQueryHistory('test-session');
      
      // Counter should start fresh, not continue from previous run
      expect(count2).toBe(1);
      
      // History should only contain queries from second run
      expect(history2.length).toBe(1);
      expect(history2).toContain('query5');
      expect(history2).not.toContain('query1');
    });

    it('should reset state when calling resetResearchServices', async () => {
      const planningService = await getService<IPlanningService>(ServiceNames.PLANNING);
      
      planningService.clearPlanningState();
      planningService.incrementTotalResearchersPlanned('test-session', 1);
      planningService.addToQueryHistory('test-session', ['q1']);
      
      expect(planningService.getTotalResearchersPlanned('test-session')).toBeGreaterThan(0);
      
      // Use resetResearchServices (alias for cleanup)
      await orchestrationService.cleanupResearchServices('test-session');
      
      expect(planningService.getCurrentPlan('test-session')).toBeNull();
      expect(planningService.getTotalResearchersPlanned('test-session')).toBe(0);
    });

    it('should handle multiple cleanup calls safely', async () => {
      // Multiple cleanup calls should be safe
      await orchestrationService.cleanupResearchServices('test-session');
      await orchestrationService.cleanupResearchServices('test-session');
      await orchestrationService.cleanupResearchServices('test-session');
      
      const planningService = await getService<IPlanningService>(ServiceNames.PLANNING);
      expect(planningService.getCurrentPlan('test-session')).toBeNull();
    });

    it('should maintain researcher ID sequencing within a single run', async () => {
      const planningService = await getService<IPlanningService>(ServiceNames.PLANNING);
      
      planningService.clearPlanningState();
      
      // First plan
      planningService.incrementTotalResearchersPlanned('test-session', 2);
      
      const count1 = planningService.getTotalResearchersPlanned('test-session');
      expect(count1).toBe(2);
      
      // Second plan in same run (simulating multi-round research)
      planningService.incrementTotalResearchersPlanned('test-session', 3);
      
      const count2 = planningService.getTotalResearchersPlanned('test-session');
      expect(count2).toBe(5); // Should increment
      
      // Cleanup between runs
      await orchestrationService.cleanupResearchServices('test-session');
      
      // New run should start fresh
      planningService.incrementTotalResearchersPlanned('test-session', 1);
      
      const count3 = planningService.getTotalResearchersPlanned('test-session');
      expect(count3).toBe(1);
    });
  });

  describe('ResearchPlan Type Unification', () => {
    it('should accept wait as valid action in ResearchPlan', async () => {
      const planningService = await getService<IPlanningService>(ServiceNames.PLANNING);
      
      // Verify that 'wait' is a valid action type
      const planWithWait: any = {
        action: 'wait',
        researchers: [],
        allQueries: [],
        content: 'Waiting for more information'
      };
      
      // The planning service must parse it AND preserve the 'wait' action +
      // content (a parser that silently dropped them would still not throw).
      const parsed = planningService.parseJsonPlan(JSON.stringify(planWithWait));
      expect(parsed.action).toBe('wait');
      expect(parsed.content).toBe('Waiting for more information');
    });

    it('should not require duplicate schema definitions', async () => {
      const planningService = await getService<IPlanningService>(ServiceNames.PLANNING);
      
      // Test that the canonical schema works correctly
      const canonicalPlan = {
        action: 'wait' as const,
        researchers: [
          {
            id: 'researcher-1',
            name: 'Test Researcher',
            goal: 'Test goal',
            queries: ['test query']
          }
        ],
        allQueries: ['query1', 'query2'],
        content: 'Test content'
      };
      
      const parsed = planningService.parseJsonPlan(JSON.stringify(canonicalPlan));
      expect(parsed.action).toBe('wait');
      expect(parsed.researchers).toHaveLength(1);
      expect(parsed.researchers![0]!.name).toBe('Test Researcher');
      expect(parsed.allQueries).toEqual(['query1', 'query2']);
    });
  });
});
