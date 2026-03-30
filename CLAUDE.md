# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Backend-for-Frontend (BFF) and API Gateway built with Express 5 and Node.js (>=20.11). Handles OIDC authentication via Authentik, Redis-backed session management, and dynamic API proxying to backend services. ES module project (`"type": "module"`).

## Commands

- **Run dev server:** `npm run dev` or `npm start` (runs `node src/server.js`)
- **Lint:** `npm run lint` (runs `eslint .`)
- **Docker:** `docker-compose up` (starts Redis + BFF)
- **No test framework is configured.** There are no test files or test runner dependencies.

## Architecture

**Request flow:** Client → Express middleware stack → session validation → token refresh → user header injection → proxy to backend service.

### Entry Points
- `src/server.js` — HTTP server creation and startup
- `src/app.js` — Express app with full middleware stack configuration

### Middleware Order (matters for correctness)
1. Helmet, pino-http, CORS, cookie-parser
2. **Proxy routes mounted before body parsers** (preserves raw request bodies for proxying)
3. JSON/URL body parsers
4. Rate limiting (auth endpoints only)
5. Static files, route handlers, error handlers

### Key Modules
- **`src/routes/auth.js`** — OIDC authorization code flow with PKCE (`/auth/login`, `/auth/callback`, `POST /auth/logout`)
- **`src/routes/proxy_routes.js`** — Dynamic API gateway that routes `/api/*` requests to backends based on `config.yml` mappings (frontendHost, frontendPort, pathPrefix → backend URL). Injects `x-user-email`, `x-user-sub`, `x-user-name` headers.
- **`src/services/oidc.js`** — Token exchange, ID token verification via JWKS, token refresh with skew detection
- **`src/services/sessionStore.js`** — Redis session CRUD with 8-hour rolling TTL, 10-minute state records for OIDC flow
- **`src/middleware/requireAuth.js`** — Session validation + automatic token refresh on expiry
- **`src/middleware/csrfCheck.js`** — Origin/Referer header validation

### Configuration
- **Environment:** `.env` file loaded via dotenv, schema in `src/config/index.js`
- **Proxy routing:** `config.yml` at project root defines `defaultBackend` and `mappings[]` (frontendHost/frontendPort/pathPrefix → backend)
- **`.env.example`** documents all required environment variables

### Deployment
- Docker: Node 20 Alpine, runs as non-root `node` user, exposes port 5000
- Docker Compose: Redis 7 (with AOF persistence) + BFF service
