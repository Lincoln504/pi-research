/**
 * Scheduler Service Interfaces
 */

import type { IService } from '../service-registry.ts';

/**
 * Scheduler search result
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  [key: string]: any;
}

/**
 * Base scheduler interface
 */
export interface IScheduler extends IService {
  runSearch(query: string, config?: any): Promise<SearchResult[]>;
  runScrape(url: string, config?: any): Promise<any>;
  runHealthCheck(config?: any): Promise<{ success: boolean }>;
  shutdown(): Promise<void>;
  resetIdleTimerOnActivity?(): void;
}

/**
 * Scheduler service metadata
 */
export interface SchedulerMetadata {
  schedulerId: string;
  schedulerVersion: string;
  port?: number;
  pid: number;
  isLeader: boolean;
}