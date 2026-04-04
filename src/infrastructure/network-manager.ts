/**
 * IPv6 Network Manager for SearXNG Containers
 *
 * Creates custom IPv6 networks to enable automatic IP rotation.
 * Supports both session-scoped and singleton scenarios.
 *
 * DESIGN:
 * 1. Per-identifier networks - one per session or singleton instance
 * 2. Automatic cleanup - networks removed on session/singleton end
 * 3. Graceful fallback - continue with IPv4 if IPv6 unavailable
 * 4. Orphan cleanup - remove leftover networks from crashed sessions
 */
import { logger } from '../logger.js';

import type Docker from 'dockerode';

/**
 * Docker network information types
 */
interface DockerNetworkInfo {
  Name: string;
  Id: string;
  Containers?: Record<string, unknown>;
  IPAM?: {
    Config?: Array<{
      Subnet?: string;
      Gateway?: string;
    }>;
  };
}

/**
 * Docker network inspection result
 */
interface DockerNetworkInspectInfo {
  Id: string;
  Name: string;
  IPAM?: {
    Config?: Array<{
      Subnet?: string;
      Gateway?: string;
    }>;
  };
}

/**
 * Docker error with status code
 */
interface DockerError extends Error {
  statusCode?: number;
  reason?: string;
}

/**
 * IPv6 network configuration
 */
export interface IPv6NetworkInfo {
  name: string;
  ipv6Address: string | null;
  created: boolean;
}

/**
 * NetworkManager Class
 *
 * Manages IPv6 network creation, assignment, and cleanup for SearXNG containers.
 */
export class NetworkManager {
  private readonly docker: Docker;
  private readonly identifier: string;
  private readonly networkName: string;
  private networkId: string | null = null;
  private ipv6Enabled: boolean = false;

  constructor(docker: Docker, identifier: string) {
    this.docker = docker;
    this.identifier = identifier;
    this.networkName = `pi-searxng-net-${identifier}`;
  }

  /**
   * Clean up orphaned networks from previous sessions
   */
  private async cleanupOrphanedNetworks(): Promise<void> {
    try {
      const networks = await this.docker.listNetworks();

      for (const network of networks) {
        const networkInfo = network as DockerNetworkInfo;
        const name = networkInfo.Name;

        if (!name.startsWith('pi-searxng-net-')) {
          continue;
        }

        // Skip our current network
        if (name === this.networkName) {
          continue;
        }

        // Skip if network has containers (might be in use)
        const containers = networkInfo.Containers;
        if (containers !== undefined && Object.keys(containers).length > 0) {
          logger.log(`[NetworkManager] Skipping network ${name} - has containers`);
          continue;
        }

        try {
          const net = this.docker.getNetwork(networkInfo.Id);
          await net.remove({ force: true });
          logger.log(`[NetworkManager] Removed orphaned network: ${name}`);
        } catch (error) {
          logger.warn(`[NetworkManager] Failed to remove network ${name}:`, error);
        }
      }
    } catch (error) {
      logger.warn('[NetworkManager] Failed to cleanup orphaned networks:', error);
    }
  }

