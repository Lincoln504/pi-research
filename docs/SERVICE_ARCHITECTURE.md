# Service Architecture

## Overview

`pi-research` uses a **Service Registry pattern** with **Constructor-based Dependency Injection**. This document explains how services are registered, initialized, and used throughout the application.

## Service Registry

The service registry (`src/core/service-registry.ts`) is a centralized dependency injection container that manages all application services.

### Key Features

- **Centralized Management**: All services registered in one place
- **Lazy Initialization**: Services initialize on first access (unless configured as eager)
- **Lifecycle Management**: Services follow init → use → dispose cycle
- **Type Safety**: Full TypeScript support with `getService<T>()`
- **Error Resilience**: Failed initialization doesn't crash the extension
- **Testability**: Services can be mocked or replaced for testing

### Core Concepts

```typescript
// All services implement the IService interface
interface IService {
  readonly name: string;
  readonly lifecycle: ServiceLifecycle;
  initialize?(): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

// Service lifecycle stages
enum ServiceLifecycle {
  UNINITIALIZED = 'uninitialized',
  INITIALIZING = 'initializing',
  INITIALIZED = 'initialized',
  DISPOSING = 'disposing',
  DISPOSED = 'disposed',
}
```

## Registered Services

The following services are registered with the service registry:

### Core Services (`src/core/`)

| Service Name | Class | Purpose | Initialization |
|--------------|-------|---------|----------------|
| `scheduler` | `SchedulerService` | Browser task scheduling | Lazy |
| `planning` | `PlanningService` | AI-powered research planning | Eager |

### Infrastructure Services (`src/infrastructure/`)

| Service Name | Class | Purpose | Initialization |
|--------------|-------|---------|----------------|
| `scheduler-factory` | `SchedulerFactoryService` | Creates scheduler instances | Eager |
| `health-check-cache` | `HealthCheckService` | Health check caching with backoff | Eager |
| `state-manager` | `StateManagerService` | Cross-process state management | Eager |
| `knowledge-store` | `KnowledgeStoreService` | Vector embeddings and RAG | Lazy |
| `writer-queue` | `WriterQueue` | Async write queue for knowledge store | Lazy |
| `metrics` | `MetricsService` | Metrics collection (counters, gauges) | Eager |
| `process-lifecycle` | `ProcessLifecycleService` | Process signal handling | Eager |
| `file-lock-service` | `FileLockService` | File-based locking | Lazy |
| `gpu-resource-service` | `GPUResourceService` | GPU resource management | Lazy |
| `state-session-manager` | `StateSessionManager` | Session lifecycle management | Lazy |
| `state-browser-manager` | `StateBrowserManager` | Browser state management | Lazy |
| `state-backup-manager` | `StateBackupManager` | State backup/restore | Lazy |
| `state-metrics-collector` | `StateMetricsCollector` | State metrics collection | Lazy |
| `state-validator` | `StateValidator` | State validation | Lazy |
| `worker-pool-manager` | `WorkerPoolManager` | Browser worker pool | Lazy |
| `research-session-service` | `ResearchSessionService` | Research session tracking | Lazy |
| `research-synthesis-service` | `ResearchSynthesisService` | Result synthesis | Lazy |

## Service Lifecycle

### Registration Phase

Services are registered during extension activation in `src/index.ts`:

```typescript
import { registerInfrastructureServices } from './infrastructure/service-initialization.ts';
import { registerCoreServices } from './core/service-initialization.ts';

// Register services (synchronous, fast)
registerInfrastructureServices();
registerCoreServices();
```

### Initialization Phase

Services initialize in dependency order. This happens asynchronously after registration:

```typescript
// Initialize services (asynchronous, fire-and-forget)
(async () => {
  await initializeInfrastructureServices();
  await initializeCoreServices();
})();
```

### Usage Phase

Services are accessed through the service registry:

