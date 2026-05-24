# Health Check API

## Overview

The Health Check system provides comprehensive health monitoring for all pi-research components, including browser infrastructure, knowledge store, and network connectivity. It supports both programmatic access and CLI commands.

## Installation

The health check system is included in `@lincoln504/pi-research`:

```bash
pi install npm:@lincoln504/pi-research
```

## Quick Start

### Using from pi CLI

```bash
# Run all health checks
/health

# Clear health check cache
/health-clear

# View health check history
/health-history

# Or use the consolidated command
/research-config health run
/research-config health clear
/research-config health history
```

### Using Programmatically

```typescript
import { healthRegistry } from '@lincoln504/pi-research';

const result = await healthRegistry.runAll();

if (result.status === 'healthy') {
  console.log('All systems operational');
} else {
  console.log('Degraded or unhealthy components:', result.components);
}
```

## API Reference

### Main Classes

#### `HealthRegistry`

```typescript
class HealthRegistry
```

Manages health check registration and execution.

**Methods:**

##### `register`

```typescript
register(check: HealthCheck): void
```

Registers a health check.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| check | `HealthCheck` | Yes | Health check to register |

**Example:**

```typescript
import { healthRegistry } from '@lincoln504/pi-research';

healthRegistry.register({
  id: 'my-component',
  name: 'My Component',
  check: async () => {
    // Perform health check
    return { healthy: true, message: 'OK' };
  }
});
```

##### `runAll`

```typescript
async runAll(): Promise<HealthCheckResult>
```

Runs all registered health checks.

**Returns:** `Promise<HealthCheckResult>`

**Example:**

```typescript
const result = await healthRegistry.runAll();
console.log(`Status: ${result.status}`);
```

##### `run`

```typescript
async run(id: string): Promise<HealthCheckComponent>
```

Runs a specific health check by ID.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | `string` | Yes | Health check ID |

**Returns:** `Promise<HealthCheckComponent>`

**Example:**

```typescript
const browserHealth = await healthRegistry.run('browser');
console.log(browserHealth.healthy ? 'Browser OK' : 'Browser unhealthy');
```

##### `getHistory`

```typescript
getHistory(): HealthCheckHistory[]
```

Returns the health check history.

**Returns:** `HealthCheckHistory[]`

**Example:**

```typescript
const history = healthRegistry.getHistory();
const lastCheck = history[history.length - 1];
console.log(`Last check: ${lastCheck.timestamp}`);
```

##### `clearHistory`

```typescript
clearHistory(): void
```

Clears the health check history.

**Example:**

```typescript
healthRegistry.clearHistory();
```

##### `clearCache`

```typescript
clearCache(): void
```

Clears cached health check results.

**Example:**

```typescript
healthRegistry.clearCache();
```

---

### Built-in Health Checks

The following health checks are registered by default:

#### `browser`

Checks browser infrastructure health including worker pool and stealth browser instances.

**Implementation:** `src/healthcheck/browser-check.ts`

**What it checks:**
- Worker pool status
- Browser instance availability
- Stealth capabilities

#### `knowledge-store`

Checks knowledge store health including database connection and embedding model.

**Implementation:** `src/healthcheck/knowledge-check.ts`

**What it checks:**
- Database connection
- Embedding model availability
- Read/write operations

#### `network`

Checks network connectivity including DNS resolution and HTTP connectivity.

**Implementation:** `src/healthcheck/network-check.ts`

**What it checks:**
- DNS resolution
- HTTP connectivity to common endpoints
- Proxy configuration (if applicable)

#### `env`

Checks environment configuration including required variables and validity.

**Implementation:** `src/healthcheck/env-check.ts`

**What it checks:**
- Required environment variables
- Variable value validity
- Configuration consistency

---

### Types

#### `HealthCheck`

```typescript
interface HealthCheck {
  id: string;
  name: string;
  check: () => Promise<HealthCheckComponent>;
  timeout?: number;
  critical?: boolean;
}
```

#### `HealthCheckComponent`

```typescript
interface HealthCheckComponent {
  component: string;
  healthy: boolean;
  message: string;
  details?: Record<string, unknown>;
  duration?: number;
  timestamp?: Date;
}
```

#### `HealthCheckResult`

```typescript
interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  components: HealthCheckComponent[];
  summary: string;
  timestamp: Date;
}
```

#### `HealthCheckHistory`

