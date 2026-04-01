# π-Research Extension Setup Guide

## Overview

The π-research extension is a multi-agent research orchestration system that can work with pi-search-scrape in two configurations:

1. **Development (Monorepo)** - Using relative paths (default)
2. **Production (NPM Package)** - Using npm-linked or published package

## Development Setup (Default)

For development with a monorepo structure:

```bash
# Ensure both directories are at the same parent level
/home/user/
  ├── pi-research/          # This extension
  └── pi-search-scrape/     # Search/scrape module

# Install dependencies
cd pi-research
npm install

# Build and run
npm run type-check
```

The extension will automatically use relative paths to load pi-search-scrape:
```
../../pi-search-scrape/search.ts
../../pi-search-scrape/scrapers.ts
../../pi-search-scrape/security-databases/
```

## Production Setup (NPM Linking)

For production deployment or npm package management:

### Option 1: npm link (Development Publishing)

```bash
# In the pi-search-scrape directory
cd ../pi-search-scrape
npm link

# In the pi-research directory
cd ../pi-research
npm link pi-search-scrape
npm install
```

This creates a symbolic link to pi-search-scrape in node_modules.

### Option 2: Publish to NPM Registry

```bash
# In pi-search-scrape directory
npm publish

# In pi-research directory
npm install pi-search-scrape
```

### Option 3: Git URL Install

```bash
# In pi-research directory
npm install git+https://github.com/your-org/pi-search-scrape.git
```

## Module Resolution

The extension automatically resolves pi-search-scrape modules in this order:

1. **NPM Package** - Tries to load from `pi-search-scrape/dist/` (npm/linked)
2. **Relative Path** - Falls back to `../../pi-search-scrape/` (monorepo)

If both fail, you'll see a detailed error message:
```
Failed to load pi-search-scrape. Ensure it is available via:
1. npm link (production): npm link pi-search-scrape
2. relative path (development): ../../pi-search-scrape/
```

## Verified Module Paths

### From NPM Package
- `pi-search-scrape/dist/search.js`
- `pi-search-scrape/dist/scrapers.js`
- `pi-search-scrape/dist/security-databases/index.js`
- `pi-search-scrape/dist/security-databases/types.js`
- `pi-search-scrape/dist/stackexchange/index.js`

### From Relative Path
- `../../pi-search-scrape/search.ts`
- `../../pi-search-scrape/scrapers.ts`
- `../../pi-search-scrape/security-databases/index.ts`
- `../../pi-search-scrape/security-databases/types.ts`
- `../../pi-search-scrape/stackexchange/index.ts`

## Configuration

### Environment Variables

The extension supports runtime configuration via environment variables:

```bash
# Maximum research iterations (default: 3)
export PI_RESEARCH_MAX_ITERATIONS=5

# Per-researcher timeout in milliseconds (default: 60000)
export PI_RESEARCH_RESEARCHER_TIMEOUT_MS=120000

# Flash indicator timeout in milliseconds (default: 500)
export PI_RESEARCH_FLASH_TIMEOUT_MS=300

# Then run
npm run type-check
```

## Troubleshooting

### Module Not Found

If you see "Failed to load pi-search-scrape":

1. **Check monorepo structure:**
   ```bash
   ls -la ../pi-search-scrape/search.ts
   ```

2. **Check npm linking:**
   ```bash
   npm link --list
   npm ls pi-search-scrape
   ```

3. **Verify npm package:**
   ```bash
   ls -la node_modules/pi-search-scrape/
   ```

### Type Checking Fails

```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install

# Re-link if using npm link
npm link pi-search-scrape
```

### Runtime Import Errors

Enable debug logging to see which module resolution path is being used:

```bash
# Look for debug output in logs:
[agent-tools] Loaded pi-search-scrape from npm package
# or
[agent-tools] Loaded pi-search-scrape from relative paths
```

## Best Practices

1. **Development**: Use monorepo structure with relative paths
2. **Production**: Use npm link or published package
3. **CI/CD**: Pin versions and use npm publish for reproducibility
4. **Testing**: Test both resolution paths to ensure compatibility

## Migration from Relative Paths to NPM

To migrate from monorepo to npm package:

1. Build pi-search-scrape: `npm run build`
2. Publish: `npm publish`
3. Update pi-research: `npm install pi-search-scrape`
4. Verify module loading in logs
5. Run tests: `npm run type-check`

The resolution logic handles this automatically - no code changes needed!
