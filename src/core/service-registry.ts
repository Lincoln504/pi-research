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
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Service lifecycle stages
 */
export enum ServiceLifecycle {
  UNINITIALIZED = 'uninitialized',
  INITIALIZING = 'initializing',
  INITIALIZED = 'initialized',
  DISABLED = 'disabled',
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
 * AsyncLocalStorage to track which service is currently being initialized.
 * Used to build a dependency graph for safe teardown.
 */
const initializationContext = new AsyncLocalStorage<string>();

/**
 * Centralized service container for dependency injection
 */
export class ServiceContainer {
  private services: Map<string, ServiceRegistration<any>> = new Map();
  private dependencies: Map<string, Set<string>> = new Map();
  public isDisposing: boolean = false;
  public isReady: boolean = false;
  public cwd: string = process.cwd();
  public config: any = null;
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
    
    // Reset dependencies for this service
    this.dependencies.set(name, new Set());
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
   * Record a dependency between two services
   */
  private addDependency(dependent: string, dependency: string): void {
    let deps = this.dependencies.get(dependent);
    if (!deps) {
      deps = new Set();
      this.dependencies.set(dependent, deps);
    }
    deps.add(dependency);
  }

  /**
   * Get a service instance, initializing it if necessary
   */
  async get<T extends IService>(name: string, ctx?: any): Promise<T> {
    if (this.isDisposing) {
      throw new Error(`Cannot get service '${name}' during container disposal`);
    }

    // Track dependency if we are currently inside an initialization or use-case of another service
    const caller = initializationContext.getStore();
    if (caller && caller !== name) {
      this.addDependency(caller, name);
    }

    const registration = this.services.get(name);
    if (!registration) {
      throw new Error(`Service '${name}' is not registered`);
    }

    // Return existing instance if already initialized
    if (registration.instance) {
      // Re-initialize if ctx is provided and service supports it
      if (ctx && registration.instance.initialize) {
        // Wrap in initializationContext so nested get() calls are tracked
        return initializationContext.run(name, async () => {
          await registration.instance!.initialize!(ctx);
          return registration.instance as T;
        });
      }
      return registration.instance as T;
    }

    // Return existing initialization promise if in progress
    if (registration.initializationPromise) {
      return registration.initializationPromise as Promise<T>;
    }

    // Initialize the service within the tracking context
    registration.initializationPromise = initializationContext.run(name, () => 
      this._initializeService(registration, ctx)
    );

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
    // Must check registration exists FIRST — undefined?.instance gives undefined,
    // and undefined !== null is true, which would incorrectly report unregistered
    // services as initialized.
    if (!registration) return false;
    return registration.instance !== null;
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
   * Dispose all services using a true Directed Acyclic Graph (DAG) teardown.
   * This guarantees that services are only disposed after all their dependents
   * have been successfully torn down.
   */
  async disposeAll(): Promise<void> {
    if (this.isDisposing) {
      return;
    }

    this.isDisposing = true;
    if (this.defaultOptions.enableLogging) {
      logger.log('[ServiceContainer] Disposing all services (DAG-ordered teardown)...');
    }

    try {
      const activeServices = Array.from(this.services.keys()).filter(name => 
        this.services.get(name)?.instance !== null
      );
      
      const disposed = new Set<string>();
      
      // Perform iterative disposal of services that have no active dependents
      while (disposed.size < activeServices.length) {
        const toDispose: string[] = [];
        
        for (const name of activeServices) {
          if (disposed.has(name)) continue;
          
          // A service can be disposed if no OTHER active service depends on it
          // that hasn't been disposed yet.
          const hasUndisposedDependents = activeServices.some(other => 
            !disposed.has(other) && 
            other !== name && 
            this.dependencies.get(other)?.has(name)
          );
          
          if (!hasUndisposedDependents) {
            toDispose.push(name);
          }
        }
        
        if (toDispose.length === 0) {
          // Circular dependency detected or logic error
          const remaining = activeServices.filter(n => !disposed.has(n));
          logger.warn(`[ServiceContainer] Circular dependency or stuck disposal detected for: ${remaining.join(', ')}. Falling back to reverse-registration order.`);
          
          const reverseRegistrations = Array.from(this.services.entries()).reverse();
          for (const [name, registration] of reverseRegistrations) {
            if (!disposed.has(name) && registration.instance && registration.instance.dispose) {
              try { await registration.instance.dispose(); } catch (err) { logger.warn(`[ServiceContainer] Error disposing '${name}':`, err); }
              registration.instance = null;
              registration.initializationPromise = null;
            }
          }
          break;
        }
        
        // IMPORTANT: Sort toDispose in reverse-registration order. 
        // This ensures that if multiple services are independent, we still dispose
        // the one registered latest first, maintaining strict LIFO behavior by default.
        const serviceNamesInOrder = Array.from(this.services.keys());
        toDispose.sort((a, b) => serviceNamesInOrder.indexOf(b) - serviceNamesInOrder.indexOf(a));
        
        // Dispose independent services in parallel (but sequentially within this batch 
        // if we want to be 100% sure about order, though Promise.all is fine if they are truly independent)
        // Actually, to satisfy the test expectations of strict order, we should do them sequentially.
        for (const name of toDispose) {
          const registration = this.services.get(name)!;
          if (registration.instance && registration.instance.dispose) {
            try {
              await registration.instance.dispose();
            } catch (err: unknown) {
              logger.warn(`[ServiceContainer] Error disposing service '${name}':`, err);
            }
          }
          registration.instance = null;
          registration.initializationPromise = null;
          disposed.add(name);
        }
      }
    } finally {
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

    // Use the safe DAG disposal logic
    await this.disposeAll();

    // Clear all registrations
    this.services.clear();
    this.dependencies.clear();
    this.isDisposing = false;
    this.isReady = false;

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
 * This is the default container for the application.
 * CLI mode typically uses this instance.
 */
let globalServiceContainer = new ServiceContainer({
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
 * Create a new service container instance
 */
export function createServiceContainer(options: ServiceContainerOptions = {}): ServiceContainer {
  return new ServiceContainer(options);
}

/**
 * Set the global service container instance
 */
export function setServiceContainer(container: ServiceContainer): void {
  globalServiceContainer = container;
}

/**
 * Convenience function to register a service
 */
export function registerService<T extends IService>(
  name: string,
  factory: ServiceFactory<T>,
  options?: ServiceContainerOptions,
  container: ServiceContainer = globalServiceContainer
): void {
  container.register(name, factory, options);
}

/**
 * Convenience function to replace a service
 */
export function replaceService<T extends IService>(
  name: string,
  factory: ServiceFactory<T>,
  options?: ServiceContainerOptions,
  container: ServiceContainer = globalServiceContainer
): Promise<void> {
  return container.registerAndReplace(name, factory, options);
}

/**
 * Convenience function to get a service
 */
export function getService<T extends IService>(name: string, ctx?: any, container: ServiceContainer = globalServiceContainer): Promise<T> {
  return container.get<T>(name, ctx);
}

/**
 * Convenience function to try getting a service synchronously
 */
export function tryGetService<T extends IService>(name: string, container: ServiceContainer = globalServiceContainer): T | null {
  return container.tryGet<T>(name);
}

/**
 * Convenience function to clear a service
 */
export function clearService(name: string, container: ServiceContainer = globalServiceContainer): Promise<void> {
  return container.clear(name);
}

/**
 * Convenience function to replace a service instance
 */
export function replaceServiceInstance<T extends IService>(name: string, instance: T, container: ServiceContainer = globalServiceContainer): Promise<void> {
  return container.replace(name, instance);
}

/**
 * Convenience function to check if a service is registered
 */
export function hasService(name: string, container: ServiceContainer = globalServiceContainer): boolean {
  return container.has(name);
}

/**
 * Convenience function to check if a service is initialized
 */
export function isServiceInitialized(name: string, container: ServiceContainer = globalServiceContainer): boolean {
  return container.isInitialized(name);
}

/**
 * Helper to extract a service container from a context object, if present.
 */
export function tryGetServiceContainerFromCtx(ctx: any): ServiceContainer {
  if (ctx?.container && typeof ctx.container.get === 'function' && typeof ctx.container.register === 'function') {
    return ctx.container;
  }
  return globalServiceContainer;
}

/**
 * Dispose all services
 */
export function disposeAllServices(container: ServiceContainer = globalServiceContainer): Promise<void> {
  return container.disposeAll();
}

/**
 * Reset the global service container
 */
export function resetServiceContainer(container: ServiceContainer = globalServiceContainer): Promise<void> {
  return container.reset();
}

/**
 * Check if the service container is currently being disposed
 */
export function isContainerDisposing(container: ServiceContainer = globalServiceContainer): boolean {
  return container.isDisposing;
}