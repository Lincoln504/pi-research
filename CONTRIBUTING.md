# Contributing to pi-research

Thank you for your interest in contributing to pi-research! This document provides guidelines and instructions for contributors.

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- Docker (for SearXNG container)
- pi coding agent installed
- TypeScript knowledge

### Development Setup

```bash
# Clone the repository
git clone https://github.com/Lincoln504/pi-research-dev.git
cd pi-research-dev

# Install dependencies
npm install

# Load extension with pi (for testing)
pi -e ./index.ts
```

## Development Workflow

### Code Style

- Use TypeScript for all new code
- Follow existing code structure and naming conventions
- Run linter before committing: `npm run lint`
- Fix linting issues: `npm run lint:fix`
- Type check: `npm run type-check`

### Project Structure

```
pi-research/
├── src/
│   ├── infrastructure/    # SearXNG, network, state management
│   ├── orchestration/     # Coordinator, delegate, researcher agents
│   ├── security/          # Security database integrations
│   ├── stackexchange/      # Stack Exchange API
│   ├── tools/             # Tool implementations
│   ├── tui/               # Terminal UI components
│   ├── utils/             # Shared utilities
│   └── web-research/      # Search, scraping, retry logic
├── prompts/               # Agent system prompts
├── config/                # SearXNG configuration
└── index.ts               # Extension entry point
```
### Testing
**Automated Testing**:
```bash
# Run all unit tests
npm run test:unit

# Run all tests (currently just unit tests)
npm test

# Watch mode for development
npm run test:watch

# Generate coverage report
npm run test:coverage
```

**Manual Testing**:
1. Load the extension: `pi -e ./index.ts`
2. Test with: `Please research: [your query]`
3. Verify SearXNG container starts correctly
4. Check TUI panel displays properly
5. Test various query complexities
**Note**: Always run `npm run test:unit` and `npm run type-check` before committing changes.

## Submitting Changes

### Pull Request Process

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes and commit them
4. Push to your fork: `git push origin feature/my-feature`
5. Open a pull request

### Commit Messages

Use clear, descriptive commit messages:

```
feat: add support for new security database
fix: resolve SearXNG connection timeout issue
docs: update README with new installation steps
refactor: improve error handling in scraper
test: add unit tests for coordinator
```

## Coding Guidelines

### Error Handling

- Always handle errors gracefully
- Provide clear error messages to users
- Log errors for debugging
- Never expose sensitive information

### Performance

- Avoid unnecessary API calls
- Implement rate limiting where appropriate
- Cache results when possible
- Clean up resources properly

### Security

- Never commit secrets or API keys
- Use environment variables for configuration
- Validate all user inputs
- Follow OWASP security guidelines

## Documentation

- Update README.md for user-facing changes
- Add inline comments for complex logic
- Update TUI.md for TUI changes
- Document new features in CHANGELOG.md

## Questions?

Feel free to open an issue for questions, bugs, or feature requests.

## License

By contributing to this project, you agree that your contributions will be licensed under the MIT License.
