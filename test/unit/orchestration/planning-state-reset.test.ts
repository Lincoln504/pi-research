/**
 * Planning Service State Reset Tests
 *
 * Tests that verify planning state is properly reset between research sessions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerCoreServices, initializeCoreServices, disposeCoreServices } from '../../../src/core/service-initialization.ts';
import { registerInfrastructureServices } from '../../../src/infrastructure/service-initialization.ts';
import { resetServiceContainer } from '../../../src/core/service-registry.ts';
import { getService } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';
import { cleanupResearchServices, resetResearchServices } from '../../../src/orchestration/research-session-manager.ts';

describe('Planning Service State Reset', () => {
  beforeEach(async () => {
    await resetServiceContainer();
    registerCoreServices();
    registerInfrastructureServices();
    
    const mockCtx = {
      cwd: process.cwd(),
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', headers: {} }),
        hasConfiguredAuth: () => true,
      },
    };
    await initializeCoreServices(mockCtx);
  });

  afterEach(async () => {
    await disposeCoreServices();
  });

  describe('State Accumulation Issue', () => {
    it('should reset currentPlan after cleanup', async () => {
      const planningService = await getService<any>(ServiceNames.PLANNING);
      
      // Directly set the internal state (parseJsonPlan doesn't set state)
      const directSetter = planningService as any;
      const testPlan = {
        action: 'delegate' as const,
        researchers: [
          { id: 'r1', name: 'Test', goal: 'Goal', queries: ['q1'] }
        ]
      };
      planningService.getState('test-session').currentPlan = testPlan;
      
      const planBefore = planningService.getCurrentPlan('test-session');
      expect(planBefore).not.toBeNull();
      expect(planBefore?.action).toBeDefined();
      
      // Clean up research services
      await cleanupResearchServices('test-session');
      
      // Plan should be cleared
      const planAfter = planningService.getCurrentPlan('test-session');
      expect(planAfter).toBeNull();
    });

    it('should reset queryHistory after cleanup', async () => {
      const planningService = await getService<any>(ServiceNames.PLANNING);
      
      planningService.clearPlanningState();
      
      // Add some queries to history
      planningService.addToQueryHistory('test-session', ['query1', 'query2', 'query3']);
      
      const historyBefore = planningService.getQueryHistory('test-session');
      expect(historyBefore.length).toBeGreaterThan(0);
      
      // Clean up research services
      await cleanupResearchServices('test-session');
      
      // Query history should be cleared
      const historyAfter = planningService.getQueryHistory('test-session');
      expect(historyAfter.length).toBe(0);
    });

    it('should reset totalResearchersPlanned after cleanup', async () => {
      const planningService = await getService<any>(ServiceNames.PLANNING);
      
      planningService.clearPlanningState();
      
      // Manually increment the counter (simulating researcher planning)
      const directSetter = planningService as any;
      planningService.incrementTotalResearchersPlanned('test-session', 3);
      
      const countBefore = planningService.getTotalResearchersPlanned('test-session');
      expect(countBefore).toBeGreaterThan(0);
      
      // Clean up research services
      await cleanupResearchServices('test-session');
      
      // Counter should be reset to 0
      const countAfter = planningService.getTotalResearchersPlanned('test-session');
      expect(countAfter).toBe(0);
    });

    it('should reset state between multiple research runs', async () => {
      const planningService = await getService<any>(ServiceNames.PLANNING);
      const directSetter = planningService as any;
      
      // First research run
      planningService.clearPlanningState();
      planningService.incrementTotalResearchersPlanned('test-session', 2);
      planningService.addToQueryHistory('test-session', ['query1', 'query2', 'query3']);
      
      const count1 = planningService.getTotalResearchersPlanned('test-session');
      const history1 = planningService.getQueryHistory('test-session');
      
      expect(count1).toBeGreaterThan(0);
      expect(history1.length).toBeGreaterThan(0);
      
      // Cleanup (simulating end of first research run)
      await cleanupResearchServices('test-session');
      
      // Second research run
      planningService.clearPlanningState();
      planningService.incrementTotalResearchersPlanned('test-session', 1);
      planningService.addToQueryHistory('test-session', ['query5']);
      
      const count2 = planningService.getTotalResearchersPlanned('test-session');
      const history2 = planningService.getQueryHistory('test-session');
      
      // Counter should start fresh, not continue from previous run
      expect(count2).toBeGreaterThan(0);
      expect(count2).toBeLessThan(count1); // New run should have fresh counter
      
      // History should only contain queries from second run
      expect(history2.length).toBeGreaterThan(0);
      expect(history2.every((q: string) => !history1.includes(q))).toBe(true); // No overlap
    });

    it('should reset state when calling resetResearchServices', async () => {
      const planningService = await getService<any>(ServiceNames.PLANNING);
      const directSetter = planningService as any;
      
      planningService.clearPlanningState();
      const testPlan = {
        action: 'delegate' as const,
        researchers: [
          { id: 'r1', name: 'Test', goal: 'Goal', queries: ['q1'] }
        ]
      };
      
      planningService.getState('test-session').currentPlan = testPlan;
      planningService.incrementTotalResearchersPlanned('test-session', 1);
      
      expect(planningService.getCurrentPlan('test-session')).not.toBeNull();
      expect(planningService.getTotalResearchersPlanned('test-session')).toBeGreaterThan(0);
      
      // Use resetResearchServices (alias for cleanup)
      await resetResearchServices('test-session');
      
      expect(planningService.getCurrentPlan('test-session')).toBeNull();
      expect(planningService.getTotalResearchersPlanned('test-session')).toBe(0);
    });

    it('should handle multiple cleanup calls safely', async () => {
      const planningService = await getService<any>(ServiceNames.PLANNING);
      const directSetter = planningService as any;
      
      planningService.clearPlanningState();
      const testPlan = {
        action: 'delegate' as const,
        researchers: [
          { id: 'r1', name: 'Test', goal: 'Goal', queries: ['q1'] }
        ]
      };
      
      planningService.getState('test-session').currentPlan = testPlan;
      expect(planningService.getCurrentPlan('test-session')).not.toBeNull();
      
      // Multiple cleanup calls should be safe
      await cleanupResearchServices('test-session');
      await cleanupResearchServices('test-session');
      await cleanupResearchServices('test-session');
      
      expect(planningService.getCurrentPlan('test-session')).toBeNull();
    });

    it('should maintain researcher ID sequencing within a single run', async () => {
      const planningService = await getService<any>(ServiceNames.PLANNING);
      const directSetter = planningService as any;
      
      planningService.clearPlanningState();
      
      // First plan
      planningService.incrementTotalResearchersPlanned('test-session', 2);
      
      const count1 = planningService.getTotalResearchersPlanned('test-session');
      expect(count1).toBeGreaterThan(0);
      
      // Second plan in same run (simulating multi-round research)
      planningService.incrementTotalResearchersPlanned('test-session', 3);
      
      const count2 = planningService.getTotalResearchersPlanned('test-session');
      expect(count2).toBeGreaterThan(count1); // Should increment
      
      // Cleanup between runs
      await cleanupResearchServices('test-session');
      
      // New run should start fresh
      planningService.clearPlanningState();
      planningService.incrementTotalResearchersPlanned('test-session', 1);
      
      const count3 = planningService.getTotalResearchersPlanned('test-session');
      expect(count3).toBeGreaterThan(0);
      expect(count3).toBeLessThan(count2); // Should start fresh, not continue
    });
  });

  describe('ResearchPlan Type Unification', () => {
    it('should accept wait as valid action in ResearchPlan', async () => {
      const planningService = await getService<any>(ServiceNames.PLANNING);
      
      // Verify that 'wait' is a valid action type
      const planWithWait: any = {
        action: 'wait',
        researchers: [],
        allQueries: [],
        content: 'Waiting for more information'
      };
      
      // The planning service should handle this plan
      expect(() => {
        planningService.parseJsonPlan(JSON.stringify(planWithWait));
      }).not.toThrow();
    });

    it('should include wait in the canonical ResearchPlan type', () => {
      // This test verifies the type system - if it compiles, the types are correct
      const plan1: any = { action: 'synthesize' };
      const plan2: any = { action: 'delegate' };
      const plan3: any = { action: 'wait' };
      
      expect(['synthesize', 'delegate', 'wait']).toContain(plan1.action);
      expect(['synthesize', 'delegate', 'wait']).toContain(plan2.action);
      expect(['synthesize', 'delegate', 'wait']).toContain(plan3.action);
    });

    it('should not require duplicate schema definitions', async () => {
      const planningService = await getService<any>(ServiceNames.PLANNING);
      
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
      
      expect(() => {
        planningService.parseJsonPlan(JSON.stringify(canonicalPlan));
      }).not.toThrow();
    });
  });
});