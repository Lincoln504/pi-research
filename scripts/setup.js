#!/usr/bin/env node

/**
 * pi-research Postinstall Setup Script
 *
 * This script runs automatically after `npm install` and ensures:
 * 1. Camoufox stealth browser binaries are installed
 * 2. System dependencies are available (if run with --system-deps flag)
 *
 * Key Design Principles:
 * - NEVER exits with code 1 - this would block npm install from completing
 * - Uses npx camoufox-js fetch
 * - Provides clear feedback about installation status
 * - Gracefully handles missing dependencies (warns but doesn't fail)
 *
 * Usage:
 *   npm run setup              # Full setup: install deps + browsers
 *   npm run install:browsers   # Install only browser binaries
 *   npm run install:deps       # Install system dependencies only
 *
 * Environment Variables:
 *   PLAYWRIGHT_BROWSERS_PATH    - Custom path for browser cache
 *   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1  - Skip browser download
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
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

// Detect OS for browser installation
const isLinux = platform() === 'linux';
const isDarwin = platform() === 'darwin';
const isWindows = platform() === 'win32';

console.log(`\n📦 Detected platform: ${platform()}`);

// Track installation success
let browsersInstalled = false;
let systemDepsInstalled = false;

// Determine project root and browser cache directory
const projectRoot = join(__dirname, '..');
const browserCacheDir = join(projectRoot, '.browser');

// Ensure browser cache directory exists
if (!existsSync(browserCacheDir)) {
  try {
    execSync(`mkdir -p "${browserCacheDir}"`);
  } catch (e) {
    // Ignore if fails, will fall back to default behavior
  }
}

// Check if we should skip browser installation
const skipBrowserDownload = process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1';

if (skipBrowserDownload) {
  console.log('\n⏭️  Skipping browser installation (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1)');
} else {
  // Install Camoufox stealth browser
  console.log('\n🌐 Installing Camoufox stealth browser (local to project)...');

  try {
    // Set HOME to our local browser directory to force camoufox to install there
    const env = { ...process.env, HOME: browserCacheDir, USERPROFILE: browserCacheDir };

    // Check if user wants to install system dependencies
    const installDeps = process.argv.includes('--system-deps') ||
                        process.env.PLAYWRIGHT_INSTALL_DEPS === 'true';

    if (installDeps && isLinux) {
      console.log('⚙️  Installing Linux system dependencies for Playwright...');
      try {
        execSync('npx playwright install-deps', {
          stdio: 'inherit',
          env: { ...env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '0' }
        });
        console.log('✅ System dependencies installed');
        systemDepsInstalled = true;
      } catch (error) {
        console.warn('⚠️  Could not install system dependencies automatically.');
        console.warn('   Try running: sudo apt-get install $(npx playwright install-deps --print-deps)');
        // Don't fail - continue with browser installation
      }
    }

    // Install Camoufox binaries
    console.log('   Fetching Camoufox binaries...');
    execSync('npx camoufox-js fetch', {
      stdio: 'inherit',
      env
    });

    console.log('✅ Stealth browser installed successfully');
    browsersInstalled = true;

  } catch (error) {
    // Parse error message to provide better guidance
    const errorMsg = error instanceof Error ? error.message : String(error);

    if (errorMsg.includes('npx: command not found')) {
      console.warn('\n⚠️  npx not available - skipping browser installation');
      console.warn('   Camoufox can be installed later with: npx camoufox-js fetch');
    } else {
      console.warn('\n⚠️  Browser installation failed:');
      console.warn(`   ${errorMsg}`);
      console.warn('\n💡 You can install Camoufox later with:');
      console.warn('   npx camoufox-js fetch');
    }

    // NEVER exit with code 1 - let npm install complete
    console.log('\n📦 pi-research installation will continue...');
    console.log('='.repeat(60));
    console.log('✅ pi-research installed (browsers can be installed later)');
    console.log('='.repeat(60) + '\n');
    process.exit(0);
  }
}

// Verify installation
console.log('\n📋 Verifying browser installation...');

// Camoufox stores binaries in $HOME/.cache/camoufox on Linux/macOS
const camoufoxPath = isWindows 
  ? join(browserCacheDir, "AppData", "Local", "camoufox", "camoufox", "Cache")
  : join(browserCacheDir, '.cache', 'camoufox');

if (existsSync(camoufoxPath)) {
    console.log(`   ✅ camoufox: Found in ${camoufoxPath}`);
    try {
        const versions = readdirSync(camoufoxPath).filter(f => 
            statSync(join(camoufoxPath, f)).isDirectory()
        );
        if (versions.length > 0) {
            console.log(`      Installed versions: ${versions.join(', ')}`);
        }
    } catch (e) {
        // Ignore listing errors
    }
} else {
    console.warn(`   ⚠️  camoufox: Not found in ${camoufoxPath}`);
}

// Show versions
console.log('\n🔍 Versions:');
try {
  // playwright-core provides the CLI for version checking when using core
  const playwrightVersion = execSync('npx playwright-core --version', { encoding: 'utf8' }).trim();
  console.log(`   Playwright Core: ${playwrightVersion}`);
} catch (error) {
  console.warn('   Could not determine Playwright version');
}

// Final status message
const setupComplete = browsersInstalled;

console.log('\n' + '='.repeat(60));
if (setupComplete) {
  console.log('🎉 Setup complete! Camoufox stealth browser installed. pi-research is ready to use.');
} else {
  console.log('📦 pi-research installed successfully!');
  console.log('   Camoufox browser installation may be in progress or was skipped.');
  console.log('   The browser will be installed automatically when you first use the research tool.');
}
console.log('='.repeat(60));

// Additional info
console.log('\n📚 Quick start:');
console.log('   • npm test              - Run unit tests');
console.log('   • npm run type-check    - Type check TypeScript');
console.log('   • npm run lint          - Run ESLint');
console.log('   • npm run setup         - Full setup with system deps');
console.log('   • npx camoufox-js fetch - Update stealth browser binaries');

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
