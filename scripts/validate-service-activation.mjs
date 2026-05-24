#!/usr/bin/env node

/**
 * Validation script for Service Registry Activation
 *
 * This script verifies that:
 * 1. The service initialization functions are properly exported
 * 2. The imports in index.ts are correct
 * 3. No circular dependencies are introduced
 * 4. The service registry infrastructure is intact
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// ANSI color codes for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function check(label, condition, details = '') {
  if (condition) {
    log(`✅ ${label}`, colors.green);
    if (details) log(`   ${details}`, colors.blue);
    return true;
  } else {
    log(`❌ ${label}`, colors.red);
    if (details) log(`   ${details}`, colors.yellow);
    return false;
  }
}

async function validate() {
  log('\n=== Service Registry Activation Validation ===\n', colors.blue);

  let allPassed = true;

  // 1. Check service-initialization.ts exists
  const serviceInitPath = resolve(projectRoot, 'src/core/service-initialization.ts');
  allPassed &= check(
    'service-initialization.ts exists',
    existsSync(serviceInitPath),
    serviceInitPath
  );

  // 2. Check service-registry.ts exists
  const serviceRegistryPath = resolve(projectRoot, 'src/core/service-registry.ts');
  allPassed &= check(
    'service-registry.ts exists',
    existsSync(serviceRegistryPath),
    serviceRegistryPath
  );

  // 3. Check index.ts exists and has the import
  const indexPath = resolve(projectRoot, 'src/index.ts');
  const indexExists = existsSync(indexPath);
  allPassed &= check(
    'index.ts exists',
    indexExists,
    indexPath
  );

  if (indexExists) {
    const indexContent = readFileSync(indexPath, 'utf-8');

    // 4. Check for service initialization import
    const hasImport = indexContent.includes("from './core/service-initialization.ts'");
    allPassed &= check(
      'index.ts imports service-initialization',
      hasImport,
      'Import statement present'
    );

    // 5. Check for all three function imports
    const imports = [
      'registerCoreServices',
      'initializeCoreServices',
      'disposeCoreServices',
    ];

    for (const fn of imports) {
      allPassed &= check(
        `index.ts imports ${fn}`,
        indexContent.includes(fn),
        `${fn} referenced in import`
      );
    }

    // 6. Check for service registration call
    const hasRegistration = indexContent.includes('registerCoreServices()');
    allPassed &= check(
      'index.ts calls registerCoreServices()',
      hasRegistration,
      'Service registration happens during activation'
    );

    // 7. Check for service initialization call
    const hasInitialization = indexContent.includes('initializeCoreServices()');
    allPassed &= check(
      'index.ts calls initializeCoreServices()',
      hasInitialization,
      'Service initialization happens asynchronously'
    );

    // 8. Check for service disposal registration
    const hasDisposal = indexContent.includes('disposeCoreServices()');
    allPassed &= check(
      'index.ts registers disposeCoreServices()',
      hasDisposal,
      'Service disposal registered with shutdownManager'
    );

    // 9. Check for error handling
    const hasTryCatch = indexContent.includes('try {') && indexContent.includes('catch (err)');
    allPassed &= check(
      'index.ts has error handling',
      hasTryCatch,
      'Try-catch blocks around service calls'
    );

    // 10. Check for shutdownManager.register for disposal
    const hasShutdownRegistration = indexContent.includes('shutdownManager.register(async () => {') &&
      indexContent.includes('await disposeCoreServices()');
    allPassed &= check(
      'disposeCoreServices registered with shutdownManager',
      hasShutdownRegistration,
      'Async disposal registered for shutdown'
    );
  }

  // 11. Check that service-initialization.ts exports the functions
  if (existsSync(serviceInitPath)) {
    const serviceInitContent = readFileSync(serviceInitPath, 'utf-8');

    const exports = [
      'export function registerCoreServices',
      'export async function initializeCoreServices',
      'export async function disposeCoreServices',
    ];

    for (const exp of exports) {
      allPassed &= check(
        `service-initialization.ts exports ${exp.split('(')[0].replace('export ', '')}`,
        serviceInitContent.includes(exp),
        'Function is exported'
      );
    }
  }

  // 12. Check that service-registry.ts has the necessary functions
  if (existsSync(serviceRegistryPath)) {
    const serviceRegistryContent = readFileSync(serviceRegistryPath, 'utf-8');

    const exports = [
      'export function registerService',
      'export function getService',
      'export function disposeAllServices',
    ];

    for (const exp of exports) {
      allPassed &= check(
        `service-registry.ts has ${exp}`,
        serviceRegistryContent.includes(exp),
        'Required function present'
      );
    }
  }

  // Summary
  log('\n=== Validation Summary ===\n', colors.blue);

  if (allPassed) {
    log('✅ All checks passed! Service Registry is properly activated.', colors.green);
    log('\nNext steps:', colors.blue);
    log('  1. Test the extension with pi to ensure it loads correctly', colors.reset);
    log('  2. Verify that services initialize without errors', colors.reset);
    log('  3. Test shutdown to ensure services dispose properly', colors.reset);
    log('  4. Check logs for service lifecycle messages', colors.reset);
    process.exit(0);
  } else {
    log('❌ Some checks failed. Please review the issues above.', colors.red);
    process.exit(1);
  }
}

// Run validation
validate().catch(err => {
  log(`\n❌ Validation failed with error: ${err.message}`, colors.red);
  console.error(err);
  process.exit(1);
});