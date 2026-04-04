#!/bin/bash

# Setup script for pi-research testing infrastructure

set -e

echo "========================================="
echo "pi-research Testing Setup Script"
echo "========================================="
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
  echo "Error: Must run from pi-research root directory"
  exit 1
fi

echo "Step 1: Installing test dependencies..."
npm install --save-dev vitest@latest @vitest/ui@latest @vitest/coverage-v8@latest testcontainers@latest

echo ""
echo "Step 2: Verifying installation..."
if npx vitest --version > /dev/null 2>&1; then
  echo "✓ Vitest installed successfully"
  echo "  Version: $(npx vitest --version)"
else
  echo "✗ Vitest installation failed"
  exit 1
fi

echo ""
echo "Step 3: Creating test directory structure..."
mkdir -p test/{setup,unit,integration,e2e,helpers,types}
mkdir -p test/unit/{config,utils,stackexchange,security,tui}
mkdir -p test/integration/{web-research,security,stackexchange,infrastructure}
mkdir -p test/e2e/orchestration
mkdir -p test/unit/stackexchange/output

echo ""
echo "Step 4: Verifying test files..."
if [ -f "vitest.config.ts" ]; then
  echo "✓ vitest.config.ts exists"
else
  echo "✗ vitest.config.ts not found"
fi

if [ -f "test/setup/unit.ts" ]; then
  echo "✓ test/setup/unit.ts exists"
else
  echo "✗ test/setup/unit.ts not found"
fi

if [ -f "test/setup/integration.ts" ]; then
  echo "✓ test/setup/integration.ts exists"
else
  echo "✗ test/setup/integration.ts not found"
fi

echo ""
echo "Step 5: Running test suite..."
npx vitest run --config vitest.config.unit.ts || true

echo ""
echo "========================================="
echo "Setup Complete!"
echo "========================================="
echo ""
echo "Available commands:"
echo "  npm test              - Run all tests"
echo "  npm run test:unit     - Run unit tests only"
echo "  npm run test:integration - Run integration tests only"
echo "  npm run test:watch    - Watch mode for development"
echo "  npm run test:coverage - Generate coverage report"
echo "  npm run test:ui       - Interactive test UI"
echo ""
echo "Next steps:"
echo "  1. Read QUICK_START_TESTING.md"
echo "  2. Start writing tests for pure functions (no refactoring needed)"
echo "  3. Check off items in TESTING_CHECKLIST.md"
echo ""
