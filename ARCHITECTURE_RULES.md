# Architectural Layers and Boundaries

## Layer Hierarchy

```
CLI Layer (Commands, TUI)
    ↓
Orchestration Layer (Research coordination, session management)
    ↓
Core Layer (Service interfaces, domain logic, service implementations)
    ↓
Infrastructure Layer (Browser, state, file system, external APIs)
```

## Layer Responsibilities

### CLI Layer
- **Location:** `src/commands/`, `src/tui/`
- **Responsibilities:** User interaction, command handling, UI display
- **Dependencies:** May import from Orchestration layer only

### Orchestration Layer  
- **Location:** `src/orchestration/`
- **Responsibilities:** Research coordination, session management, multi-agent orchestration
- **Dependencies:** May import from Core layer (interfaces and services) only
- **Forbidden:** NO direct imports from Infrastructure layer

### Core Layer
- **Location:** `src/core/`, `src/knowledge/`, `src/security/`, `src/utils/`
- **Responsibilities:** Domain logic, service interfaces, business rules
- **Dependencies:** May import from Infrastructure layer ONLY via interfaces
- **Forbidden:** NO direct implementation imports from Infrastructure

### Infrastructure Layer
- **Location:** `src/infrastructure/`, `src/web-research/`
- **Responsibilities:** Browser management, file I/O, external API calls, state persistence
- **Dependencies:** May import from no higher layers (only utilities/types)
- **Forbidden:** NO imports from Orchestration, Core, or CLI layers

## Allowed Cross-Layer Imports

### Core → Infrastructure
- ❌ **NOT ALLOWED:** Direct implementation imports
- ✅ **ALLOWED:** Interface imports (type-only)
- ✅ **ALLOWED:** Service registry access (via `getService<T>()`)

### Orchestration → Infrastructure  
- ❌ **NOT ALLOWED:** Any direct imports
- ✅ **ALLOWED:** Service registry access (via `getService<T>()`)
- ✅ **ALLOWED:** Interface imports from Core layer

### Orchestration → Core
- ✅ **ALLOWED:** Service interface imports
- ✅ **ALLOWED:** Service registry access
- ⚠️ **DISCOURAGED:** Direct implementation imports (prefer interfaces)

### CLI → Orchestration
- ✅ **ALLOWED:** Service and orchestrator imports
- ✅ **ALLOWED:** Tool and command imports

### CLI → Core
- ✅ **ALLOWED:** Service registry access
- ✅ **ALLOWED:** Interface imports

### Infrastructure → Higher Layers
- ❌ **NOT ALLOWED:** No imports from higher layers

## Architectural Patterns

### Service Pattern
All services should:
1. Implement an interface from `src/core/service-interfaces.ts`
2. Be registered in the service registry
3. Have `initialize()` and `dispose()` methods
4. Be accessed via `getService<T>(ServiceNames.X)`

### Adapter Pattern
Core services may wrap infrastructure implementations:
- Example: `StateManagerService` wraps `infrastructure/state-manager.ts`
- This is acceptable as it provides a clean interface
- The infrastructure code remains in its own layer

### Facade Pattern
- ❌ **ELIMINATED:** Facade patterns should be removed
- ✅ **REPLACED WITH:** Direct service access via ServiceRegistry

### Fallback Pattern
- ❌ **ELIMINATED:** Fail-fast behavior should be used instead
- ✅ **REPLACED WITH:** Throw errors immediately when services are unavailable

## Module System Rules

### Import Style
- ✅ **REQUIRED:** Use ES6 static imports: `import { X } from './module.ts'`
- ❌ **FORBIDDEN:** Use dynamic imports: `const { X } = await import('./module.ts')`

### Exceptions to Dynamic Import Rule
Dynamic imports are ONLY allowed for:
1. Optional dependencies: `const lancedb = await import('@lancedb/lancedb')`
2. WASM modules: `const { WasmPdfDocument } = await import('pdf-oxide-wasm')`
3. Breaking circular dependencies (as last resort)

### File Extensions
- ✅ **REQUIRED:** Use `.ts` extensions for TypeScript files
- ❌ **FORBIDDEN:** Use `.mjs` or `.cjs` extensions in source code

## File Size Rules

- ✅ **REQUIRED:** All source files must be under 500 lines
- ✅ **REQUIRED:** If a file exceeds 500 lines, it must be split
- ✅ **REQUIRED:** Each file should have a single responsibility

## Testing Rules

### Unit Tests
- ✅ **REQUIRED:** Test each service in isolation
- ✅ **REQUIRED:** Mock all dependencies
- ✅ **REQUIRED:** Use service registry for service injection

