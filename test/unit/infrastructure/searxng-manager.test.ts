import { describe, expect, it } from 'vitest';
import {
  DOCKER_HOST_INTERNAL_HOSTNAME,
  getDockerConnectionCandidates,
  getDockerHostGatewayExtraHosts,
} from '../../../src/infrastructure/searxng-manager.ts';

describe('searxng-manager portability helpers', () => {
  it('normalizes Windows Docker named pipe overrides', () => {
    const candidates = getDockerConnectionCandidates({
      DOCKER_SOCKET: '\\\\.\\pipe\\docker_engine',
    } as NodeJS.ProcessEnv);

    expect(candidates[0]).toEqual({ socketPath: '//./pipe/docker_engine' });
  });

  it('uses Docker host-gateway only where Docker needs an explicit Linux alias', () => {
    expect(getDockerHostGatewayExtraHosts('linux'))
      .toEqual([`${DOCKER_HOST_INTERNAL_HOSTNAME}:host-gateway`]);
    expect(getDockerHostGatewayExtraHosts('darwin')).toEqual([]);
    expect(getDockerHostGatewayExtraHosts('win32')).toEqual([]);
  });
});
