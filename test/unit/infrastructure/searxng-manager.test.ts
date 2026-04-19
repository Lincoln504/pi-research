import { describe, expect, it } from 'vitest';
import {
  DOCKER_HOST_INTERNAL_HOSTNAME,
  getDockerConnectionCandidates,
  getDockerHostGatewayExtraHosts,
} from '../../../src/infrastructure/searxng-manager.ts';

describe('searxng-manager portability helpers', () => {
  describe('getDockerConnectionCandidates', () => {
    it('normalizes Windows named-pipe override via DOCKER_SOCKET', () => {
      const candidates = getDockerConnectionCandidates({
        DOCKER_SOCKET: '\\\\.\\pipe\\docker_engine',
      } as NodeJS.ProcessEnv);

      expect(candidates[0]).toEqual({ socketPath: '//./pipe/docker_engine' });
    });

    it('accepts unix:// DOCKER_HOST', () => {
      const candidates = getDockerConnectionCandidates({
        DOCKER_HOST: 'unix:///var/run/docker.sock',
      } as NodeJS.ProcessEnv);

      expect(candidates[0]).toEqual({ socketPath: '/var/run/docker.sock' });
    });

    it('accepts npipe:// DOCKER_HOST and normalizes path', () => {
      const candidates = getDockerConnectionCandidates({
        DOCKER_HOST: 'npipe://\\\\.\\pipe\\docker_engine',
      } as NodeJS.ProcessEnv);

      expect(candidates[0]).toEqual({ socketPath: '//./pipe/docker_engine' });
    });

    it('accepts tcp DOCKER_HOST', () => {
      const candidates = getDockerConnectionCandidates({
        DOCKER_HOST: 'tcp://127.0.0.1:2375',
      } as NodeJS.ProcessEnv);

      expect(candidates[0]).toEqual({ host: '127.0.0.1', port: 2375, protocol: 'http' });
    });

    it('ignores malformed DOCKER_HOST and falls through to platform defaults', () => {
      const candidates = getDockerConnectionCandidates({
        DOCKER_HOST: 'not-a-url',
      } as NodeJS.ProcessEnv);

      // Falls through to platform default (/var/run/docker.sock on linux/darwin)
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.some((c) => 'socketPath' in c)).toBe(true);
    });

    it('deduplicates when DOCKER_SOCKET matches a platform default', () => {
      const candidates = getDockerConnectionCandidates({
        DOCKER_SOCKET: '/var/run/docker.sock',
      } as NodeJS.ProcessEnv);

      const unixSockCount = candidates.filter(
        (c) => 'socketPath' in c && c.socketPath === '/var/run/docker.sock',
      ).length;

      expect(unixSockCount).toBe(1);
    });

    it('returns at least one candidate when no env overrides are set', () => {
      const candidates = getDockerConnectionCandidates({} as NodeJS.ProcessEnv);
      expect(candidates.length).toBeGreaterThan(0);
    });
  });

  describe('getDockerHostGatewayExtraHosts', () => {
    it('returns host-gateway alias only on linux', () => {
      expect(getDockerHostGatewayExtraHosts('linux')).toEqual([
        `${DOCKER_HOST_INTERNAL_HOSTNAME}:host-gateway`,
      ]);
    });

    it('returns empty array on darwin', () => {
      expect(getDockerHostGatewayExtraHosts('darwin')).toEqual([]);
    });

    it('returns empty array on win32', () => {
      expect(getDockerHostGatewayExtraHosts('win32')).toEqual([]);
    });
  });
});