```typescript
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';

// Get a service (initializes if needed)
const schedulerService = await getService<IScheduler>(ServiceNames.SCHEDULER);

// Use the service
const results = await schedulerService.runSearch('query');
```

### Disposal Phase

Services are disposed in reverse dependency order during shutdown:

```typescript
import { disposeAllServices } from '../core/service-registry.ts';

// Dispose all services (reverse dependency order)
await disposeAllServices();
```

## Constructor Dependency Injection

All services use constructor-based dependency injection. Dependencies are resolved by the service registry and passed to the service constructor.

### Example: SchedulerService

```typescript
// Service class with constructor injection
class SchedulerService implements IScheduler {
  constructor(
    private readonly stateManager: IStateManager,
    private readonly metrics: IMetrics,
    private readonly logger: Logger,
  ) {}

  async runSearch(query: string): Promise<SearchResult> {
    // Use dependencies
    this.metrics.increment('search.requests');
    const state = await this.stateManager.readState();
    // ... rest of implementation
  }
}

// Factory function resolves dependencies
registerService(
  ServiceNames.SCHEDULER,
  async () => {
    const stateManager = await getService<IStateManager>(ServiceNames.STATE_MANAGER);
    const metrics = await getService<IMetrics>(ServiceNames.METRICS);
    const logger = await getService<Logger>(ServiceNames.LOGGER);
    return new SchedulerService(stateManager, metrics, logger);
  },
  { lazyInitialization: true }
);
```

### Dependency Order

Services are initialized in this order to satisfy dependencies:

1. **ProcessLifecycleService** — No dependencies (core infrastructure)
2. **StatePathConfiguration** — No dependencies (core infrastructure)
3. **MetricsService** — No dependencies
4. **StateManagerService** — Depends on StatePathConfiguration, FileLockService
5. **SchedulerFactoryService** — Depends on StateManagerService
6. **SchedulerService** — Depends on SchedulerFactoryService
7. **HealthCheckService** — No dependencies
8. **KnowledgeStoreService** — Depends on StateManagerService, GPUResourceService
9. **PlanningService** — Depends on KnowledgeStoreService

## How to Add a New Service

### Step 1: Define the Service Interface

Create or extend an interface in `src/core/interfaces/`:

```typescript
// src/core/interfaces/my-service-interfaces.ts
export interface IMyService extends IService {
  doSomething(input: string): Promise<string>;
}
```

### Step 2: Implement the Service

Create the service implementation:

```typescript
// src/core/my-service.ts
import type { IMyService } from './interfaces/my-service-interfaces.ts';

export class MyService implements IMyService {
  readonly name = 'my-service';

  constructor(
    private readonly dependency: ISomeOtherService,
  ) {}

  async initialize(): Promise<void> {
    // Optional initialization logic
  }

  async doSomething(input: string): Promise<string> {
    // Implementation
    return `processed: ${input}`;
  }

  async dispose(): Promise<void> {
    // Optional cleanup logic
  }
}
```

### Step 3: Add Service Name

Add the service name to `src/core/interfaces/service-names.ts`:

```typescript
export const ServiceNames = {
  // ... existing services
  MY_SERVICE: 'my-service',
} as const;
```

### Step 4: Register the Service

Add registration to `src/infrastructure/service-initialization.ts` or `src/core/service-initialization.ts`:

```typescript
import { MyService } from './my-service.ts';

registerService(
  ServiceNames.MY_SERVICE,
  async () => {
    const dependency = await getService<ISomeOtherService>(ServiceNames.SOME_OTHER_SERVICE);
    return new MyService(dependency);
  },
  {
    lazyInitialization: true,  // Set to false for eager initialization
    allowOverwrite: false,
    enableLogging: true,
  }
);
```

### Step 5: Use the Service

Access the service from anywhere in the application:

```typescript
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';

const myService = await getService<IMyService>(ServiceNames.MY_SERVICE);
const result = await myService.doSomething('test');
```

## Dependency Injection Patterns

