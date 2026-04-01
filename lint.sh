#!/bin/bash

# Lint script for pi-research
set -e

echo "Running ESLint on pi-research..."
cd "$(dirname "$0")"

npx eslint src/ --fix

echo "Running TypeScript compilation check..."
/home/ldeen/.config/nvm/versions/node/v25.8.2/lib/node_modules/typescript/lib/tsc.js --noEmit

echo "✅ All checks passed!"
