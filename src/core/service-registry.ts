/**
 * Service Registry - Centralized Dependency Injection Container
 *
 * This module provides a service registry pattern to manage singleton services
 * throughout the pi-research application. It replaces global state management
 * with a proper dependency injection system.
 *
 * Benefits:
 * - Explicit dependency management
 * - Testability (easy to mock/replace services)
 * - Lifecycle management (init, cleanup)
 * - Type safety
 * - No more globalThis pollution
 */

import { logger } from '../logger.ts';

/**
 * Service lifecycle stages
 */
export enum ServiceLifecycle {
  UNINITIALIZED = 'uninitialized',
  INITIALIZING = 'initializing',
  INITIALIZED = 'initialized',
  DISPOSING = 'disposing',
  DISPOSED = 'disposed',
}

/**
 * Base interface for all services
 */
export interface IService {
  /**
   * Unique identifier for this service
   */
  readonly name: string;

  /**
   * Current lifecycle state
   */
  lifecycle: ServiceLifecycle;

  /**
   * Initialize the service (called before first use)
   */
  initialize?(ctx?: any): Promise<void> | void;

  /**
   * Dispose the service (called during shutdown)
   */
  dispose?(): Promise<void> | void;
}

/**
 * Service factory function type
 */
export type ServiceFactory<T extends IService> = () => T | Promise<T>;

/**
 * Service container options
 */
export interface ServiceContainerOptions {
  /**
   * Whether to initialize services lazily (on first access) or eagerly
   * @default true (lazy initialization)
   */
  lazyInitialization?: boolean;

  /**
   * Whether to allow overwriting existing services
   * @default false (service replacement is not allowed)
   */
  allowOverwrite?: boolean;

  /**
   * Whether to log service lifecycle events
   * @default true
   */
  enableLogging?: boolean;
}

/**
 * Service registration metadata
 */
interface ServiceRegistration<T extends IService> {
  factory: ServiceFactory<T>;
  instance: T | null;
  initializationPromise: Promise<T> | null;
  options: ServiceContainerOptions;
}

/**
 * Centralized service container for dependency injection
 */
class ServiceContainer {
  private services: Map<string, ServiceRegistration<any>> = new Map();
  public isDisposing: boolean = false;
  private readonly defaultOptions: Required<ServiceContainerOptions>;

  constructor(options: ServiceContainerOptions = {}) {
    this.defaultOptions = {
      lazyInitialization: options.lazyInitialization ?? true,
      allowOverwrite: options.allowOverwrite ?? false,
      enableLogging: options.enableLogging ?? true,
    };
  }

  /**
   * Register a service with the container
   */
  register<T extends IService>(
    name: string,
    factory: ServiceFactory<T>,
    options: ServiceContainerOptions = {}
  ): void {
    if (this.isDisposing) {
      throw new Error(`Cannot register service '${name}' during container disposal`);
    }

    const mergedOptions = { ...this.defaultOptions, ...options };

    if (this.services.has(name)) {
      if (!mergedOptions.allowOverwrite) {
        throw new Error(`Service '${name}' is already registered. Use registerAndReplace() to overwrite.`);
      }
      if (mergedOptions.enableLogging) {
        logger.warn(`[ServiceContainer] Replacing service '${name}'`);
      }
    } else {
      if (mergedOptions.enableLogging) {
        logger.debug(`[ServiceContainer] Registering service '${name}'`);
      }
    }

    this.services.set(name, {
      factory,
      instance: null,
      initializationPromise: null,
      options: mergedOptions,
    });
  }

  /**
   * Register a service, replacing any existing service
   */
  async registerAndReplace<T extends IService>(
    name: string,
    factory: ServiceFactory<T>,
    options: ServiceContainerOptions = {}
  ): Promise<void> {
    const mergedOptions = { ...this.defaultOptions, ...options, allowOverwrite: true };
    
    // Dispose existing service if present
    if (this.services.has(name)) {
      const registration = this.services.get(name)!;
      if (registration.instance && registration.instance.dispose) {
        try {
          await registration.instance.dispose();
        } catch (err: unknown) {
          logger.warn(`[ServiceContainer] Error disposing replaced service '${name}':`, err);
        }
      }
    }

    this.register(name, factory, mergedOptions);
  }

