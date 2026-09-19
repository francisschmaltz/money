# Repository Guidelines

## Project Structure & Module Organization

Application code lives in `app/`. Keep HTTP handlers in `app/routes/`, business logic in `app/services/`, persistence in `app/db/`, MCP contracts in `app/mcp/`, background work in `app/worker/`, and provider integrations in `app/providers/`. EJS templates and browser assets belong in `app/views/` and `app/public/`. Sequential PostgreSQL migrations live in `migrations/` using zero-padded names such as `041_add_feature.sql`. Unit and integration tests are in `test/`; Playwright specs and snapshots are in `tests/e2e/`. Put operational notes in `docs/` and feature proposals in `specs/`.

## Build, Test, and Development Commands

- `npm ci` installs the locked Node 24 dependencies.
- `npm run dev` starts the app in watch mode and reads `.env` when present.
- `npm start` runs migrations, the worker, and the HTTP server.
- `npm run migrate` applies pending PostgreSQL migrations.
- `npm test` runs all `node:test` files under `test/`.
- `npm run test:coverage` reports native test coverage; no numeric threshold is enforced.
- `npm run test:browser` runs default and stress-scenario Playwright checks.
- `npm run check` performs a syntax check and the unit/integration suite.

Use `.env.example` as the local template. Its demo configuration runs without PostgreSQL, Plaid, Duo, or LM Studio.

## Coding Style & Naming Conventions

Use ES modules, two-space indentation, double quotes, semicolons, and trailing commas in multiline structures. Prefer `camelCase` for JavaScript identifiers and filenames such as `financeService.js`; reserve `PascalCase` for classes. Keep route handlers thin and inject dependencies into services for testability. Match the existing database `snake_case` at persistence and API boundaries. There is no separate formatter or linter; follow nearby code and run `npm run check`.

## Testing Guidelines

Name Node tests `*.test.js` and Playwright tests `*.spec.js`. Use `node:test` with `node:assert/strict`; use Supertest for HTTP behavior. Add focused regression coverage for service, schema, route, and migration changes. Run targeted tests with `node --test test/<name>.test.js`, then run the full check. Update Playwright snapshots only after visually verifying the change.

## Commit & Pull Request Guidelines

Recent commits use short imperative subjects beginning with verbs such as `Fix`, `Add`, or `Update`. Keep each commit scoped to one behavior. Pull requests should explain the user-visible change, call out migrations or configuration changes, list tests run, link the issue or spec, and include screenshots for UI work. Never commit `.env`, credentials, Plaid tokens, database dumps, or uploaded financial data.
