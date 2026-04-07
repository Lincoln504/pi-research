/**
 * Swarm State Manager Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SwarmStateManager } from '../../../src/orchestration/state-manager';

describe('SwarmStateManager', () => {
  const createMockCtx = (entries: any[] = []) => ({
    sessionManager: {
      getEntries: vi.fn(() => entries),
      appendCustomEntry: vi.fn((customType: string, data: unknown) => {
        entries.push({ type: 'custom', customType, data });
      }),
    },
  } as any);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('load', () => {
    it('should return null if no research state exists', () => {
      const ctx = createMockCtx([{ type: 'message' }]);
      const manager = new SwarmStateManager(ctx);
      expect(manager.load()).toBeNull();
    });

    it('should load the latest research state', () => {
      const state1 = { status: 'planning', currentRound: 1 };
      const state2 = { status: 'researching', currentRound: 1 };
      const ctx = createMockCtx([
        { type: 'custom', customType: 'pi-research-state', data: state1 },
        { type: 'message' },
        { type: 'custom', customType: 'pi-research-state', data: state2 },
      ]);
      const manager = new SwarmStateManager(ctx);
      expect(manager.load()).toEqual(state2);
    });
  });

  describe('save', () => {
    it('should append a new research state entry', () => {
      const ctx = createMockCtx();
      const manager = new SwarmStateManager(ctx);
      const state: any = { status: 'completed' };
      
      manager.save(state);
      
      expect(ctx.sessionManager.appendCustomEntry).toHaveBeenCalledWith('pi-research-state', expect.objectContaining({
        status: 'completed',
        lastUpdated: expect.any(Number),
      }));
    });
  });

  describe('initialize', () => {
    it('should resume existing state if query matches', () => {
      const existingState = { rootQuery: 'test query', complexity: 2, status: 'researching' };
      const ctx = createMockCtx([{ type: 'custom', customType: 'pi-research-state', data: existingState }]);
      const manager = new SwarmStateManager(ctx);
      
      const state = manager.initialize('test query', 2);
      expect(state).toEqual(existingState);
    });

    it('should return fresh state if no existing state matches', () => {
      const ctx = createMockCtx();
      const manager = new SwarmStateManager(ctx);
      
      const state = manager.initialize('new query', 3);
      expect(state.rootQuery).toBe('new query');
      expect(state.complexity).toBe(3);
      expect(state.status).toBe('planning');
    });
  });
});