  /**
   * Get a service instance, initializing it if necessary
   */
  async get<T extends IService>(name: string, ctx?: any): Promise<T> {
    if (this.isDisposing) {
      throw new Error(`Cannot get service '${name}' during container disposal`);
    }

    const registration = this.services.get(name);
    if (!registration) {
      throw new Error(`Service '${name}' is not registered`);
    }

    // Return existing instance if already initialized
    if (registration.instance) {
      // Re-initialize if ctx is provided and service supports it
      if (ctx && registration.instance.initialize) {
        await registration.instance.initialize(ctx);
      }
      return registration.instance as T;
    }

    // Return existing initialization promise if in progress
    if (registration.initializationPromise) {
      return registration.initializationPromise as Promise<T>;
    }

    // Initialize the service
    registration.initializationPromise = this._initializeService(registration, ctx);

    try {
      const instance = await registration.initializationPromise;
      return instance as T;
    } catch (error) {
      // Clear initialization promise on error so next call retries
      registration.initializationPromise = null;
      throw error;
    }
  }

  /**
   * Get a service instance synchronously (returns null if not initialized)
   */
  tryGet<T extends IService>(name: string): T | null {
    if (this.isDisposing) {
      return null;
    }

    const registration = this.services.get(name);
    if (!registration) {
      return null;
    }

    return registration.instance as T | null;
  }

  /**
   * Check if a service is registered
   */
  has(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * Check if a service is initialized
   */
  isInitialized(name: string): boolean {
    const registration = this.services.get(name);
    return registration?.instance !== null || false;
  }

  /**
   * Clear (reset) a service instance, forcing re-initialization on next access
   */
  async clear(name: string): Promise<void> {
    const registration = this.services.get(name);
    if (!registration) {
      throw new Error(`Service '${name}' is not registered`);
    }

    if (registration.instance && registration.instance.dispose) {
      await registration.instance.dispose().catch((err: unknown) => {
        logger.warn(`[ServiceContainer] Error disposing service '${name}':`, err);
      });
    }

    registration.instance = null;
    registration.initializationPromise = null;

    if (registration.options.enableLogging) {
      logger.debug(`[ServiceContainer] Cleared service '${name}'`);
    }
  }

  /**
   * Replace a service instance with a new one
   */
  async replace<T extends IService>(name: string, newInstance: T): Promise<void> {
    const registration = this.services.get(name);
    if (!registration) {
      throw new Error(`Service '${name}' is not registered`);
    }

    // Dispose old instance if present
    if (registration.instance && registration.instance.dispose) {
      await registration.instance.dispose().catch((err: unknown) => {
        logger.warn(`[ServiceContainer] Error disposing old service '${name}':`, err);
      });
    }

    registration.instance = newInstance;
    registration.initializationPromise = null;

    if (registration.options.enableLogging) {
      logger.debug(`[ServiceContainer] Replaced service '${name}'`);
    }
  }

  /**
   * Dispose all services
   * 
   * NOTE: This method disposes service instances but KEEPS them registered.
   * This allows services to be re-initialized on next access if needed.
   * Use reset() to completely clear the service registry.
   */
  async disposeAll(): Promise<void> {
    if (this.isDisposing) {
      return;
    }

    this.isDisposing = true;
    if (this.defaultOptions.enableLogging) {
      logger.log('[ServiceContainer] Disposing all services (optimized parallel shutdown)...');
    }

    try {
      // Get service registrations in reverse order to respect dependencies
      const registrations = Array.from(this.services.entries()).reverse();

      // We parallelize disposal but group them to maintain SOME order.
      // Infrastructure services (registered early, disposed last) often depend on each other.
      // Orchestration services (registered late, disposed first) are usually more independent.
      
      // Group services into chunks of 3 for parallel disposal to balance speed and safety.
      const CHUNK_SIZE = 3;
      for (let i = 0; i < registrations.length; i += CHUNK_SIZE) {
        const chunk = registrations.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(async ([name, registration]) => {
          if (registration.instance && registration.instance.dispose) {
            try {
              await registration.instance.dispose();
            } catch (err: unknown) {
              logger.warn(`[ServiceContainer] Error disposing service '${name}':`, err);
            }
          }
          // Clear instance but keep registration
          registration.instance = null;
          registration.initializationPromise = null;
        }));
      }
    } finally {
      // Always reset disposal flag even if disposal throws
      // This prevents permanent lock if a service's dispose() method fails
      this.isDisposing = false;
      if (this.defaultOptions.enableLogging) {
        logger.log('[ServiceContainer] All services disposed (registrations preserved)');
      }
    }
  }

  /**
   * Get the number of registered services
   */
  get size(): number {
    return this.services.size;
  }