### Integration Tests
- ✅ **REQUIRED:** Test service interactions
- ✅ **REQUIRED:** Test cross-layer communication
- ✅ **REQUIRED:** Test error scenarios

### Contract Tests
- ✅ **REQUIRED:** Each service should have contract tests
- ✅ **REQUIRED:** Verify interface compliance
- ✅ **REQUIRED:** Test service lifecycle (initialize, dispose)

## Service Registry Usage

### Registering Services
```typescript
import { registerService } from './core/service-registry.ts';
import { ServiceNames } from './core/service-interfaces.ts';

registerService(
  ServiceNames.MY_SERVICE,
  () => new MyService(),
  { lazyInitialization: true, allowOverwrite: false, enableLogging: true }
);
```

### Accessing Services
```typescript
import { getService } from './core/service-registry.ts';
import { ServiceNames } from './core/service-interfaces.ts';

const service = await getService<IMyService>(ServiceNames.MY_SERVICE);
```

### Disposing Services
```typescript
import { disposeAllServices } from './core/service-registry.ts';

await disposeAllServices();
```

## Interface Segregation

### Interface Definition
All services must implement an interface defined in `src/core/service-interfaces.ts`:
```typescript
export interface IMyService extends IService {
  // Service-specific methods
  doSomething(input: string): Promise<Result>;
}

export const ServiceNames = {
  MY_SERVICE: 'my-service',
  // ... other service names
} as const;
```

### Implementation
```typescript
export class MyService implements IMyService {
  readonly name = 'MyService';
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  async initialize(): Promise<void> {
    // Initialization logic
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  async dispose(): Promise<void> {
    // Cleanup logic
    this.lifecycle = ServiceLifecycle.DISPOSED;
  }

  async doSomething(input: string): Promise<Result> {
    // Implementation
  }
}
```

## Circular Dependencies

### Detection
Run: `npx madge --circular src/`

### Resolution
If circular dependencies are found:
1. Identify the circular import chain
2. Extract common code to a shared module
3. Use dependency injection to break the cycle
4. Consider using the service registry for lazy resolution

## TypeScript Compilation

### Type Checking
Run: `npx tsc --noEmit`

### Errors
All TypeScript errors must be fixed before:
- Committing code
- Running tests
- Deploying

## Linting

### ESLint Configuration
ESLint should enforce:
- Architectural boundary rules
- Import order and style
- Interface usage
- File size limits
- Code quality standards

### Architectural Linting Rules
```json
{
  "rules": {
    "no-restricted-imports": [
      "error",
      {
        "patterns": [
          {
            "group": ["src/core/**/*", "!src/core/**/types.ts"],
            "message": "Core layer should not import from implementation files. Use interfaces only."
          },
          {
            "group": ["src/orchestration/**/*"],
            "importNames": ["src/infrastructure/**/*"],
            "message": "Orchestration layer should not import directly from Infrastructure. Use ServiceRegistry instead."
          }
        ]
      }
    ]
  }
}
```

## Documentation Requirements

### Service Documentation
Each service must have:
1. Purpose description
2. Interface definition
3. Usage examples
4. Lifecycle documentation
5. Error handling documentation

### Module Documentation
Each module must have:
1. Module purpose
2. Public API documentation
3. Dependencies documentation
4. Usage examples

## Verification Checklist

Before marking architecture as complete, verify:

- [ ] All tests pass (100%)
- [ ] No circular dependencies (madge --circular)
- [ ] No TypeScript errors (tsc --noEmit)
- [ ] All files under 500 lines (find and wc -l)
- [ ] Zero dynamic imports (grep -r "await import")
- [ ] Zero Core → Infrastructure implementation imports
- [ ] Zero Orchestration → Infrastructure imports
- [ ] All services registered in ServiceRegistry
- [ ] All services implement interfaces
- [ ] Zero facade patterns
- [ ] Zero fallback behavior
- [ ] Fail-fast initialization

## Migration Status

### Phase 1: Service Registry Migration
- [ ] Complete service registry usage
- [ ] All services accessed via `getService<T>()`
- [ ] No direct singleton imports
- [ ] Proper lifecycle management

### Phase 2: God Object Decomposition
- [ ] All files under 500 lines
- [ ] Single responsibility per file
- [ ] Clear interfaces for all services

### Phase 3: Clean Architectural Boundaries
- [ ] Core → Infrastructure: interface-only
- [ ] Orchestration → Infrastructure: zero imports
- [ ] Clear layer hierarchy enforced

### Phase 4: Standardize Module System
- [ ] Pure TypeScript (.ts only)
- [ ] Static imports only
- [ ] ESM-only module system

### Phase 5: Interface Segregation
- [ ] Every dependency is an interface
- [ ] ESLint rules enforced
- [ ] Contract tests implemented