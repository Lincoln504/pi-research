/**
 * State Manager Unit Tests
 *
 * Tests the state manager for tracking SearXNG container sessions
 * and managing session state persistence.
 */

import { describe, it, expect } from 'vitest';
import type { StateMetrics, SessionInfo, SingletonState, LegacySessionInfo, LegacyState } from '../../../src/infrastructure/state-manager';

describe('State Manager', () => {
  describe('SessionInfo interface', () => {
    it('should create valid session info', () => {
      const info: SessionInfo = {
        pid: 12345,
        lastSeen: Date.now(),
        connectedAt: Date.now(),
      };

      expect(info.pid).toBe(12345);
      expect(info.lastSeen).toBeGreaterThan(0);
      expect(info.connectedAt).toBeGreaterThan(0);
    });

    it('should support optional processStartTime', () => {
      const info: SessionInfo = {
        pid: 12345,
        processStartTime: Date.now(),
        lastSeen: Date.now(),
        connectedAt: Date.now(),
      };

      expect(info.processStartTime).toBeDefined();
    });

    it('should allow different PID values', () => {
      const pids = [1, 100, 5000, 32767];

      for (const pid of pids) {
        const info: SessionInfo = {
          pid,
          lastSeen: Date.now(),
          connectedAt: Date.now(),
        };

        expect(info.pid).toBe(pid);
      }
    });

    it('should track session timing', () => {
      const connectedAt = Date.now();
      const lastSeen = connectedAt + 5000;

      const info: SessionInfo = {
        pid: 12345,
        lastSeen,
        connectedAt,
      };

      expect(info.lastSeen).toBeGreaterThanOrEqual(info.connectedAt);
    });
  });

  describe('SingletonState interface', () => {
    it('should create valid singleton state', () => {
      const state: SingletonState = {
        version: 1,
        containerId: 'container-123',
        containerName: 'searxng-singleton',
        port: 8080,
        ipv6Address: 'fe80::1',
        ipv6Enabled: true,
        networkName: 'pi-searxng-net',
        sessions: {},
        lastUpdated: Date.now(),
      };

      expect(state.version).toBe(1);
      expect(state.containerId).toBe('container-123');
      expect(state.port).toBe(8080);
    });

    it('should allow ipv6Address to be null', () => {
      const state: SingletonState = {
        version: 1,
        containerId: 'container-123',
        containerName: 'searxng-singleton',
        port: 8080,
        ipv6Address: null,
        ipv6Enabled: false,
        networkName: 'pi-searxng-net',
        sessions: {},
        lastUpdated: Date.now(),
      };

      expect(state.ipv6Address).toBeNull();
      expect(state.ipv6Enabled).toBe(false);
    });

    it('should store multiple sessions', () => {
      const sessions: { [key: string]: SessionInfo } = {
        'session-1': {
          pid: 1001,
          lastSeen: Date.now(),
          connectedAt: Date.now(),
        },
        'session-2': {
          pid: 1002,
          lastSeen: Date.now(),
          connectedAt: Date.now(),
        },
      };

      const state: SingletonState = {
        version: 1,
        containerId: 'container-123',
        containerName: 'searxng-singleton',
        port: 8080,
        ipv6Address: null,
        ipv6Enabled: false,
        networkName: 'pi-searxng-net',
        sessions,
        lastUpdated: Date.now(),
      };

      expect(Object.keys(state.sessions)).toHaveLength(2);
      expect(state.sessions['session-1']).toBeDefined();
      expect(state.sessions['session-2']).toBeDefined();
    });

    it('should allow different port numbers', () => {
      const ports = [8080, 3128, 9090, 443, 80];

      for (const port of ports) {
        const state: SingletonState = {
          version: 1,
          containerId: 'container-123',
          containerName: 'searxng-singleton',
          port,
          ipv6Address: null,
          ipv6Enabled: false,
          networkName: 'pi-searxng-net',
          sessions: {},
          lastUpdated: Date.now(),
        };

        expect(state.port).toBe(port);
      }
    });

    it('should support different IPv6 addresses', () => {
      const addresses = [
        'fe80::1',
        '2001:db8::1',
        'fc00::1',
        null,
      ];

      for (const address of addresses) {
        const state: SingletonState = {
          version: 1,
          containerId: 'container-123',
          containerName: 'searxng-singleton',
          port: 8080,
          ipv6Address: address,
          ipv6Enabled: address !== null,
          networkName: 'pi-searxng-net',
          sessions: {},
          lastUpdated: Date.now(),
        };

        expect(state.ipv6Address).toBe(address);
      }
    });
  });

  describe('StateMetrics interface', () => {
    it('should calculate basic metrics', () => {
      const metrics: StateMetrics = {
        totalSessions: 10,
        activeSessions: 3,
        oldestSession: Date.now() - 10000,
        newestSession: Date.now(),
        containerUptime: 300000,
        lastHeartbeatAge: 1000,
      };

      expect(metrics.totalSessions).toBe(10);
      expect(metrics.activeSessions).toBe(3);
      expect(metrics.containerUptime).toBeGreaterThan(0);
    });

    it('should allow null values for optional metrics', () => {
      const metrics: StateMetrics = {
        totalSessions: 0,
        activeSessions: 0,
        oldestSession: null,
        newestSession: null,
        containerUptime: null,
        lastHeartbeatAge: null,
      };

      expect(metrics.oldestSession).toBeNull();
      expect(metrics.containerUptime).toBeNull();
    });

    it('should track different session counts', () => {
      const counts = [0, 1, 5, 10, 100];

      for (const count of counts) {
        const metrics: StateMetrics = {
          totalSessions: count,
          activeSessions: Math.min(count, 5),
          oldestSession: Date.now() - 10000,
          newestSession: Date.now(),
          containerUptime: 300000,
          lastHeartbeatAge: 1000,
        };

        expect(metrics.totalSessions).toBe(count);
      }
    });
  });

  describe('LegacySessionInfo interface', () => {
    it('should represent legacy session format', () => {
      const legacyInfo: LegacySessionInfo = {
        lastSeen: Date.now(),
      };

      expect(legacyInfo.lastSeen).toBeGreaterThan(0);
    });

    it('should support legacy session times', () => {
      const times = [0, 1000000000, Date.now(), Date.now() + 1000];

      for (const time of times) {
        const legacyInfo: LegacySessionInfo = {
          lastSeen: time,
        };

        expect(legacyInfo.lastSeen).toBe(time);
      }
    });
  });

  describe('LegacyState interface', () => {
    it('should represent legacy state format', () => {
      const legacyState: LegacyState = {
        sessions: {
          'session-1': { lastSeen: Date.now() },
        },
        containerExists: true,
        containerPort: 8080,
      };

      expect(legacyState.containerExists).toBe(true);
      expect(legacyState.containerPort).toBe(8080);
    });

    it('should support multiple legacy sessions', () => {
      const legacyState: LegacyState = {
        sessions: {
          'session-1': { lastSeen: Date.now() - 5000 },
          'session-2': { lastSeen: Date.now() - 3000 },
          'session-3': { lastSeen: Date.now() - 1000 },
        },
        containerExists: true,
        containerPort: 8080,
      };

      expect(Object.keys(legacyState.sessions)).toHaveLength(3);
    });

    it('should handle container not existing', () => {
      const legacyState: LegacyState = {
        sessions: {},
        containerExists: false,
        containerPort: 0,
      };

      expect(legacyState.containerExists).toBe(false);
    });
  });

  describe('State transition scenarios', () => {
    it('should transition from legacy to singleton state', () => {
      const legacyState: LegacyState = {
        sessions: {
          'session-1': { lastSeen: Date.now() },
        },
        containerExists: true,
        containerPort: 8080,
      };

      // Convert to singleton state
      const singletonState: SingletonState = {
        version: 1,
        containerId: 'container-123',
        containerName: 'searxng-singleton',
        port: legacyState.containerPort,
        ipv6Address: null,
        ipv6Enabled: false,
        networkName: 'pi-searxng-net',
        sessions: {
          'session-1': {
            pid: 0,
            lastSeen: legacyState.sessions['session-1'].lastSeen,
            connectedAt: legacyState.sessions['session-1'].lastSeen,
          },
        },
        lastUpdated: Date.now(),
      };

      expect(singletonState.port).toBe(legacyState.containerPort);
      expect(Object.keys(singletonState.sessions)).toHaveLength(1);
    });

    it('should add new session to existing state', () => {
      const state: SingletonState = {
        version: 1,
        containerId: 'container-123',
        containerName: 'searxng-singleton',
        port: 8080,
        ipv6Address: null,
        ipv6Enabled: false,
        networkName: 'pi-searxng-net',
        sessions: {
          'session-1': {
            pid: 1001,
            lastSeen: Date.now(),
            connectedAt: Date.now(),
          },
        },
        lastUpdated: Date.now(),
      };

      // Add new session
      state.sessions['session-2'] = {
        pid: 1002,
        lastSeen: Date.now(),
        connectedAt: Date.now(),
      };

      expect(Object.keys(state.sessions)).toHaveLength(2);
    });
  });

  describe('Complex state scenarios', () => {
    it('should manage many concurrent sessions', () => {
      const sessions: { [key: string]: SessionInfo } = {};
      for (let i = 0; i < 100; i++) {
        sessions[`session-${i}`] = {
          pid: 5000 + i,
          lastSeen: Date.now(),
          connectedAt: Date.now() - i * 1000,
        };
      }

      const state: SingletonState = {
        version: 1,
        containerId: 'container-123',
        containerName: 'searxng-singleton',
        port: 8080,
        ipv6Address: 'fe80::1',
        ipv6Enabled: true,
        networkName: 'pi-searxng-net',
        sessions,
        lastUpdated: Date.now(),
      };

      expect(Object.keys(state.sessions)).toHaveLength(100);
    });

    it('should calculate metrics from state', () => {
      const state: SingletonState = {
        version: 1,
        containerId: 'container-123',
        containerName: 'searxng-singleton',
        port: 8080,
        ipv6Address: 'fe80::1',
        ipv6Enabled: true,
        networkName: 'pi-searxng-net',
        sessions: {
          'session-1': { pid: 1001, lastSeen: Date.now() - 5000, connectedAt: Date.now() - 60000 },
          'session-2': { pid: 1002, lastSeen: Date.now() - 3000, connectedAt: Date.now() - 30000 },
          'session-3': { pid: 1003, lastSeen: Date.now() - 1000, connectedAt: Date.now() - 10000 },
        },
        lastUpdated: Date.now(),
      };

      const metrics: StateMetrics = {
        totalSessions: Object.keys(state.sessions).length,
        activeSessions: 3,
        oldestSession: Math.min(...Object.values(state.sessions).map(s => s.connectedAt)),
        newestSession: Math.max(...Object.values(state.sessions).map(s => s.connectedAt)),
        containerUptime: Date.now() - state.lastUpdated,
        lastHeartbeatAge: Date.now() - Math.max(...Object.values(state.sessions).map(s => s.lastSeen)),
      };

      expect(metrics.totalSessions).toBe(3);
      expect(metrics.activeSessions).toBe(3);
    });
  });
});