  /**
   * Get names of all registered services
   */
  getServiceNames(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Get lifecycle state of a service
   */
  getServiceLifecycle(name: string): ServiceLifecycle | null {
    const registration = this.services.get(name);
    if (!registration) {
      return null;
    }

    if (registration.instance) {
      return ServiceLifecycle.INITIALIZED;
    }

    if (registration.initializationPromise) {
      return ServiceLifecycle.INITIALIZING;
    }

    return ServiceLifecycle.UNINITIALIZED;
  }

  /**
   * Reset the container, clearing all services
   * This is primarily used for testing to ensure clean state between test runs
   */
  async reset(): Promise<void> {
    if (this.isDisposing) {
      throw new Error('Cannot reset container while disposing');
    }

    if (this.defaultOptions.enableLogging) {
      logger.debug('[ServiceContainer] Resetting container...');
    }

    // Dispose all instances in reverse order
    const registrations = Array.from(this.services.entries()).reverse();
    for (const [name, registration] of registrations) {
      if (registration.instance && registration.instance.dispose) {
        try {
          await registration.instance.dispose();
        } catch (err) {
          logger.warn(`[ServiceContainer] Error disposing service '${name}' during reset:`, err);
        }
      }
    }

    // Clear all registrations (complete reset, unlike disposeAll)
    this.services.clear();
    this.isDisposing = false;

    if (this.defaultOptions.enableLogging) {
      logger.debug('[ServiceContainer] Container reset complete');
    }
  }

  /**
   * Internal method to initialize a service
   */
  private async _initializeService<T extends IService>(
    registration: ServiceRegistration<T>,
    ctx?: any
  ): Promise<T> {
    let instance: T | null = null;
    try {
      instance = await registration.factory();
      registration.instance = instance;

      // Update lifecycle to initializing
      instance.lifecycle = ServiceLifecycle.INITIALIZING;

      // Call initialize hook if present
      if (instance.initialize) {
        await instance.initialize(ctx);
      }

      // Update lifecycle to initialized
      instance.lifecycle = ServiceLifecycle.INITIALIZED;
      registration.initializationPromise = null;

      if (registration.options.enableLogging) {
        logger.debug(`[ServiceContainer] Service '${instance.name}' initialized`);
      }

      return instance;
    } catch (error) {
      // Clean up instance on failure
      if (instance) {
        instance.lifecycle = ServiceLifecycle.UNINITIALIZED;
        registration.instance = null;
      }
      registration.initializationPromise = null;
      throw error;
    }
  }
}

// ============================================================================
// Global Service Container Instance
// ============================================================================

/**
 * Global service container instance
 * This is the ONLY global state allowed in the application.
 * All other singletons should be registered here and accessed via dependency injection.
 */
const globalServiceContainer = new ServiceContainer({
  lazyInitialization: true,
  allowOverwrite: false,
  enableLogging: true,
});

/**
 * Get the global service container instance
 */
export function getServiceContainer(): ServiceContainer {
  return globalServiceContainer;
}

/**
 * Convenience function to register a service
 */
export function registerService<T extends IService>(
  name: string,
  factory: ServiceFactory<T>,
  options?: ServiceContainerOptions
): void {
  globalServiceContainer.register(name, factory, options);
}

/**
 * Convenience function to replace a service
 */
export function replaceService<T extends IService>(
  name: string,
  factory: ServiceFactory<T>,
  options?: ServiceContainerOptions
): Promise<void> {
  return globalServiceContainer.registerAndReplace(name, factory, options);
}

/**
 * Convenience function to get a service
 */
export function getService<T extends IService>(name: string, ctx?: any): Promise<T> {
  return globalServiceContainer.get<T>(name, ctx);
}

/**
 * Convenience function to try getting a service synchronously
 */
export function tryGetService<T extends IService>(name: string): T | null {
  return globalServiceContainer.tryGet<T>(name);
}

/**
 * Convenience function to clear a service
 */
export function clearService(name: string): Promise<void> {
  return globalServiceContainer.clear(name);
}

/**
 * Convenience function to replace a service instance
 */
export function replaceServiceInstance<T extends IService>(name: string, instance: T): Promise<void> {
  return globalServiceContainer.replace(name, instance);
}

/**
 * Convenience function to check if a service is registered
 */
export function hasService(name: string): boolean {
  return globalServiceContainer.has(name);
}

/**
 * Convenience function to check if a service is initialized
 */
export function isServiceInitialized(name: string): boolean {
  return globalServiceContainer.isInitialized(name);
}

/**
 * Dispose all services
 */
export function disposeAllServices(): Promise<void> {
  return globalServiceContainer.disposeAll();
}

/**
 * Reset the global service container
 * This is primarily used for testing to ensure clean state between test runs
 */
export function resetServiceContainer(): Promise<void> {
  return globalServiceContainer.reset();
}

/**
 * Check if the service container is currently being disposed
 */
export function isContainerDisposing(): boolean {
  return globalServiceContainer.isDisposing;
}