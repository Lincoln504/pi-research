#!/usr/bin/env node

/**
 * pi-research Postinstall Setup Script
 *
 * This script runs automatically after `npm install` and ensures:
 * 1. Playwright browser binaries are installed (Chromium, Firefox, WebKit)
 * 2. System dependencies are available (if run with --system-deps flag)
 *
 * Usage:
 *   npm run setup          # Full setup: install deps + browsers
 *   npm run install:browsers # Install only browser binaries
 *   npm run install:deps    # Install system dependencies only
 *
 * Environment Variables:
 *   PLAYWRIGHT_BROWSERS_PATH    - Custom path for browser cache
 *   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1  - Skip browser download
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, platform } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('='.repeat(60));
console.log('🔧 pi-research Setup');
console.log('='.repeat(60));

// Check Node.js version
const nodeVersion = process.version.replace('v', '');
const [major] = nodeVersion.split('.').map(Number);

console.log(`\nℹ️  Node.js version: v${nodeVersion}`);

const requiredVersions = {
  min: 22,
  preferred: [22, 24]
};

if (major < requiredVersions.min) {
  console.warn(
    `⚠️  WARNING: Node.js ${nodeVersion} is below the minimum required version ${requiredVersions.min}.`
  );
  console.warn('   Please upgrade to Node.js 22.13.0+ or 24.x+');
}

console.log(`   Required: >= ${requiredVersions.min}.0.0`);

// Check if playwright is installed
const playwrightPath = join(process.cwd(), 'node_modules', 'playwright');

if (!existsSync(playwrightPath)) {
  console.error('\n❌ ERROR: playwright is not installed.');
  console.error('   Run `npm install` first, then `npm run setup`.');
  process.exit(1);
}

console.log('✅ Playwright package installed');

// Detect OS for browser installation
const isLinux = platform() === 'linux';
const isDarwin = platform() === 'darwin';
const isWindows = platform() === 'win32';

console.log(`\n📦 Detected platform: ${platform()}`);

// Install browsers
console.log('\n🌐 Installing Playwright browsers...');

try {
  // Check if user wants to install system dependencies
  const installDeps = process.argv.includes('--system-deps') ||
                      process.env.PLAYWRIGHT_INSTALL_DEPS === 'true';

  if (installDeps && isLinux) {
    console.log('⚙️  Installing Linux system dependencies for Playwright...');
    try {
      execSync('npx playwright install-deps', {
        stdio: 'inherit',
        env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '0' }
      });
      console.log('✅ System dependencies installed');
    } catch (error) {
      console.warn('⚠️  Could not install system dependencies automatically.');
      console.warn('   Try running: sudo apt-get install $(npx playwright install-deps --print-deps)');
    }
  }

  // Install browser binaries
  // Only Chromium is needed for scraping (as per scrapers.ts implementation)
  console.log('   Installing Chromium browser...');
  execSync('npx playwright install chromium', {
    stdio: 'inherit',
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || ''
    }
  });

  console.log('✅ Browsers installed successfully');

  // Verify installation
  console.log('\n📋 Verifying browser installation...');
  const browsers = ['chromium']; // Only Chromium is required for scraping
  const cacheDir = join(homedir(), '.cache', 'ms-playwright');

  browsers.forEach(browser => {
    const browserDirs = readdirSync(cacheDir).filter(f =>
      f.startsWith(browser) && statSync(join(cacheDir, f)).isDirectory()
    );

    if (browserDirs.length > 0) {
      console.log(`   ✅ ${browser}: ${browserDirs.sort().join(', ')}`);
    } else {
      console.warn(`   ⚠️  ${browser}: Not found in cache`);
    }
  });

  // Show browser versions
  console.log('\n🔍 Browser versions:');
  try {
    const playwrightVersion = execSync('npx playwright --version', { encoding: 'utf8' }).trim();
    console.log(`   Playwright: ${playwrightVersion}`);
  } catch (error) {
    console.warn('   Could not determine Playwright version');
  }

} catch (error) {
  console.error('\n❌ ERROR: Failed to install browsers');
  console.error('   Error:', error.message);
  console.error('\n💡 Troubleshooting:');
  console.error('   1. Ensure you have internet connectivity');
  console.error('   2. Try running: npm run install:browsers');
  console.error('   3. Check Node.js version: node --version');
  console.error('   4. For Linux: sudo apt-get install -y $(npx playwright install-deps --print-deps)');
  process.exit(1);
}

console.log('\n' + '='.repeat(60));
console.log('🎉 Setup complete! Chromium browser installed. pi-research is ready to use.');
console.log('='.repeat(60));

// Additional info
console.log('\n📚 Quick start:');
console.log('   • npm test              - Run unit tests');
console.log('   • npm run type-check    - Type check TypeScript');
console.log('   • npm run lint          - Run ESLint');
console.log('   • npm run setup         - Full setup with system deps');

// Platform-specific tips
if (isLinux) {
  console.log('\n💡 Linux tip: If you encounter issues, install system deps:');
  console.log('   sudo apt-get install -y libgbm1 libnss3 libatk1.0-0');
  console.log('   libatk-bridge2.0-0 libcups2 libxkbcommon0 libxcomposite1');
} else if (isDarwin) {
  console.log('\n💡 macOS: Ensure Xcode Command Line Tools are installed:');
  console.log('   xcode-select --install');
} else if (isWindows) {
  console.log('\n💡 Windows: Ensure you have the latest Visual C++ redistributables');
}

console.log('\n');
