# Contributing Guide

Thank you for your interest in contributing to pi-research! This guide will help you get started and understand our contribution process.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Documentation](#documentation)
- [Submitting Changes](#submitting-changes)
- [Review Process](#review-process)

---

## Code of Conduct

This project adheres to a code of conduct. By participating, you are expected to uphold this standard.

- Be respectful and inclusive
- Provide constructive feedback
- Assume good intentions
- Focus on what is best for the community

---

## Getting Started

### Prerequisites

- Node.js >= 22.13.0
- Git
- pi CLI installed and configured
- LLM in pi with 100k+ context window

### Setup

1. **Fork and clone the repository:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/pi-research.git
   cd pi-research
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Run setup script:**
   ```bash
   npm run setup
   ```

5. **Verify installation:**
   ```bash
   npm run type-check
   npm run test:unit
   ```

---

## Development Workflow

### Branch Strategy

- **main:** Stable, production-ready code
- **develop:** Integration branch for features
- **feature/*:** New features
- **fix/*:** Bug fixes
- **docs/*:** Documentation changes
- **refactor/*:** Code refactoring
- **test/*:** Test additions/changes

### Workflow

1. **Create a branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make changes:**
   - Write code following coding standards
   - Add/update tests
   - Update documentation

3. **Run checks:**
   ```bash
   npm run lint
   npm run type-check
   npm run test:unit
   npm run test:integration
   ```

4. **Commit changes:**
   ```bash
   git add .
   git commit -m "feat: add your feature description"
   ```

### Commit Messages

Follow conventional commits:

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `style:` Code style changes (formatting)
- `refactor:` Code refactoring
- `test:` Test additions/changes
- `chore:` Maintenance tasks

Examples:
```
feat: add Wikipedia API integration
fix: resolve browser crash on timeout
docs: update API documentation
test: add integration tests for knowledge store
```

---

## Coding Standards

### TypeScript

- Use TypeScript strict mode
- Prefer explicit types over `any`
- Use interfaces for object shapes
- Use type aliases for unions and primitives
- Document exported functions with JSDoc

Example:
```typescript
/**
 * Executes a web search query using stealth browser
 * @param query - The search query string
 * @param options - Search configuration options
 * @returns Promise resolving to search results
 */
export async function search(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResults> {
  // Implementation
}
```

### Code Style

- Use 2 spaces for indentation
- Use single quotes for strings
- Use semicolons
- Use arrow functions for callbacks
- Prefer `const` over `let`
- Destructure objects and arrays

### File Organization

```
src/
├── infrastructure/  # Low-level infrastructure (logger, browser pool)
├── core/           # Core business logic
├── orchestration/  # Multi-agent coordination
├── web-research/   # Search and scraping
├── tools/          # Research tool implementations
├── tui/            # Terminal UI
├── knowledge/      # Knowledge store
├── types/          # TypeScript type definitions
└── utils/          # Utility functions
```

### Naming Conventions

- **Files:** kebab-case (`knowledge-store.ts`)
- **Classes:** PascalCase (`KnowledgeStore`)
- **Functions/Variables:** camelCase (`searchQuery`)
- **Constants:** UPPER_SNAKE_CASE (`MAX_RETRIES`)
- **Types/Interfaces:** PascalCase (`SearchOptions`)

---

## Testing

### Test Structure

```
test/
├── unit/           # Unit tests
├── integration/    # Integration tests
└── load/           # Load tests
```

### Writing Tests

- Use Vitest as the test framework
- Follow the Arrange-Act-Assert pattern
- Test behavior, not implementation
- Use descriptive test names
- Mock external dependencies

Example:
```typescript
describe('KnowledgeStore', () => {
  describe('embed', () => {
    it('should embed text and return vector', async () => {
      // Arrange
      const store = new KnowledgeStore(config);
      const text = 'Sample text';

      // Act
      const vector = await store.embed(text);

      // Assert
      expect(vector).toHaveLength(384);
      expect(vector[0]).toBeTypeOf('number');
    });
  });
});
```

### Test Coverage

- Aim for >80% code coverage
- Test critical paths thoroughly
- Include edge cases
- Test error conditions

### Running Tests

```bash
# Unit tests
npm run test:unit

# Integration tests
npm run test:integration

# All tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

---

## Documentation

### Documentation Types

1. **API Documentation:** Document all public APIs in `docs/api/`
2. **User Guides:** How-to guides in `docs/guides/`
3. **Architecture:** Design decisions in `docs/architecture/`
4. **Development:** Developer docs in `docs/development/`

### Writing Documentation

- Use clear, concise language
- Include code examples
- Use consistent formatting
- Update related documentation
- Follow documentation standards (see `docs/development/documentation-standards.md`)

### Documentation Review

Before submitting changes:

1. Run spell check
2. Verify all links work
3. Test code examples
4. Get peer review

---

## Submitting Changes

### Pull Request Checklist

Before submitting a PR:

- [ ] Code follows coding standards
- [ ] All tests pass (`npm run test:unit`, `npm run test:integration`)
- [ ] Type checking passes (`npm run type-check`)
- [ ] Linting passes (`npm run lint`)
- [ ] New features include tests
- [ ] Documentation is updated
- [ ] Commit messages follow conventional commits
- [ ] PR description is clear and complete

### Pull Request Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Related Issues
Fixes #123
Related to #456

## Testing
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing performed

## Checklist
- [ ] Code follows style guidelines
- [ ] Tests pass locally
- [ ] Documentation updated
- [ ] No breaking changes (or documented)
```

---

## Review Process

### Review Criteria

- **Correctness:** Does the code work as intended?
- **Style:** Does it follow coding standards?
- **Tests:** Are tests adequate and passing?
- **Documentation:** Is documentation updated?
- **Backward Compatibility:** Does it break existing functionality?

### Review Timeline

- Initial review within 3 days
- Follow-up within 24 hours of updates
- Merge within 7 days of approval

### Addressing Feedback

- Respond to all comments
- Make requested changes or explain rationale
- Request re-review when ready

---

## Getting Help

### Questions?

- Check existing documentation
- Search GitHub issues
- Start a GitHub Discussion
- Ask in a PR comment

### Reporting Issues

- Use GitHub issue templates
- Provide reproduction steps
- Include environment details
- Attach logs/screenshots if applicable

---

## Recognition

Contributors are recognized in:
- CONTRIBUTORS.md
- Release notes
- Project README

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

**Last Updated:** 2026-05-23