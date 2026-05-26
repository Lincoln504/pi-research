/**
 * Scheduler Service Interfaces
 */

import type { IService } from '../service-registry.ts';
import type { Config } from '../../config.ts';

/**
 * Minimal scheduler instance interface — the raw scheduler object returned
 * by the factory and stored inside SchedulerService.
 */
export interface ISchedulerInstance {
  shutdown(): Promise<void>;
  schedulerId?: string;
}

/**
 * Internal state management methods exposed by SchedulerService.
 * Used by browser-lifecycle.ts and the infrastructure scheduler factory to manage
 * scheduler instance state without creating a circular import on the SchedulerService class.
 * Extends IService so it satisfies the tryGetService<T extends IService> constraint.
 */
export interface ISchedulerInternals extends IService {
  getSchedulerInstance(): ISchedulerInstance | null;
  setSchedulerInstance(instance: ISchedulerInstance | null): void;
  getSchedulerVersion(): string | null;
  setSchedulerVersion(version: string | null): void;
  getSchedulerInitializationPromise(): Promise<ISchedulerInstance> | null;
  setSchedulerInitializationPromise(promise: Promise<ISchedulerInstance> | null): void;
  getPendingShutdownPromise(): Promise<void> | null;
  setPendingShutdownPromise(promise: Promise<void> | null): void;
  isSchedulerRestartInProgress(): boolean;
  setSchedulerRestartInProgress(inProgress: boolean): void;
}

/**
 * Scheduler search result — matches the shape returned by the browser
 * infrastructure layer (BrowserTaskScheduler / BrowserClient).
 */
export interface SearchResult {
  title: string;
  url: string;
  content: string;
  engine?: string;
  score?: number;
}

/**
 * Base scheduler interface
 */
export interface IScheduler {
  runSearch(query: string, config?: Config): Promise<any[]>;
  runScrape(url: string, config?: Config): Promise<any>;
  runHealthCheck(config?: Config): Promise<{ success: boolean }>;
  shutdown(): Promise<void>;
  resetIdleTimerOnActivity?(): void;
  schedulerId?: string;
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