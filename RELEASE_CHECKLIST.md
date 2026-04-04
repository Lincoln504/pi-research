# Release Checklist

This checklist guides you through preparing pi-research for release.

## ✅ Documentation & Legal

- [x] **LICENSE File**: MIT License is present
- [x] **README.md**: Comprehensive with installation, usage, and examples
- [x] **CONTRIBUTING.md**: Clear contribution guidelines
- [ ] **Copyright Headers**: Add to source code files (optional but recommended)

## ✅ Repository Cleanup

- [x] **Remove Secrets/PII**: No secrets found in codebase
- [x] **Remove Large Files/Artifacts**: Only README-banner.jpg (186K) - acceptable
- [ ] **Cleanup Commit History**: Consider squashing WIP commits (optional)
- [ ] **Remove Unused Code/Comments**: Check for commented-out code blocks

## ✅ Technical & Quality

- [x] **Functional Code**: Tests pass locally
- [x] **Dependency Check**: Run `npm audit`
- [ ] **Initial Release Tag**: Create tag `v2.0.0` after all checks pass
- [ ] **CI/CD Status**: Verify workflows work after pushing to main

## ✅ GitHub/Platform Setup

- [x] **Clear Name**: pi-research
- [x] **Issue Templates**: Bug report, feature request, general issue created
- [ ] **Branch Protection**: Set up in GitHub repository settings
- [ ] **Issue Labels**: Auto-created on push to main
- [x] **PR Template**: Created

## 📋 Pre-Release Actions

### 1. Final Testing

```bash
# Run all tests
npm test

# Run type check
npm run type-check

# Run linter
npm run lint

# Check for security vulnerabilities
npm audit

# Check for outdated dependencies
npm outdated
```

### 2. Update Version

Update version in `package.json` (if needed):

```json
{
  "version": "2.0.0"
}
```

### 3. Update CHANGELOG.md

Ensure `CHANGELOG.md` includes all changes for the release.

### 4. Commit All Changes

```bash
git add .
git commit -m "chore: prepare for v2.0.0 release"
```

### 5. Create Git Tag

```bash
git tag -a v2.0.0 -m "Release v2.0.0"
git push origin main
git push origin v2.0.0
```

## 🔧 GitHub Repository Settings (Manual Setup)

### Branch Protection

1. Go to Settings → Branches
2. Add rule for `main` branch:
   - ✅ Require a pull request before merging
   - ✅ Require approvals: 1
   - ✅ Require status checks to pass before merging
     - ✅ Lint
     - ✅ Type Check
     - ✅ Unit Tests
   - ✅ Require branches to be up to date before merging
   - ✅ Do not allow bypassing the above settings

### Issue Labels

Labels will be auto-created when pushing `.github/workflows/setup-labels.yml` to main.

### Repository Visibility

When ready to make public:
1. Go to Settings → Danger Zone
2. Click "Change repository visibility"
3. Select "Public"
4. Follow the prompts

## 📦 Post-Release Actions

1. Verify the GitHub Release was created automatically
2. Test the release by installing from the tag
3. Announce the release (if making public)
4. Monitor for issues and feedback

## 🔄 Ongoing Maintenance

- Keep dependencies updated: `npm update`
- Regular security audits: `npm audit fix`
- Update CHANGELOG.md with each release
- Maintain semantic versioning (MAJOR.MINOR.PATCH)
