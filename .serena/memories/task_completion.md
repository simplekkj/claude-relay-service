# Task Completion Checklist

- Run format/lint: `npm run format` and `npm run lint:check` if appropriate
- Run tests: `npm test` (use integration tests only when needed)
- For UI changes in `web/admin-spa`, include screenshots in PR
- Avoid committing secrets; use `.env` and `config/config.js`
- Auth/rate limit changes should include tests and a quick admin UI sanity check