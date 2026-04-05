/**
 * Orchestration Integration Tests
 *
 * Tests the creation and basic interaction of researcher and coordinator agents.
 */

import { describe, it, expect, vi } from 'vitest';
import { createResearcherSession } from '../../src/orchestration/researcher.ts';
import { createCoordinatorSession } from '../../src/orchestration/coordinator.ts';
import { SessionManager, SettingsManager } from '@mariozechner/pi-coding-agent';
import * as os from 'node:os';
import * as path from 'node:path';

describe('Orchestration Integration', () => {
  const mockModel = {
    id: 'test-model',
    name: 'Test Model',
  };

  const mockModelRegistry = {
    get: vi.fn().mockReturnValue(mockModel),
    getAll: vi.fn().mockReturnValue([mockModel]),
  };

  const tempDir = path.join(os.tmpdir(), 'pi-research-test-' + Date.now());
  const settingsManager = SettingsManager.create(tempDir, tempDir);

  const mockExtensionCtx = {
    cwd: process.cwd(),
    ui: { setWidget: vi.fn() },
  };

  describe('Researcher Session', () => {
    it('should create a researcher session with expected tools', async () => {
      const session = await createResearcherSession({
        cwd: process.cwd(),
        ctxModel: mockModel as any,
        modelRegistry: mockModelRegistry as any,
        settingsManager: settingsManager as any,
        systemPrompt: 'You are a researcher.',
        searxngUrl: 'http://localhost:8080',
        extensionCtx: mockExtensionCtx as any,
      });

      expect(session).toBeDefined();
    });

    it('should fail if model is missing', async () => {
      await expect(createResearcherSession({
        cwd: process.cwd(),
        ctxModel: undefined,
        modelRegistry: mockModelRegistry as any,
        settingsManager: settingsManager as any,
        systemPrompt: 'You are a researcher.',
        searxngUrl: 'http://localhost:8080',
        extensionCtx: mockExtensionCtx as any,
      })).rejects.toThrow('No model selected');
    });
  });

  describe('Coordinator Session', () => {
    it('should create a coordinator session', async () => {
      const session = await createCoordinatorSession({
        cwd: process.cwd(),
        ctxModel: mockModel as any,
        modelRegistry: mockModelRegistry as any,
        sessionManager: SessionManager.inMemory(),
        settingsManager: settingsManager as any,
        systemPrompt: 'You are a coordinator.',
        customTools: [],
      });

      expect(session).toBeDefined();
    });
  });
});