  /**
   * Create a custom IPv6 network for this identifier
   */
  async createIPv6Network(): Promise<IPv6NetworkInfo> {
    // Cleanup orphaned networks first
    await this.cleanupOrphanedNetworks();

    // Check if network already exists (resume scenario)
    try {
      const existingNetwork = this.docker.getNetwork(this.networkName);
      const info = (await existingNetwork.inspect()) as DockerNetworkInspectInfo;
      this.networkId = info.Id;

      // Get IPv6 address from network config (container address, not gateway)
      const ipamConfig = info.IPAM?.Config;
      const subnet = ipamConfig?.[0]?.Subnet ?? '';
      const ipv6Address = subnet !== '' ? subnet.replace('::/64', '::2') : null; // Container address (::2), not gateway (::1)

      logger.log(`[NetworkManager] Reusing existing IPv6 network: ${this.networkName}`);

      this.ipv6Enabled = true;
      return {
        name: this.networkName,
        ipv6Address,
        created: false,
      };
    } catch (error) {
      const dockerError = error as DockerError;
      if (dockerError.statusCode !== 404) {
        logger.warn('[NetworkManager] Error checking existing network:', error);
        return {
          name: this.networkName,
          ipv6Address: null,
          created: false,
        };
      }
    }

    // Create new IPv6 network
    try {
      // Generate unique subnet based on identifier hash
      const identifierHash = Math.abs(this.identifier.split('').reduce((acc: number, char: string) => {
        acc = ((acc << 5) - acc) + char.charCodeAt(0);
        return acc & acc;
      }, 0));

      // Use a /64 subnet from ULA range (fd00::/8)
      // Each identifier gets a different /64 for maximum address space
      const subnetPrefix = identifierHash % 65536; // 0-65535
      const subnetPrefixHex = subnetPrefix.toString(16).padStart(4, '0');

      // Build IPv6 subnet and gateway correctly
      const networkBase = `fd00:${subnetPrefixHex}:dead:beef`;
      const subnet = `${networkBase}::/64`;
      const gateway = `${networkBase}::1`;

      const network = await this.docker.createNetwork({
        Name: this.networkName,
        Driver: 'bridge',
        EnableIPv6: true,
        IPAM: {
          Driver: 'default',
          Config: [
            {
              Subnet: subnet,
              Gateway: gateway,
            },
          ],
        },
        Internal: false,
        Attachable: true,
        Labels: {
          'managed-by': 'pi-research',
          'identifier': this.identifier,
        },
        Options: {
          'com.docker.network.bridge.gateway_mode_ipv6': 'routed', // Docker 27+ routed mode
        },
      });

      const networkId = network.id; // Docker always returns an ID for created networks
      this.networkId = networkId;

      this.ipv6Enabled = true; // CRITICAL: Must set this flag!

      logger.log(`[NetworkManager] Created IPv6 network: ${this.networkName}`);

      return {
        name: this.networkName,
        ipv6Address: `${networkBase}::2`, // Container will get .::2
        created: true,
      };
    } catch (error) {
      logger.error('[NetworkManager] Failed to create IPv6 network:', error);

      // Fallback: try with docker CLI if API fails
      try {
        const { exec } = await import('node:child_process');
        const randomPrefix = Math.floor(Math.random() * 65535).toString(16).padStart(4, '0');
        const subnet = `fd00:dead:beef:${randomPrefix}::/64`;
        const gateway = `fd00:dead:beef:${randomPrefix}::1`;

        await new Promise<void>((resolve, reject) => {
          exec(
            `docker network create --driver bridge --ipv6 --subnet ${subnet} ${this.networkName}`,
            (execError) => {
              if (execError) {
                reject(execError);
              } else {
                resolve();
              }
            },
          );
        });

        logger.log(`[NetworkManager] Created IPv6 network via CLI fallback: ${this.networkName}`);

        this.ipv6Enabled = true; // Set flag when CLI fallback succeeds

        return {
          name: this.networkName,
          ipv6Address: `${gateway.split('::')[0]}::2`,
          created: true,
        };
      } catch (cliError) {
        logger.error('[NetworkManager] Docker CLI fallback also failed:', cliError);
        return {
          name: this.networkName,
          ipv6Address: null,
          created: false,
        };
      }
    }
  }

  /**
   * Get the network name for container assignment
   */
  getNetworkName(): string | null {
    if (!this.ipv6Enabled || this.networkId === null) {
      return null; // Use default bridge network
    }
    return this.networkName;
  }

  /**
   * Remove the IPv6 network
   */
  async removeNetwork(): Promise<void> {
    const networkId = this.networkId;
    if (networkId === null) {
      return;
    }

    try {
      const network = this.docker.getNetwork(networkId);
      await network.remove({ force: true });
      logger.log(`[NetworkManager] Removed IPv6 network: ${this.networkName}`);
    } catch (error) {
      logger.warn('[NetworkManager] Failed to remove network via API, trying CLI...', error);

      // Fallback to CLI
      try {
        const { exec } = await import('node:child_process');
        await new Promise<void>((resolve, reject) => {
          exec(`docker network rm -f ${this.networkName}`, (execError) => {
            if (execError) {
              reject(execError);
            } else {
              resolve();
            }
          });
        });
        logger.log(`[NetworkManager] Removed network via CLI: ${this.networkName}`);
      } catch (cliError) {
        logger.error('[NetworkManager] Failed to remove network via CLI:', cliError);
      }
    } finally {
      this.networkId = null;
    }
  }

  /**
   * Check if IPv6 is available and working
   */
  isIPv6Enabled(): boolean {
    return this.ipv6Enabled;
  }
}
