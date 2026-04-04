# Release Guide for pi-research

This guide explains how to release pi-research to GitHub and npm.

## Prerequisites

1. You have a GitHub repository set up
2. You have npm account credentials
3. Your local git is configured with push access

## Release Process

### Step 1: Prepare Release

Run the automated release preparation script:

```bash
./scripts/prepare-release.sh 2.0.1
```

This script:
- Runs all tests (unit + integration)
- Runs type checking
- Runs linting
- Checks for security vulnerabilities
- Validates all required files exist
- Updates version in package.json

If all checks pass, the script will show next steps.

### Step 2: Update Changelog

Edit `CHANGELOG.md` to document the changes in this release:

```markdown
## [2.0.1] - 2026-04-04

### Added
- New feature description

### Changed
- Improved feature description

### Fixed
- Bug fix description

### Security
- Security issue fix description
```

Use [Semantic Versioning](https://semver.org/):
- **MAJOR** (X.0.0): Breaking changes
- **MINOR** (0.X.0): New features (backwards compatible)
- **PATCH** (0.0.X): Bug fixes (backwards compatible)

### Step 3: Commit and Tag

```bash
# Add all changes
git add .

# Commit with descriptive message
git commit -m "chore: release v2.0.1

- Updated version in package.json
- Updated CHANGELOG.md with release notes
- All tests passing, lint clean, types valid"

# Create annotated tag (required for release workflow)
git tag -a v2.0.1 -m "Release v2.0.1"

# Push commits and tags to remote
git push origin main
git push origin v2.0.1
```

**Important**: The release workflow is triggered by pushing a tag matching `v*.*.*` format.

### Step 4: Automated Release

Once you push the tag, GitHub Actions will automatically:

1. **Run CI checks** (lint, type check, tests)
2. **Create GitHub Release** with changelog reference
3. **Publish to npm** (requires `NPM_TOKEN` secret)

You can monitor progress in **GitHub → Actions** tab.

### Step 5: Verify Release

After the workflow completes:

1. **Check GitHub Releases**: Visit [Releases](https://github.com/Lincoln504/pi-research/releases) page
2. **Check npm**: Search [npmjs.com](https://www.npmjs.com/package/pi-research)
3. **Test installation**: 
   ```bash
   npm install -g pi-research@2.0.1
   ```

## GitHub Secrets Configuration

To enable npm publishing, configure GitHub repository secrets:

1. Go to **Settings → Secrets and variables → Actions**
2. Create new secret:
   - **Name**: `NPM_TOKEN`
   - **Value**: Your npm authentication token

### How to get npm token:

```bash
# Login to npm
npm login

# Create a token (Automation recommended)
npm token create

# Copy the token to GitHub secrets
```

## Semantic Versioning Examples

### MAJOR Release (Breaking Changes)
```bash
# Current: 1.9.0 → New: 2.0.0
./scripts/prepare-release.sh 2.0.0
```

Changes:
- Removed deprecated API methods
- Changed function signatures
- Removed old tool implementations

### MINOR Release (New Features)
```bash
# Current: 2.0.0 → New: 2.1.0
./scripts/prepare-release.sh 2.1.0
```

Changes:
- Added new `new_tool`
- Added support for new databases
- Added new configuration options

### PATCH Release (Bug Fixes)
```bash
# Current: 2.0.1 → New: 2.0.2
./scripts/prepare-release.sh 2.0.2
```

Changes:
- Fixed crash in coordinator
- Improved error handling in scraper
- Fixed memory leak in session cleanup

## CI/CD Pipelines

### Pull Request Checks (Every PR)

When you create a PR or push to a branch:

- **Lint**: Code style validation (ESLint)
- **Type Check**: TypeScript validation
- **Unit Tests**: All unit tests must pass
- **Integration Tests**: All integration tests must pass

All checks must pass before merging to `main`.

### Release Workflow (On Version Tag)

When you push a version tag (`v*.*.*`):

1. Checkout code with full history
2. Install dependencies
3. Run lint check
4. Run type check
5. Run all tests
6. Create GitHub Release
7. Publish to npm

## Rollback Procedures

### If GitHub Release Was Created but npm Publish Failed

1. Inspect the failed workflow in GitHub Actions
2. Fix the issue
3. Delete the problematic tag:
   ```bash
   git tag -d v2.0.1
   git push origin :refs/tags/v2.0.1
   ```
4. Create new tag and push again:
   ```bash
   git tag -a v2.0.1 -m "Release v2.0.1 (retry)"
   git push origin v2.0.1
   ```

### If npm Publish Succeeded but It Was Incorrect

1. Unpublish the package:
   ```bash
   npm unpublish pi-research@2.0.1
   ```
2. Delete the tag:
   ```bash
   git tag -d v2.0.1
   git push origin :refs/tags/v2.0.1
   ```
3. Make corrections and release again

## Troubleshooting

### "npm publish" fails with authentication error

- Check `NPM_TOKEN` secret is set in GitHub repository settings
- Verify token has "Automation" scope (recommended)
- Ensure token hasn't expired

### Tests fail in GitHub Actions but pass locally

- Check Node.js version matches (currently 18.x)
- Run `npm ci` instead of `npm install` locally to match CI
- Check for OS-specific issues (use `actions/setup-node@v4` setup)

### Release workflow doesn't trigger

- Verify tag is pushed: `git push origin v2.0.1`
- Verify tag format matches `v*.*.*` (e.g., `v2.0.1`, not `2.0.1`)
- Check GitHub Actions is enabled in repository settings

### "At least one release asset was not properly uploaded" error

This usually means the GitHub Actions had an issue creating the release. Check the workflow logs in the Actions tab.

## Release Checklist

Use this checklist before every release:

- [ ] All commits are on the `main` branch
- [ ] `CHANGELOG.md` is updated with release notes
- [ ] `package.json` version matches release version
- [ ] All tests pass locally (`npm test`)
- [ ] Linting passes (`npm run lint`)
- [ ] Type checking passes (`npm run type-check`)
- [ ] No uncommitted changes (`git status` clean)
- [ ] Tag is created with correct format (`v*.*.* `)
- [ ] Tag is pushed to remote (`git push origin v*.*.*`)
- [ ] GitHub Actions workflow completes successfully
- [ ] Release appears on [GitHub Releases](https://github.com/Lincoln504/pi-research/releases)
- [ ] Package appears on [npm](https://www.npmjs.com/package/pi-research)
- [ ] Installation test succeeds: `npm install -g pi-research@version`

## Quick Reference

### Release a new patch version

```bash
# Prepare (runs tests, updates version)
./scripts/prepare-release.sh 2.0.1

# Update changelog
vim CHANGELOG.md

# Commit and tag
git add .
git commit -m "chore: release v2.0.1"
git tag -a v2.0.1 -m "Release v2.0.1"

# Push (triggers GitHub release + npm publish)
git push origin main v2.0.1
```

### View release status

```bash
# Check GitHub Actions
open https://github.com/Lincoln504/pi-research/actions

# Check npm package
open https://www.npmjs.com/package/pi-research
```

## More Information

- [Semantic Versioning](https://semver.org/)
- [npm Publishing Guide](https://docs.npmjs.com/publishing-and-managing-packages-and-modules)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Our CHANGELOG.md](./CHANGELOG.md)
- [Our CONTRIBUTING.md](./CONTRIBUTING.md)