```typescript
interface HealthCheckHistory {
  timestamp: Date;
  status: 'healthy' | 'degraded' | 'unhealthy';
  components: HealthCheckComponent[];
}
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | `30000` | Health check timeout in ms (range: 20000-120000) |

### Configuration API

```typescript
import { getConfig, setConfig } from '@lincoln504/pi-research';

// Get health check timeout
const config = getConfig();
console.log(config.HEALTH_CHECK_TIMEOUT_MS);

// Set health check timeout
setConfig({ HEALTH_CHECK_TIMEOUT_MS: 45000 });
```

---

## Examples

### Running All Health Checks

```typescript
import { healthRegistry } from '@lincoln504/pi-research';

const result = await healthRegistry.runAll();

if (result.status === 'healthy') {
  console.log('✅ All systems operational');
} else if (result.status === 'degraded') {
  console.log('⚠️ Some components degraded:');
  result.components
    .filter(c => !c.healthy)
    .forEach(c => console.log(`  - ${c.component}: ${c.message}`));
} else {
  console.log('❌ System unhealthy');
}
```

### Running Specific Health Check

```typescript
import { healthRegistry } from '@lincoln504/pi-research';

const browserHealth = await healthRegistry.run('browser');

if (browserHealth.healthy) {
  console.log('✅ Browser infrastructure OK');
} else {
  console.log('❌ Browser infrastructure issue:');
  console.log(browserHealth.message);
  if (browserHealth.details) {
    console.log('Details:', browserHealth.details);
  }
}
```

### Registering Custom Health Check

```typescript
import { healthRegistry } from '@lincoln504/pi-research';

healthRegistry.register({
  id: 'custom-api',
  name: 'Custom API',
  critical: true,
  check: async () => {
    const start = Date.now();
    try {
      const response = await fetch('https://api.example.com/health');
      if (response.ok) {
        return {
          component: 'Custom API',
          healthy: true,
          message: 'API responding',
          duration: Date.now() - start
        };
      } else {
        return {
          component: 'Custom API',
          healthy: false,
          message: `API returned ${response.status}`,
          duration: Date.now() - start
        };
      }
    } catch (error) {
      return {
        component: 'Custom API',
        healthy: false,
        message: `API error: ${error.message}`,
        duration: Date.now() - start
      };
    }
  }
});
```

### Viewing Health Check History

```typescript
import { healthRegistry } from '@lincoln504/pi-research';

const history = healthRegistry.getHistory();

console.log('Recent health checks:');
history.slice(-5).forEach(entry => {
  const icon = entry.status === 'healthy' ? '✅' :
                entry.status === 'degraded' ? '⚠️' : '❌';
  console.log(`${icon} ${entry.timestamp.toISOString()} - ${entry.status}`);
});
```

### Using Health Checks in Startup Sequence

```typescript
import { healthRegistry } from '@lincoln504/pi-research';

async function startup() {
  console.log('Running startup health checks...');

  const result = await healthRegistry.runAll();

  if (result.status === 'unhealthy') {
    console.error('Critical health check failures. Aborting startup.');
    process.exit(1);
  }

  if (result.status === 'degraded') {
    console.warn('Some components degraded. Starting with reduced functionality.');
    // Configure degraded mode
  }

  console.log('Health checks passed. Starting application...');
  // Start application
}

startup();
```

---

## Best Practices

1. **Run health checks at startup:**
   ```typescript
   const health = await healthRegistry.runAll();
   if (health.status === 'unhealthy') {
     process.exit(1);
   }
   ```

2. **Use health checks before critical operations:**
   ```typescript
   const browserHealth = await healthRegistry.run('browser');
   if (!browserHealth.healthy) {
     throw new Error('Browser infrastructure unavailable');
   }
   ```

3. **Set appropriate timeouts:**
   ```typescript
   healthRegistry.register({
     id: 'slow-check',
     name: 'Slow Check',
     timeout: 60000, // 60 seconds
     check: async () => { /* ... */ }
   });
   ```

4. **Mark critical checks:**
   ```typescript
   healthRegistry.register({
     id: 'critical-component',
     name: 'Critical Component',
     critical: true,
     check: async () => { /* ... */ }
   });
   ```

5. **Clear cache before important checks:**
   ```typescript
   healthRegistry.clearCache();
   const result = await healthRegistry.runAll();
   ```

---

## Related

- [Architecture Overview](../architecture/overview.md)
- [Research Tool API](./research-tool.md)
- [Knowledge Store API](./knowledge-store.md)
- [Troubleshooting Guide](../guides/troubleshooting.md)

---

**Last Updated:** 2026-05-23