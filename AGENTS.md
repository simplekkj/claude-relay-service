# Repository Guidelines

## Project Structure & Module Organization
- `src/`: Express app entrypoint (`src/app.js`) plus `routes/`, `handlers/`, `services/`, `middleware/`, `utils/`.
- `cli/`: command-line admin tooling.
- `scripts/`: ops/maintenance scripts (setup, migrations, data export/import).
- `tests/`: Jest tests (`*.test.js`, `*.integration.test.js`).
- `web/admin-spa/`: Vue 3 + Vite admin SPA (build output in `web/admin-spa/dist`).
- `config/`: runtime config (`config/config.js`) and examples.

## Build, Test, and Development Commands
- `make setup`: copy `config/config.example.js` → `config/config.js` and `.env.example` → `.env`, then run bootstrap.
- `npm run dev` (or `make dev`): start the API server with nodemon.
- `npm start` (or `make start`): run the server in “production” mode (runs lint first).
- `npm test`: run Jest.
- `npm run build:web`: build the admin SPA.
- `npm run docker:up`: start via Docker Compose (includes Redis).

## Coding Style & Naming Conventions
- JavaScript (Node >= 18), 2-space indentation, single quotes, no semicolons (Prettier).
- Prefer `npm run format` + `npm run lint:check` before pushing; avoid committing auto-fix-only churn.
- Follow existing naming: modules in `camelCase.js`, tests as `*.test.js`.

## Testing Guidelines
- Keep tests fast and deterministic. Use `*.integration.test.js` only when you truly need Redis/HTTP.
- Coverage: `npm test -- --coverage`.

## Commit & Pull Request Guidelines
- Commits follow Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `style:` (optional scopes like `feat(admin): ...`).
- PRs should include: what changed, how to verify, and any config/env impacts; include screenshots for `web/admin-spa` UI changes.

## Security & Configuration Tips
- Don’t commit secrets. Use `.env` and `config/config.js`.
- Changes touching auth/rate limits should include tests and a quick manual sanity check of the admin UI.

## Agent-Specific Notes
- If using an AI agent, propose a diff and get explicit approval before applying changes.
- Don’t use browser automation unless explicitly requested.
