# AGENTS.md

Guidance for AI coding agents working in this repository.

## Setup

- Use pnpm, not npm or yarn: `pnpm install`.
- Node 22 is required; run `nvm use` if `.nvmrc` is not picked up.

## Before committing

- Run `pnpm lint` and `pnpm test`; both must pass.
- Run `pnpm typecheck` when you change anything under `src/`.

## Conventions

- TypeScript strict mode; no `any` in new code.
- Tests live next to the code as `*.test.ts`.
- Do not edit files under `generated/`; run `pnpm codegen` instead.
- Keep pull requests small and describe the user-visible change in the first line.
