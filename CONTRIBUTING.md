# Contributing

This document contains information on how to contribute to the `pi-research` project, including development, testing, and release procedures.

## Development

To set up the development environment, follow these steps:

1.  **Install Dependencies**: Run `npm install` to install the required Node.js packages.
2.  **Tooling Setup**: Ensure you have `pi` installed and configured.
3.  **Environment Variables**: Copy `.env.example` to `.env` to configure your development environment.
4.  **Formatting and Linting**: Use `npm run lint` and `npm run lint:fix` to maintain code quality.
5.  **Type Checking**: Run `npm run type-check` to ensure TypeScript compliance.

## Testing

The project uses `vitest` for testing.

-   **Unit Tests**: Run `npm run test:unit` for tests that do not require Docker or network access.
-   **Integration Tests**: Run `npm run test:integration` for tests that require a running Docker daemon and internet access. These tests may pull and start SearXNG containers.
-   **Coverage**: Run `npm run test:coverage` to generate a test coverage report.

## Release Process

The release process is automated via GitHub Actions.

1.  **Version Update**: Use `npm version patch`, `minor`, or `major` to update the version in `package.json`.
2.  **Push Changes**: Push the changes and the new tag to the `main` branch:
    ```bash
    git push origin main
    git push origin v<version>
    ```
3.  **CI/CD**: The GitHub Actions workflow will automatically run linting, type-checking, and unit tests. If successful, it will publish the package to npm and create a GitHub Release.

## Dependencies

-   **Node.js**: The project requires Node.js `22.13.0` (as pinned in `.nvmrc`) or any `24.x+` release.
-   **Docker**: Required for running the SearXNG container.
-   **npm Packages**:
    -   `playwright`: For scraping JavaScript-heavy websites.
    -   `dockerode`: For managing Docker containers.
    -   `js-yaml`: For YAML configuration management.
    -   `node-html-markdown`: For HTML to Markdown conversion.
    -   `@kreuzberg/html-to-markdown-node`: Native HTML-to-Markdown (platform-specific binaries).