### Pattern 1: Simple Constructor Injection

```typescript
class MyService implements IService {
  constructor(
    private readonly dep1: IDep1,
    private readonly dep2: IDep2,
  ) {}
}
```

### Pattern 2: Async Factory Initialization

```typescript
registerService(
  ServiceNames.MY_SERVICE,
  async () => {
    const dep1 = await getService<IDep1>(ServiceNames.DEP1);
    const dep2 = await getService<IDep2>(ServiceNames.DEP2);
    // Perform async setup
    const config = await loadConfig();
    return new MyService(dep1, dep2, config);
  }
);
```

### Pattern 3: Optional Dependencies

```typescript
class MyService implements IService {
  constructor(
    private readonly required: IRequiredService,
    optional?: IOptionalService,
  ) {
    this.optional = optional ?? createDefaultImplementation();
  }
}
```

### Pattern 4: Lazy Service Resolution

For performance, resolve dependencies lazily within the service:

```typescript
class MyService implements IService {
  private _heavyDependency?: IHeavyService;

  get heavyDependency(): Promise<IHeavyService> {
    if (!this._heavyDependency) {
      this._heavyDependency = getService<IHeavyService>(ServiceNames.HEAVY);
    }
    return this._heavyDependency;
  }

  async doWork(): Promise<void> {
    const heavy = await this.heavyDependency;
    // Use heavy dependency
  }
}
```

## Service Registry API

### Registration

```typescript
// Register a service
registerService<T extends IService>(
  name: string,
  factory: ServiceFactory<T>,
  options?: ServiceContainerOptions
): void

// Replace an existing service
replaceService<T extends IService>(
  name: string,
  factory: ServiceFactory<T>,
  options?: ServiceContainerOptions
): void
```

### Access

```typescript
// Get a service (async, initializes if needed)
getService<T extends IService>(name: string): Promise<T>

// Try to get a service (sync, returns null if not initialized)
tryGetService<T extends IService>(name: string): T | null

// Check if a service is registered
hasService(name: string): boolean

// Check if a service is initialized
isServiceInitialized(name: string): boolean
```

### Lifecycle

```typescript
// Dispose all services
disposeAllServices(): Promise<void>

// Reset the container (for testing)
resetServiceContainer(): void

// Check if container is disposing
isContainerDisposing(): boolean
```

## Testing with Services

The service registry makes testing easy by allowing service replacement:

```typescript
import { resetServiceContainer, registerService, getService } from '../core/service-registry.ts';

// Reset container before each test
beforeEach(() => {
  resetServiceContainer();
});

// Register a mock service
registerService(
  ServiceNames.MY_SERVICE,
  () => new MockMyService()
);

// Use in test
const service = await getService<IMyService>(ServiceNames.MY_SERVICE);
expect(service.doSomething('test')).toBe('mocked: test');
```

## Best Practices

1. **Prefer lazy initialization** for heavy services
2. **Use constructor injection** for required dependencies
3. **Implement dispose()** for services that hold resources
4. **Keep services focused** — single responsibility principle
5. **Use TypeScript interfaces** for all service contracts
6. **Register services in dependency order** (registry handles this)
7. **Handle initialization errors gracefully** — don't crash
8. **Use the service registry** — avoid direct imports of service implementations

## Troubleshooting

### Service Not Found Error

```
Error: Service 'my-service' is not registered
```

**Solution**: Ensure the service is registered in `service-initialization.ts`

### Circular Dependency

```
Error: Circular dependency detected
```

**Solution**: Use lazy service resolution or refactor to break the cycle

### Initialization Timeout

```
Error: Service 'my-service' initialization timed out
```

**Solution**: Check for blocking async operations in `initialize()` method

---

**See Also:**
- [ARCHITECTURE.md](ARCHITECTURE.md) — Overall system architecture
- [service-implementations-summary.md](service-implementations-summary.md) — Detailed service implementation notes