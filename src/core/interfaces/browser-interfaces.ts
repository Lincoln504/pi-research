/**
 * Browser Manager Service Interface
 */

import type { IService } from '../service-registry.ts';
import type { IScheduler } from './scheduler-interfaces.ts';

/**
 * Browser manager service interface
 */
export interface IBrowserManagerService extends IService {
  getScheduler(config?: any): Promise<IScheduler>;
  getSchedulerVersion(config?: any): string;
  forceRestart(forceClearRemoteState?: boolean): Promise<void>;
  isBrowserAvailable(): boolean;
  runTask<T>(task: any, type: 'search' | 'scrape', config?: any, retries?: number): Promise<T>;
  runHealthCheck(config?: any, retries?: number): Promise<{ success: boolean }>;
  stop(): Promise<void>;
}