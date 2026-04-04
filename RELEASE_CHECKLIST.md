# Release Checklist

Step-by-step guide for releasing pi-research. See `CI_RELEASE_SETUP.md` for CI/CD setup and automation details.

## ✅ Pre-Release Verification

- [x] **LICENSE File**: MIT License present
- [x] **README.md**: Comprehensive documentation
- [x] **CONTRIBUTING.md**: Clear contribution guidelines
- [x] **SECURITY.md**: Vulnerability reporting policy
- [x] **Tests Pass**: All unit and integration tests passing
- [x] **Dependencies Clean**: No known vulnerabilities (run `npm audit`)
- [x] **Code Quality**: Linting and type checking pass
- [x] **GitHub Actions**: CI/CD workflows configured
- [x] **Issue Templates**: Bug report, feature request, general issue
- [x] **PR Template**: Pull request template configured

## 📋 Release Process

### 1. Final Testing

```bash
npm test                 # Run all unit tests
npm run test:integration # Run integration tests
npm run type-check       # Verify TypeScript
npm run lint             # Check code style
npm audit                # Check security vulnerabilities
```

### 2. Update Version and Changelog

```bash
# Edit package.json version (e.g., 2.0.0 → 2.0.1)
vim package.json

# Update CHANGELOG.md with release notes
vim CHANGELOG.md
```

### 3. Create Release Commit and Tag

```bash
git add package.json CHANGELOG.md
git commit -m "chore: release v2.0.1"

git tag -a v2.0.1 -m "Release v2.0.1"
git push origin main
git push origin v2.0.1
```

GitHub Actions will automatically:
- Run all tests and checks
- Create a GitHub Release
- Publish release notes

### 4. Post-Release

1. Verify GitHub Release was created
2. Monitor for issues and feedback
3. Update documentation if needed

## 🔧 GitHub Settings (One-Time Setup)

### Branch Protection

Go to **Settings → Branches → Add rule** for `main`:
- ✅ Require pull request before merging
- ✅ Require 1 approval
- ✅ Require status checks: Lint, Type Check, Unit Tests
- ✅ Require branches up to date
- ✅ Do not allow bypassing

### Repository Visibility

When ready to make public:
1. **Settings → Danger Zone → Change repository visibility**
2. Select **Public** and confirm

## 📚 Related Documentation

- **CI_RELEASE_SETUP.md** - Detailed CI/CD workflow configuration
- **CONTRIBUTING.md** - Development guidelines
- **CHANGELOG.md** - Version history
