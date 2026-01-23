# Claude Relay Service - Overview

## Purpose
Self-hosted Claude API relay service with multi-account management, API key management, usage stats, and admin web UI. Focus on privacy, cost transparency, and stability.

## Tech Stack
- Node.js 18+ backend (Express in `src/`)
- Redis 6+ for caching/queues
- Vue 3 + Vite admin SPA in `web/admin-spa/`
- Pinia for SPA state, Axios for HTTP
- Docker + docker-compose support

## Repository Structure (high-level)
- `src/`: Express app entrypoint and server code
- `routes/`, `handlers/`, `services/`, `middleware/`, `utils/` under `src/`
- `web/admin-spa/`: Vue 3 admin SPA (build output in `web/admin-spa/dist`)
- `tests/`: Jest tests (`*.test.js`, `*.integration.test.js`)
- `cli/`, `scripts/`, `config/`: tooling/config

## Notes
- Security notice in README: versions <= v1.1.248 have critical admin auth bypass; v1.1.249+ recommended.