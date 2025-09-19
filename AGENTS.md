# Repository Guidelines

This guide helps contributors and coding agents work consistently in this repository.

## Project Structure & Module Organization
- `server.js` — Express server; renders Markdown with `markdown-it`, routes: `/`, `/browse`, `/file/<path>`.
- `public/` — optional static assets served at `/static` when present.
- `package.json` — scripts and dependencies.
- `node_modules/` — installed packages (do not commit).

## Build, Test, and Development Commands
- Install deps: `npm install`
- Run locally (dev): `npm run dev` (same as `npm start`)
- Set port (optional): `PORT=4000 npm start`
Notes: The app serves Markdown from the current user’s home directory; no build step is required.

## Coding Style & Naming Conventions
- Language: Node.js (CommonJS). Indentation: 2 spaces. Use semicolons and single quotes.
- Naming: `camelCase` for variables/functions, `UPPER_SNAKE_CASE` for env vars.
- Keep functions small and pure where possible. Prefer early returns and explicit error handling.
- If you add tooling, prefer Prettier and ESLint (`eslint:recommended`, Node environment). Example: `npx prettier --check .`.

## Testing Guidelines
- No test framework is configured yet. If adding tests, use Jest.
- File layout: `__tests__/server.test.js` or `*.spec.js` next to sources.
- Add a script: `"test": "jest"` and target ≥80% coverage for new code.
- Fast checks: start the server and verify routes `/`, `/browse`, and `/file/<path>` render without errors.

## Commit & Pull Request Guidelines
- Commits: Use Conventional Commits (e.g., `feat:`, `fix:`, `docs:`). Keep them small and focused.
- PRs must include: clear description, rationale, screenshots or terminal output when UI/UX changes, and manual test steps.
- Link related issues. Update documentation (this file or README-like docs) when behavior or commands change.

## Security & Configuration Tips
- The server reads Markdown from `HOME`. Avoid storing secrets in `.md` files.
- Do not expose this service to untrusted networks without review. Validate path handling and sanitize added features.
- Configurable env vars: `PORT` (default `3000`).

