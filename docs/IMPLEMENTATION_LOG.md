# Implementation Log

## 2026-09-23 — Phase 0: Inspection & Scaffolding

**What was implemented**: Inspected the target directory (empty), confirmed
available tooling (Node 24.19.0, npm 11.17.0, git 2.51.0, Docker Desktop
installed but daemon stopped, no local mongod, Ollama running locally with
`qwen2.5:7b` pulled). Initialized git. Created the monorepo directory
structure (`apps/web`, `apps/api`, `packages/shared`, `docs`, `scripts`).
Created root `package.json` (npm workspaces), `.gitignore`, `.env.example`,
`PROJECT_DECISIONS.md`, and `docs/PROJECT_OVERVIEW.md` / `docs/DECISIONS.md`.

**Why**: The master spec requires inspecting real state before writing any
code and documenting architecture decisions before implementation begins.
Since the directory was empty, this is a greenfield scaffold, not a merge
with existing work.

**Files created**: `.gitignore`, `.env.example`, `package.json`,
`PROJECT_DECISIONS.md`, `docs/PROJECT_OVERVIEW.md`, `docs/DECISIONS.md`,
`docs/IMPLEMENTATION_LOG.md`, empty `apps/web/src/*`, `apps/api/src/*`,
`packages/shared/src` directories.

**Technical approach**: npm workspaces monorepo; MongoDB via Docker Compose
(daemon needs to be started by the user before it can run); Ollama as the
AI provider since it's already installed and serving locally.

**Alternatives considered**: pnpm/yarn workspaces (rejected — not installed,
no benefit at this scale); native MongoDB install (rejected — Docker already
available, keeps the host machine clean); hosted AI provider (deferred —
Ollama is free and already working; can be added later behind the
`AIProvider` interface).

**Tests performed**: None yet — no application code exists.

**Known limitations**: Docker Desktop's daemon is not currently running, so
`docker compose up` will fail until the user starts Docker Desktop. This is
documented in `PROJECT_DECISIONS.md` and will be called out again in the
README setup steps.

**Next steps**: Phase 1 — TypeScript configs for `apps/api` and `apps/web`,
ESLint/Prettier, Express skeleton with `/health` endpoint, Vite React
skeleton, Zod-based env validation, `docker-compose.yml` for MongoDB.

## 2026-09-23 — Phase 1: Foundation & Configuration

**What was implemented**:

- `tsconfig.base.json` at the root (strict mode plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`), extended separately by
  `apps/api/tsconfig.json` (Node/NodeNext) and `apps/web/tsconfig.json`
  (bundler resolution, JSX, `noEmit` since Vite/esbuild does the actual
  transpilation).
- Root ESLint flat config (`eslint.config.js`, ESLint 9 + typescript-eslint)
  with per-directory overrides (Node globals for `apps/api`, browser globals
  - `react-hooks`/`react-refresh` rules for `apps/web`), plus Prettier
    (`.prettierrc.json`) wired through `eslint-config-prettier` so the two
    don't fight. Both run from the repo root (`npm run lint`, `npm run format`).
- Backend (`apps/api`): Express + TypeScript app factory (`createApp()`,
  separated from `server.ts` so it's testable without binding a port), Zod
  env validation (`src/config/env.ts`, fails fast with a clear message on
  invalid config), Helmet + CORS, a centralized error handler
  (`src/middleware/errorHandler.ts`) distinguishing Zod validation errors,
  `AppError` operational errors, and unhandled exceptions, `pino`/`pino-http`
  structured logging, `GET /api/health`, and graceful shutdown on
  SIGTERM/SIGINT with a 10s force-exit fallback.
- Frontend (`apps/web`): Vite + React + TypeScript + Tailwind, an
  `apiClient`/`healthService` abstraction (no raw `fetch` in components), a
  `useHealth` hook with explicit loading/success/error states, and an
  `App` shell rendering a `HealthStatus` card that surfaces all three states.
- A single root `.env` covers both apps: `apps/api/src/config/env.ts` loads
  it explicitly via `path.resolve(process.cwd(), "../../.env")` (since `npm
run dev --workspace apps/api` sets cwd to `apps/api`), and
  `apps/web/vite.config.ts` sets `envDir` to the repo root so Vite's
  `VITE_*` loading points at the same file instead of requiring a second copy.
- A Vitest + Supertest test for `GET /api/health` (200 + shape) and the 404
  fallback (`apps/api/src/routes/__tests__/health.test.ts`).

**Why**: Phase 1's goal is proving the full stack wiring — TS build, lint/
format, env config, CORS, frontend→backend fetch — works before any domain
logic (MongoDB, auth) is added, per the phased plan.

**Files created/modified**: `tsconfig.base.json`, `apps/api/tsconfig.json`,
`apps/web/tsconfig.json`, `eslint.config.js`, `.prettierrc.json`,
`.prettierignore`, root `package.json` (lint/format scripts + ESLint/Prettier
devDependencies), `apps/api/package.json` + `src/{app,server}.ts`,
`src/config/env.ts`, `src/utils/{logger,AppError}.ts`,
`src/middleware/{errorHandler,notFound}.ts`, `src/routes/{index,health.routes}.ts`,
`src/routes/__tests__/health.test.ts`, `apps/web/package.json`,
`vite.config.ts`, `tailwind.config.js`, `postcss.config.js`, `index.html`,
`src/{main.tsx,App.tsx,index.css,vite-env.d.ts}`,
`src/services/{apiClient,healthService}.ts`, `src/types/health.ts`,
`src/hooks/useHealth.ts`, `src/components/HealthStatus.tsx`.

**Technical approach**: Express 4 (stable, well-typed) over 5 (still
stabilizing tooling support). `pino` chosen over `morgan` for structured
JSON logs from day one (matches the master spec's Phase 12 observability
requirement) with `pino-pretty` only in development. Plain `useEffect`/
`useState` for the health check instead of TanStack Query — no caching/
mutation complexity to justify the dependency yet; TanStack Query is planned
starting Phase 5 when real data-fetching needs (lists, mutations, cache
invalidation) exist.

**Alternatives considered**: TypeScript project references
(`composite`/`tsc -b`) for `apps/web` — rejected after hitting a real
`TS6306`/`TS6310` conflict (`composite` requires emitting, `noEmit: true`
forbids it); since Vite does the actual build and `tsc` here is only a
type-check gate, a single non-composite config is simpler and sufficient.
Jest — rejected in favor of Vitest (ADR-005, already decided in Phase 0).

**Tests performed** (all actually run, not assumed):

- `npm run typecheck` (root, both workspaces) — **pass**, 0 errors, after
  fixing two real issues: a pino `LoggerOptions`/`exactOptionalPropertyTypes`
  mismatch in `logger.ts`, and the tsconfig project-reference conflict above.
- `npm run lint` — **pass**, 0 problems.
- `npm run format:check` — **pass** after one `npm run format` pass (5 files
  had formatting drift from manual edits).
- `npm audit` — **0 vulnerabilities**, after bumping the API's `vitest` pin
  from `^2.1.8` → `^5.0.1` to clear a moderate `@vitest/mocker` advisory
  found on first install.
- `npm run test --workspace apps/api` (Vitest + Supertest) — **pass**, 2/2
  tests (`GET /api/health` returns `{status:"ok", uptimeSeconds, timestamp}`;
  unknown route returns a structured 404).
- `npm run build` (both workspaces) — **pass**; web build output ~147KB JS
  (~47KB gzip), 8KB CSS.
- **End-to-end manual verification**: started both dev servers
  (`npm run dev:api`, `npm run dev:web`), confirmed via `curl`:
  `GET http://localhost:4000/api/health` → 200 with the expected JSON body;
  a simulated CORS preflight (`OPTIONS` with
  `Origin: http://localhost:5173`) → 204 with
  `Access-Control-Allow-Origin: http://localhost:5173`; the actual GET
  repeated with that Origin header → 200 with matching CORS headers — this
  is the exact request sequence a browser fetch from the Vite dev server
  would perform. Also fetched the Vite-dev-served `apiClient.ts` module
  directly and confirmed `import.meta.env.VITE_API_BASE_URL` was correctly
  resolved to `http://localhost:4000/api` from the root `.env` via the new
  `envDir` config. Both dev servers were stopped after verification.
  **Caveat**: the Claude-in-Chrome browser extension was not connected in
  this environment, so the `HealthStatus` card's actual on-screen rendering
  (loading → success transition) was not visually confirmed — only the
  underlying HTTP/CORS contract and env wiring it depends on. Worth a manual
  spot-check in an actual browser before treating Phase 1 as fully closed.

**Known limitations**:

- No frontend tests yet (deferred — not required for this phase; will be
  added alongside real components in Phase 4/5).
- `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` are optional in `env.ts` since
  auth doesn't exist yet; will become required (and validated for minimum
  entropy) in Phase 3.
- Visual browser rendering of the health card is unverified per the caveat
  above.
- `docker-compose.yml` for MongoDB was explicitly out of scope for this
  phase per instructions and does not exist yet.

**Next steps**: Phase 2 — MongoDB via Docker Compose, Mongoose connection
with startup/shutdown lifecycle, User and Project schemas with indexes,
centralized Mongoose error handling wired into the existing `errorHandler`.

## 2026-09-23 — Phase 2: Database Foundation

**What was implemented**:

- `docker-compose.yml`: a `mongo:7` service with a named volume
  (`devflow-mongo-data`) for persistence across restarts, credentials read
  from `.env` (`MONGO_ROOT_USERNAME`/`MONGO_ROOT_PASSWORD`/`MONGO_DB_NAME`,
  required via Compose's `${VAR:?error}` syntax — the container refuses to
  start without them), the port bound to `127.0.0.1:27017` only (not
  `0.0.0.0` — not reachable from the LAN), and a `mongosh`-based healthcheck.
- Root `package.json` scripts: `db:up`, `db:down`, `db:logs`, `db:reset`
  (the last one explicitly drops the volume — documented as destructive).
- `apps/api/src/config/database.ts`: `connectDB()` (bounded
  `serverSelectionTimeoutMS` via new `DB_CONNECT_TIMEOUT_MS` env var, default
  5000ms, so an unreachable DB fails fast instead of hanging 30s),
  `disconnectDB()`, `getDbState()`, and connection event logging
  (`error`/`disconnected`/`reconnected`).
- `apps/api/src/models/User.ts` and `Project.ts`: Mongoose schemas per the
  field tables in `docs/DATABASE_DESIGN.md`. `User.passwordHash` is
  `select: false`; `User.email` is unique + indexed; `Project.owner` is
  indexed (ObjectId ref to `User`).
- `GET /api/health/db`: new readiness endpoint (200 connected / 503
  otherwise), added alongside the unchanged `GET /api/health` liveness
  endpoint — deliberate liveness/readiness split so a DB outage doesn't
  make the whole API look down.
- `server.ts` now calls `connectDB()` independently of `app.listen()` (a DB
  outage doesn't prevent the process from starting) and `disconnectDB()`
  during graceful shutdown.
- Tests: `User.test.ts` / `Project.test.ts` (schema validation via
  `validateSync()`, no DB needed) and
  `config/__tests__/database.integration.test.ts` (real integration test
  against the Docker Mongo instance — connects for real, exercises the
  `GET /api/health/db` 200/503 transition, and proves the unique-email
  index throws a duplicate-key error on write). The integration suite uses
  `describe.skipIf` gated on an actual connection attempt at file load, so
  `npm test` still passes cleanly for anyone without Docker running,
  without silently skipping the check when Docker _is_ available.

**Why**: Establish a reliable, observable database foundation — connection
lifecycle, schema validation, and failure visibility — before building
authentication or any domain feature on top of it, per the phased plan and
this phase's explicit instructions.

**Files created/modified**: `docker-compose.yml`, `.env` / `.env.example`
(Mongo credentials + `DB_CONNECT_TIMEOUT_MS`), root `package.json` (`db:*`
scripts), `apps/api/package.json` (`mongoose` dependency, build script
change — see bug #2 below), `apps/api/src/config/env.ts` (`MONGODB_URI`
format validation, `DB_CONNECT_TIMEOUT_MS`), `apps/api/src/config/database.ts`
(new), `apps/api/src/models/{User,Project}.ts` (new),
`apps/api/src/routes/health.routes.ts` (added `/health/db`),
`apps/api/src/server.ts` (DB connect/disconnect wiring),
`apps/api/tsconfig.build.json` (new — see bug #2), `apps/api/vitest.config.ts`
(new — see bug #2), test files under `src/models/__tests__/` and
`src/config/__tests__/`, `docs/DATABASE_DESIGN.md` (new),
`docs/ARCHITECTURE.md` (new), `docs/DECISIONS.md` (ADR-006).

**Technical approach**: No repository abstraction layer — `models/` exports
the Mongoose models directly and route handlers (currently none touch the
DB yet) will call them directly, per the instruction to avoid an
abstraction layer without concrete benefit. Liveness/readiness split
(`/health` vs `/health/db`) instead of making the single health endpoint
depend on the database, so a DB outage is diagnosable rather than making
the whole API falsely appear down to monitoring. `serverSelectionTimeoutMS`
set explicitly (5s default) rather than left at Mongoose's 30s default,
so "the database is unreachable" surfaces in seconds during both real
usage and the verification steps below.

**Two real bugs found and fixed during verification** (not assumed —
found by actually running the checks):

1. **`NODE_ENV=development` in the shared root `.env` broke the production
   frontend build.** `npm run build --workspace apps/web` produced a
   334.87KB bundle (101.39KB gzip) with React development-mode warning
   strings present — roughly 2.3x the expected size. Root-caused by
   reproducing it: removing the `NODE_ENV` line from `.env` and rebuilding
   restored the correct 146.99KB (47.43KB gzip) output. `NODE_ENV` from a
   loaded `.env` file leaks into Vite/esbuild's dependency pre-bundling and
   forces React into its dev code path, independent of Vite's own
   correctly-resolved `production` build mode. Fixed by removing `NODE_ENV`
   from the shared `.env`/`.env.example` entirely — it belongs at the
   platform/process level, not in a file shared with a frontend build.
   Documented as ADR-006 in `docs/DECISIONS.md` with the measured
   before/after numbers so it isn't silently reintroduced.
2. **The production API build compiled test files into `dist/`, and Vitest
   then ran every test twice.** `apps/api/tsconfig.json`'s `include: ["src"]`
   had no exclusion for `**/*.test.ts`, so `tsc` happily emitted
   `dist/**/__tests__/*.test.js` alongside the real source. Vitest's
   default test discovery then picked up both the `.ts` source tests and
   the compiled `.js` copies in `dist/`, silently doubling every test count
   (caught because the reported total — 8 files / 36 tests — was exactly
   2x the expected 4 files / 20 tests). Fixed with two changes: (a) a new
   `apps/api/tsconfig.build.json` that extends the base config and excludes
   `src/**/__tests__/**` and `src/**/*.test.ts`, used by the `build` script
   instead of `tsconfig.json` (which stays the target for `typecheck`, so
   tests are still type-checked); (b) an explicit
   `apps/api/vitest.config.ts` restricting `test.include` to
   `src/**/*.test.ts` and excluding `dist/`, so this can't silently
   reoccur even from a stale build artifact.

**Tests performed** (all actually run):

- `npm run typecheck` — **pass**, 0 errors (both workspaces).
- `npm run lint` — **pass**, 0 problems.
- `npm run format:check` — **pass**.
- `npm run test --workspace apps/api` — **pass**, 17/17 run + 1 skipped
  (the "no DB reachable" placeholder, correctly skipped since Docker Mongo
  was up) = 18 total, correct count confirmed after fixing bug #2 above
  (was falsely reporting 36 before the fix).
- `npm run build` (both workspaces) — **pass**; web bundle back to
  146.99KB/47.43KB gzip after the ADR-006 fix; confirmed `dist/` contains
  no `.test.js` files after the tsconfig.build.json fix.
- **Docker verified directly, not assumed**: `docker info` confirmed the
  daemon was running before starting; `docker compose up -d mongo` pulled
  `mongo:7` and started the container; `docker compose ps` showed
  `(healthy)`; `docker exec devflow-mongo mongosh --eval
"db.getSiblingDB('admin').auth(...)"` confirmed the configured
  credentials actually authenticate.
- **API ↔ MongoDB connectivity, both dev (`tsx watch`) and the compiled
  production build (`node dist/server.js`)**: started each, confirmed
  `MongoDB connected` in logs and `GET /api/health/db` → `200
{"status":"ok","db":"connected"}`.
- **Failure-mode verification (the part most likely to be asserted without
  being checked — actually checked here)**: ran `docker compose stop mongo`
  while the API was live. `GET /api/health` stayed `200` (liveness
  unaffected). `GET /api/health/db` correctly returned `503
{"status":"error","db":"disconnected","message":"Database is not
connected"}`. The API process did not crash. Logs showed a clear `WARN:
MongoDB disconnected`. Ran `docker compose start mongo` again: Mongoose
  reconnected automatically with no process restart, logged `INFO: MongoDB
reconnected`, and `GET /api/health/db` returned to `200` within seconds.
- `GET /api/health` behavior/response shape is unchanged from Phase 1
  (same test in `health.test.ts`, still passing) — confirmed database work
  did not regress it.

**Known limitations**:

- Graceful shutdown (`disconnectDB()` on SIGTERM/SIGINT) is exercised by
  `database.integration.test.ts`'s `afterAll` hook (which calls the same
  `disconnectDB()` used in the shutdown handler) but was **not** verified
  via an actual OS-level `SIGTERM` delivered to a running process — sending
  real POSIX signals to a backgrounded Windows process through this
  environment's shell tooling proved unreliable (Windows has no true signal
  equivalent; `Stop-Process -Force` force-kills rather than signaling).
  Worth a manual `Ctrl+C` check against `npm run dev:api` in an interactive
  terminal.
- No password hashing logic yet — `User.passwordHash` is schema-ready but
  nothing populates it until Phase 3 (registration).
- No authorization logic yet — `Project.owner` exists and is indexed, but
  nothing enforces "only the owner can access their project" until Phase 3.
- `MONGO_ROOT_PASSWORD` in the local `.env` is a locally-generated random
  value; it is git-ignored (confirmed via `git status --ignored`) and never
  logged (checked: no log statement in `database.ts` or elsewhere includes
  the connection string or credentials).
- `docs/SECURITY.md` doesn't exist yet (deferred to Phase 10 per the
  phased plan) — the "don't expose MongoDB publicly" requirement for this
  phase is satisfied by binding to `127.0.0.1` in `docker-compose.yml`
  (commented inline) rather than a separate security doc for now.

**Next steps**: Phase 3 — authentication (registration/login/JWT), bcrypt
password hashing wired to `User.passwordHash`, protected-route middleware,
project ownership authorization checks.

## 2026-09-23 — Phase 3: Authentication & Authorization

**What was implemented**:

- **Token strategy documented first, per instructions**: `docs/DECISIONS.md`
  ADR-007 — a single JWT access token in an httpOnly, `SameSite=Lax` cookie,
  no refresh token this phase. Written and reasoned through _before_ any
  auth code, since it drove the shape of everything downstream.
- **Backend structure introduced**: `controllers/`, `services/`,
  `validators/` layers (flagged in Phase 2's architecture doc as "once real
  domain logic exists" — this is that point). `auth.service.ts`
  (register/login/session lookup), `project.service.ts` (ownership-aware
  CRUD queries), thin controllers, Zod validators for both resources.
- **Password security**: `bcryptjs`, 12 salt rounds
  (`utils/password.ts`). A timing-safety helper
  (`getDummyHashForTimingSafety`) runs a real bcrypt compare against a
  fixed dummy hash even when the login email doesn't exist, so response
  timing can't reveal account existence.
- **JWT**: `utils/jwt.ts` — `signAccessToken`/`verifyAccessToken`, wraps
  every `jsonwebtoken` failure mode (expired, malformed, wrong signature)
  into a single `InvalidTokenError` so callers never see or leak the
  library's internal error type.
- **Cookie handling**: `utils/authCookie.ts` — single source of truth for
  the cookie name/attributes (`httpOnly`, `sameSite: "lax"`,
  `secure: NODE_ENV === "production"`, `maxAge` parsed from
  `JWT_ACCESS_TTL`), shared between setting (login/register) and clearing
  (logout) so they can't drift out of sync. `cookie-parser` added to
  `app.ts` to read it.
- **Routes**: `POST /api/auth/{register,login,logout}`,
  `GET /api/auth/me`, and `POST/GET/GET/PATCH/DELETE /api/projects[/:id]`
  — all requiring auth via `requireAuth` middleware except register/login/
  logout. Register and login are rate-limited (`authLimiter`,
  `AUTH_RATE_LIMIT_MAX` per `AUTH_RATE_LIMIT_WINDOW_MS` per IP; disabled
  when `NODE_ENV=test` to avoid flaky 429s from the test suite's own
  deliberate invalid-attempt cases).
- **Project ownership authorization**: `project.service.ts`'s queries bake
  `owner: req.user.id` directly into `findOne`/`findOneAndUpdate`/
  `deleteOne` filters — ownership is enforced by the query, not a
  fetch-then-check. A project that exists but belongs to someone else
  returns `404` (not `403`) — deliberately indistinguishable from "doesn't
  exist," so a non-owner can't use the status code to confirm an ID is
  real. Malformed ObjectIds return `400` (validated explicitly in the
  service, plus a defensive `mongoose.Error.CastError` → `400` mapping
  added to `errorHandler.ts` for any other future route).
- **User model hardening**: added a `toJSON` transform stripping
  `passwordHash`/`__v` — defense in depth alongside the existing
  `select: false`, so it can't leak through generic serialization even if
  a future query re-selects it.
- **Logging hardening**: `pino`'s `redact` option now strips
  `req.headers.cookie`, `req.headers.authorization`, and
  `res.headers["set-cookie"]` from every log line — without this,
  `pino-http`'s default header logging would have put the raw JWT into
  every request log.
- **Env changes**: `JWT_ACCESS_SECRET` is now **required** (was optional in
  Phase 1's scaffold), validated ≥32 characters — the app refuses to boot
  with a missing/weak secret. `JWT_ACCESS_TTL` default changed `15m` → `1h`
  (see ADR-007's trade-off reasoning). `JWT_REFRESH_SECRET`/
  `JWT_REFRESH_TTL` removed (unused, dead config for a feature that doesn't
  exist). `RATE_LIMIT_WINDOW_MS`/`RATE_LIMIT_MAX` (unused since Phase 1)
  replaced with `AUTH_RATE_LIMIT_WINDOW_MS`/`AUTH_RATE_LIMIT_MAX`, now
  actually wired to the auth limiter.
- **Frontend**: `apiClient.ts` now sends `credentials: "include"` on every
  request (required for the cookie) and gained `post`/`patch`/`delete`
  methods (plus 204-No-Content handling for the upcoming delete-project
  flow). `AuthContext`/`useAuth` (React Context — not a new state library,
  per instructions) manage `loading | authenticated | unauthenticated`
  state, checking `GET /api/auth/me` once on mount so a page refresh keeps
  the session. `LoginForm`/`RegisterForm` (`react-hook-form` + a Zod
  resolver for client-side feedback; backend remains authoritative
  regardless), `AuthPage` (toggles between them), `Dashboard` (protected
  placeholder — real project UI is Phase 5). `App.tsx` is the current
  protected-route boundary (see Known Limitations — no router yet).
- **Frontend test infra added**: `apps/web` had no test setup before this
  phase — added Vitest + `jsdom` + React Testing Library +
  `@testing-library/user-event`, `vitest.config.ts`, and a setup file.

**Why**: This phase is explicitly security-sensitive per the instructions
— correctness and testability were prioritized over feature breadth (no
refresh tokens, no email verification, no password reset — all deferred
and documented as deliberate scope decisions, not oversights).

**Files created/modified**: too many to list individually here in full —
see the file tree under `apps/api/src/{controllers,services,validators,
middleware,utils,models,routes,types}` and `apps/web/src/{context,hooks,
components/auth,components/forms,services,types,validators}`. Full list
recoverable via `git status`/`git diff` for this checkpoint.

**Technical approach**: Express 4 requires explicit handling of rejected
promises in async route handlers (`utils/asyncHandler.ts`) — without it, a
thrown error in an `async` controller would become an unhandled rejection
and never reach `errorHandler.ts`. bcryptjs (pure JS) chosen over native
`bcrypt` for portability — no native compilation toolchain assumed on the
host. React Context chosen over a state-management library for the single
piece of genuinely global state (the current user) — not justified to add
Redux/Zustand for one value.

**Alternatives considered**: JWT in `localStorage` + `Authorization`
header (rejected — XSS token theft risk; full reasoning in ADR-007). A
repository abstraction layer over Mongoose (rejected — `project.service.ts`
calls `Project`/`User` models directly; two models don't justify the
abstraction yet). Refresh-token rotation (deferred — meaningfully larger
feature, explicitly out of scope per the phase instructions' emphasis on
correctness/testability over breadth).

### Two real bugs found and fixed during this phase's verification

1. **Unscoped router middleware intercepted unrelated requests.**
   `projectRouter.use(requireAuth)` was originally mounted with
   `apiRouter.use(projectRouter)` (no path prefix). Express applies a
   router's unscoped `.use()` middleware to _every_ request that reaches
   that router, including ones matching no route inside it. Result:
   `GET /api/does-not-exist` returned `401` instead of falling through to
   the `404` handler — caught immediately because the _existing_ Phase 1
   `health.test.ts` 404 test started failing the moment the project router
   was wired in (`npm run test --workspace apps/api` went from 47 passed/
   1 failed to, after the fix, 48 passed). Fixed by mounting both
   `authRouter` and `projectRouter` at explicit prefixes
   (`apiRouter.use("/auth", authRouter)`,
   `apiRouter.use("/projects", projectRouter)`) instead of leaving path
   resolution to each router's own route definitions. Documented in
   `docs/ARCHITECTURE.md`.
2. **`FormField` dropped `react-hook-form`'s ref, breaking validation
   messages.** `FormField` was a plain function component; spreading
   `register("email")`'s returned props onto it (which includes a `ref`
   callback RHF needs attached to the real DOM `<input>`) triggered
   React's "Function components cannot be given refs" warning, and the
   input was never actually registered as RHF expects. Symptom: submitting
   an empty form showed generic messages that didn't match the intended
   per-field errors, and initial test runs additionally showed accumulated
   DOM across test cases (a _second_, unrelated bug — the test setup file
   never called Testing Library's `cleanup()` between tests, since this
   project imports test APIs explicitly rather than using Vitest's
   `globals: true`, so RTL's auto-cleanup detection never registered).
   Fixed both: wrapped `FormField` in `React.forwardRef`, and added an
   explicit `afterEach(cleanup)` to `apps/web/src/test/setup.ts`. After
   both fixes, all 12 frontend tests passed; two test _assertions_
   (written before the fixes, and never corrected) still failed for an
   unrelated reason — they expected Zod's `.email()` message for an empty
   string, but `.min(1, "...")` fires first in the chain, producing a
   "required" message instead. That was a wrong assumption in the test
   itself, not an implementation bug — fixed by correcting the assertion
   and adding a separate test for the actual malformed-email case.

**Tests performed** (all actually run):

- `npm run typecheck` — **pass**, 0 errors, both workspaces.
- `npm run lint` — **pass**, 0 problems (after removing one unused
  `beforeEach` import caught by the linter).
- `npm run format:check` — **pass**.
- `npm audit` — **0 vulnerabilities** after adding `bcryptjs`,
  `cookie-parser`, `express-rate-limit`, `jsonwebtoken` (backend) and
  `react-hook-form`, `@hookform/resolvers`, `zod`, plus the frontend test
  stack (`@testing-library/*`, `jsdom`) (frontend).
- `npm run test --workspace apps/api` — **pass**, 48 passed, 3 skipped
  (the "no DB" placeholders, correctly skipped since `npm run db:up` was
  active). Includes real bcrypt hashing, real JWT sign/verify against a
  genuinely expired token, and full auth + project-ownership flows against
  the live MongoDB container.
- `npm run test --workspace apps/web` — **pass**, 14 passed (after fixing
  the two bugs above).
- `npm run build` (both workspaces) — **pass**. Web bundle: 240.06KB
  (73.04KB gzip) — a reasonable increase from the Phase 2 baseline
  (146.99KB) reflecting `react-hook-form`/`@hookform/resolvers`/`zod` and
  the new auth UI; not the ~2x NODE_ENV-leak pattern from ADR-006, and
  `dist/` confirmed free of `.test.js` files.
- **Manual end-to-end verification against the real running system**
  (Docker Mongo + `npm run dev:api` + `npm run dev:web`), via `curl`:
  - Registered a real user — response contained no `passwordHash`, no raw
    token in the JSON body; `Set-Cookie` showed `HttpOnly`, `SameSite=Lax`,
    `Max-Age=3600` (matching the 1h TTL), no `Secure` flag (correct for
    local HTTP dev). Queried the database directly and confirmed the
    stored `passwordHash` verifies against the original password via
    `bcrypt.compare` and does **not** equal the plaintext.
  - `GET /api/auth/me` with no cookie → `401`; with the valid cookie →
    `200` with the correct user.
  - Registered a second user (User B) and confirmed: reading, updating,
    and deleting User A's project all returned `404`; re-fetched the
    project as User A afterward and confirmed it was **unchanged** by the
    rejected update attempt; a malformed project ID returned `400`; a
    well-formed but nonexistent ID returned `404`.
  - Login with the wrong password and login with a nonexistent email both
    returned the identical `401 "Invalid email or password"`.
  - Logged in again, then logged out, then confirmed `GET /api/auth/me`
    returned `401` afterward (cookie actually cleared).
  - Simulated the exact browser request sequence a `fetch(...,
{credentials:"include"})` call from `http://localhost:5173` would
    make: a CORS preflight `OPTIONS` request, then the credentialed
    `POST /api/auth/login` with an `Origin` header, then a follow-up
    `GET /api/auth/me` carrying the received cookie — all returned the
    correct `Access-Control-Allow-*` headers and expected bodies.
  - Fetched the Vite-dev-served `AuthContext.tsx` module directly and
    confirmed it transforms/serves without error.
  - Grepped the API's log output from this entire session: every
    `cookie`/`set-cookie` occurrence showed `"[redacted]"`; zero
    occurrences of any plaintext password used during testing.
  - Test data (the two manually-created users and the one project) was
    deleted from the database afterward via `mongosh`; both dev servers
    were stopped.
  - **Caveat, same as Phases 1–2**: the Claude-in-Chrome extension was not
    connected in this environment, so the login/register forms' actual
    on-screen rendering was not visually confirmed — only the underlying
    HTTP/CORS/cookie contract they depend on, plus the React Testing
    Library component tests. Worth a manual browser spot-check.

**Known limitations** (also in `docs/SECURITY.md`):

- No refresh-token rotation; no server-side token revocation (logout
  clears the cookie but doesn't invalidate it — both deliberate,
  documented trade-offs in ADR-007, not oversights).
- No email verification, no password reset flow, no account lockout beyond
  the rate limiter — all out of scope for this phase.
- No inactive/disabled account status field — not introduced since nothing
  in this phase needs it.
- `App.tsx`'s conditional-render auth gate is a temporary stand-in for a
  real `<ProtectedRoute>` — React Router doesn't exist until Phase 4.
- Rate limiting is in-memory and IP-based (documented scaling/proxy
  limitations in `docs/SECURITY.md`).
- Real OS-level `SIGTERM` graceful shutdown remains unverified in this
  environment (same Windows-signal-delivery limitation as Phases 1–2).
- Visual in-browser rendering of the new auth UI is unverified per the
  caveat above.

**Next steps**: Phase 4 — React Router, design tokens, a real application
shell/navigation, and refactoring `App.tsx`'s conditional auth gate into a
proper `<ProtectedRoute>` component.

## 2026-09-23 — Batch A (Phases 4–6): Frontend Shell, Engineering Workspace, Requirements & Tasks

Executed as one continuous batch per the instructions (internal checkpoints,
one consolidated verification at the end) rather than three separate
approval cycles. This entry covers all three phases together; see the
per-checkpoint breakdown below for what belonged to each.

### Checkpoint A — Inspection

Before writing code: re-read the existing `Project`/`User` models,
`project.service.ts`'s ownership-query pattern, `errorHandler.ts`,
`auth.middleware.ts`, `apiClient.ts`, and the Phase 3 test suite (all
already fresh from this session). Confirmed: no `packages/shared` content
existed yet; no frontend routing existed (`App.tsx` was still the Phase 3
conditional gate); no UI component library beyond `FormField`/
`TextareaField` existed. Decided to build on top of the existing
`project.service.ts` (`getProjectForOwner`, `requireValidObjectId`) rather
than duplicating its ownership-check pattern for the two new resources.

### Checkpoint B — Backend: Requirements & Tasks (Phase 6 data layer, built first since the UI needs it)

**What was implemented**:

- **Domain model decision recorded before coding** (per instructions):
  `docs/DECISIONS.md` ADR-008 — subtasks as separate `Task` documents with
  a `parentTask` self-reference, not embedded subdocuments. Reasoning:
  Batch B's dependency graph needs every task as a uniform node; the task
  list needs to filter/search across all tasks including subtasks in one
  query; no duplicated validation logic. See ADR-008 for the full
  trade-off discussion (explicit subtree-cascade-delete requirement,
  no enforced nesting depth, no multi-hop cycle detection).
- `models/Requirement.ts`: `project`/`owner` (denormalized, see below)
  refs, `title`/`description`, `status` (`draft|approved|implemented`),
  `priority` (shared enum with `Task`), `acceptanceCriteria: string[]`.
- `models/Task.ts`: `project`/`owner` refs, optional `requirement` ref,
  optional `parentTask` self-ref, `title`/`description`, `status`
  (`todo|in_progress|blocked|in_review|done`), `priority`,
  `acceptanceCriteria`. Deliberately **no `dependencies` field** —
  dependency edges are Batch B's concern and conceptually distinct from
  `parentTask` (per the instructions' explicit "avoid speculative fields").
- **Denormalized `owner`** on both new models (copied from the parent
  project at creation, never client-settable): makes every
  single-resource route (`GET/PATCH/DELETE /api/requirements/:id`,
  `/api/tasks/:id`) a single query-level-ownership-enforced query
  (`Model.findOne({_id, owner})`), exactly matching `Project`'s existing
  pattern, instead of a two-step fetch-then-check-parent-project pattern.
- `project.service.ts`'s `requireValidObjectId` exported (was private) and
  reused by the new services rather than duplicated. `deleteProjectForOwner`
  extended to cascade-delete a deleted project's requirements and tasks
  (`Promise.all([Requirement.deleteMany, Task.deleteMany])`, both scoped by
  `project` _and_ `owner` as defense in depth).
- `services/requirement.service.ts`: `createRequirement`/
  `listRequirementsForProject` call `getProjectForOwner` first (404s if the
  `:projectId` isn't the caller's, before any read/write happens);
  `getRequirementForOwner`/`updateRequirementForOwner`/
  `deleteRequirementForOwner` are single-query ownership-enforced.
  Deleting a requirement clears (`$set: {requirement: null}`) rather than
  cascades to referencing tasks — a task's identity isn't owned by the
  requirement the way a subtask is owned by its parent.
- `services/task.service.ts`: same ownership pattern, plus
  `assertRequirementInProject`/`assertParentTaskInProject` — a
  `requirementId`/`parentTaskId` in the create/update body is validated to
  (a) exist, (b) be owned by the caller, **and** (c) belong to the _same_
  project as the task being written; a self-parent (`parentTaskId ===
taskId`) is explicitly rejected. `deleteTaskForOwner` does a BFS over
  `parentTask` references to collect and delete a task's full subtask
  subtree in one `deleteMany`, not just its direct children.
  `listTasksForProject` builds its filter from validated query params —
  `parentTaskId=none` → top-level only, `parentTaskId=<id>` → that task's
  direct subtasks, omitted → no filter (flat, both).
- `validators/{requirement,task}.validators.ts`: Zod schemas for
  create/update bodies **and** list-query filters
  (`listRequirementsQuerySchema`, `listTasksQuerySchema` — status/priority
  enum validation, ObjectId-format validation for `requirementId`/
  `parentTaskId`/`search`).
- `middleware/validate.ts` gained `validateQuery` (parallel to the
  existing `validateBody`) — attaches the parsed result to
  `req.validatedQuery` rather than reassigning `req.query` in place
  (avoids relying on `req.query` being safely mutable across Express
  versions). `types/express.d.ts` extended with `validatedQuery?: unknown`.
- `controllers/{requirement,task}.controller.ts`: thin, same pattern as
  `auth.controller.ts`/`project.controller.ts`.
- `routes/{requirement,task}.routes.ts`: **each exports two routers** —
  a `Router({ mergeParams: true })` collection router mounted at
  `/api/projects/:projectId/requirements` (or `.../tasks`, `:projectId`
  living in the _mount path_ — Express supports params there) for
  list/create, and a plain router mounted at `/api/requirements` (or
  `/api/tasks`) for get/update/delete-by-id. Both mounted at explicit
  prefixes in `routes/index.ts` — the Phase 3 router-scoping lesson
  applied proactively this time, not re-learned the hard way.

**Why**: Requirements and tasks are the foundation the eventual AI planner
(Batch B) writes into — the phase instructions are explicit that the app
must be "fully usable without AI" first, and that the data model must be
"compatible with Batch B's dependency engine" without a rewrite. Building
the backend before the UI let the UI be built against a real, already-
tested contract rather than a guessed one.

**Tests added**: `models/__tests__/{Requirement,Task}.test.ts` (schema
validation, no DB), `routes/__tests__/{requirement,task}.integration.test.ts`
(real MongoDB — full CRUD, cross-user denial with confirmed no-mutation,
cross-project reference rejection, self-parent rejection, unowned/
nonexistent reference rejection, `parentTaskId`/`status`/`priority`
filtering, cascade-delete of subtasks, requirement-delete clearing task
references, malformed-vs-missing ID status codes, unauthenticated → 401
on every operation). `testHelpers.ts` gained `createTestProject`.

**Checkpoint B validation run**: `npm run typecheck --workspace apps/api`
— pass after fixing one real `exactOptionalPropertyTypes` mismatch in
`task.service.ts`'s `assertReferences` helper (same class of issue seen
repeatedly since Phase 1 — a function parameter typed
`{x?: string | null}` needs the explicit `| undefined` too under this
tsconfig flag). `npm run lint` — pass. `npm run test --workspace apps/api`
— initially failed: an unscoped `projectRouter`-style issue did **not**
recur (the lesson was applied), but see the flaky-test bug below.

### Checkpoint C — Frontend Shell & Routing (Phase 4)

**What was implemented**:

- **Dependencies added** (each evaluated against necessity/existing-tool/
  maintenance-cost per the instructions — full reasoning in
  `docs/DECISIONS.md` ADR-009): `react-router-dom`, `@tanstack/react-query`
  (this is the point flagged in Phase 1's ADR as "planned starting Phase 5
  when real caching/mutation needs exist" — four resources with list/
  create/update/delete and cross-resource cache invalidation is exactly
  that need), `@radix-ui/react-dialog` (the one UI-library dependency —
  focus-trapping/Escape/click-outside for a modal is genuinely easy to get
  subtly wrong by hand), `lucide-react` (per the explicit "use Lucide
  icons consistently" instruction). shadcn/ui's full CLI toolchain was
  considered and rejected — this batch needs one hard primitive (Dialog),
  not a dozen generated components.
- `tailwind.config.js`: added `success`/`warning`/`danger` as semantic
  aliases onto Tailwind's built-in `emerald`/`amber`/`red` palettes
  (`tailwindcss/colors`) — one consistent meaning per status color, no
  parallel custom scale to maintain.
- `main.tsx`: wraps the app in `QueryClientProvider` (new) and
  `BrowserRouter` (new), outside `AuthProvider`.
- `routes/ProtectedRoute.tsx` / `PublicOnlyRoute.tsx`: never redirect while
  `useAuth().status === "loading"` — redirecting during the initial
  `GET /api/auth/me` check (rather than waiting for it to resolve) is
  exactly the authentication-loop / false-redirect-flash the instructions
  warn against for an already-logged-in user refreshing the page.
- `components/ui/{Button,Card,Badge,EmptyState,LoadingState,ErrorState,
Dialog,ConfirmDialog}.tsx`, `components/forms/{TextareaField,SelectField}.tsx`
  (alongside the existing `FormField`, also `forwardRef` for the same
  react-hook-form reason). `lib/statusMeta.ts` — one place mapping every
  status/priority enum value (project, requirement, task) to a label +
  `Badge` tone, instead of a `switch` statement duplicated per component.
  Status/priority is always shown as text + color together, never color
  alone (WCAG 1.4.1).
- `components/layout/AppLayout.tsx`: sidebar nav (desktop, `≥768px`)
  collapsing into a header-triggered dropdown (mobile), current user +
  logout in the header, `NavLink`-driven active-route highlighting.
- **Removed** the Phase 3 `components/auth/AuthPage.tsx` (toggle-based
  login/register switch) and `components/Dashboard.tsx` (monolithic
  authenticated view) — both superseded by real routes
  (`pages/{Login,Register}Page.tsx`, `pages/DashboardPage.tsx`). No
  duplicate components left behind.
- `LoginForm`/`RegisterForm` updated to use `<Link to="/register">`/
  `<Link to="/login">` instead of the old `onSwitchTo*` callback props,
  now that real routes exist for each.
- `App.tsx` rewritten as the actual route tree (see Architecture doc for
  the full tree) — `/`, `/login`, `/register`, `/app/*` (protected,
  `AppLayout`), `*` → `NotFoundPage`.

**Why**: Phase 4's job is the shell everything else in this batch hangs
off of — protected routing, a design system, and reusable primitives,
built once rather than ad hoc per page.

**Checkpoint C validation run**: `npm run typecheck --workspace apps/web`
found real issues (see Bugs below) before passing. `npm run lint` — pass
after moving `useProjectContext` out of `ProjectDetailLayout.tsx` into its
own file (a `react-refresh/only-export-components` warning — a file
exporting both a component and a non-component hook breaks Vite's fast
refresh for that file).

### Checkpoint D & E — Projects, Requirements, Tasks UI (Phases 5–6)

**What was implemented** (combined into one checkpoint in practice, since
the pages share the same query/form/dialog patterns):

- `services/{project,requirement,task}Service.ts` — one function per API
  operation; task/requirement list filters built with `URLSearchParams`.
- `queries/{project,requirement,task}Queries.ts` — TanStack Query hooks.
  Mutations invalidate the relevant cache keys on success — notably,
  deleting a requirement invalidates **both** `["requirements", projectId]`
  and `["tasks", projectId]`, since it changes tasks that referenced it.
- `pages/DashboardPage.tsx`: total/active/completed project counts and a
  "recently updated" list, all derived client-side from the single
  `GET /api/projects` response already fetched — no fabricated numbers,
  and no task-count aggregation (would need an N+1 fetch or a dedicated
  endpoint that doesn't exist — documented as an explicit gap, not faked).
- `pages/ProjectsPage.tsx`, `pages/NewProjectPage.tsx`,
  `pages/project/{ProjectDetailLayout,ProjectOverviewTab,
ProjectRequirementsTab,ProjectTasksTab}.tsx` — list/create/detail with
  tabs. `ProjectDetailLayout` fetches the project once and shares it with
  its three tabs via `<Outlet context={project}>`/`useOutletContext`, so
  the tabs don't each re-fetch it. `ProjectOverviewTab` has inline
  edit-in-place and the delete-confirmation flow; also contains the
  current placeholder for AI planning/dependency-graph integration points
  (explicitly labeled "coming," never fake results).
- `components/{projects,requirements,tasks}/*Form.tsx` — one form per
  resource (react-hook-form + Zod resolver), reused for create and edit.
  Acceptance criteria are entered as one item per line in a single
  textarea rather than a dynamic add/remove field list (same result, far
  less code — `criteriaTextToArray`/`criteriaArrayToText`).
- `pages/project/ProjectTasksTab.tsx` — the largest page. Filter controls
  (status/priority/requirement/search, all server-validated query params);
  fetches the project's **flat, already-filtered** task list in one query
  and groups it into a top-level/subtask tree **client-side**, rather than
  lazy-fetching each expanded parent's children — deliberate, since
  `task.service.ts`'s `listTasksForProject` already supports arbitrary
  combined filters server-side and a single round-trip is simpler than N.
  A subtask whose parent didn't also match the filter is still shown (as
  its own root row), never silently dropped. Inline status/priority
  `<select>` quick-change per task card (no need to open the edit dialog
  for the common case); "Add subtask" opens the same `TaskForm` with
  `parentTaskId` pre-set programmatically (not a user-facing field, to
  avoid exposing the self-parent/cross-project edge cases in the UI at all).

**Why**: This is the actual "engineering workspace" the product is about —
manual-first requirement and task management, per the explicit instruction
that AI-assisted decomposition (Batch B) must be additive to, not a
prerequisite for, basic project planning.

### Bugs found and fixed during this batch's verification

1. **`exactOptionalPropertyTypes` mismatches (backend and frontend), same
   recurring class of issue as every previous phase.** `tsc` caught ~10
   instances across `task.service.ts` and several frontend form/query
   files where an interface property typed `foo?: string` was fed a value
   whose real type was `string | undefined` (e.g. from a Zod-optional
   field or a conditional object literal) — this tsconfig flag treats
   "may be omitted" and "may be explicitly undefined" as different types.
   Fixed by widening each affected property to `foo?: string | undefined`
   at the actual point of mismatch (not blanket-disabling the flag, which
   is what makes it useful in the first place).
2. **Two frontend tests failed on "found multiple elements with role
   button" for "New Requirement"/"New Task."** Root-caused before
   "fixing": this is legitimate UI, not a bug — the page header's
   persistent action button and the empty state's own call-to-action
   button share the same accessible name by design (a common, acceptable
   pattern). Fixed the _tests_ (`getAllByRole(...)[0]`) rather than
   changing the UI to avoid a collision that isn't actually a problem.
3. **A genuinely flaky backend test** — `testHelpers.ts`'s `uniqueEmail()`
   combined a per-process counter with `Date.now()`; Vitest runs different
   test _files_ in separate worker processes, each starting its own
   counter at 0, so two files registering their first test user in the
   same millisecond could generate an identical email, and the second
   registration would fail with a 409 unrelated to what that test was
   actually checking. Reproduced the signature (passed in isolation,
   failed intermittently in the full suite — the tell for a cross-process
   collision rather than a logic bug), fixed with `crypto.randomUUID()`,
   verified by running the full backend suite three consecutive times
   afterward with zero failures.

### Consolidated Verification (Checkpoint F)

All actually run, not assumed:

- `npm run typecheck` (both workspaces) — **pass**, 0 errors, after fixing
  the `exactOptionalPropertyTypes` issues above.
- `npm run lint` (both workspaces) — **pass**, 0 errors (one harmless
  `react-refresh` warning remains in a test-only helper file,
  `apps/web/src/test/renderWithProviders.tsx`, which is never part of the
  shipped app bundle).
- `npm run format:check` — **pass** (after one `npm run format` pass).
- `npm run test --workspace apps/api` — **pass**, 82 passed, 5 skipped
  (the "no DB" placeholders), confirmed stable across 3 consecutive runs
  after the flaky-test fix.
- `npm run test --workspace apps/web` — **pass**, 32 passed.
- `npm audit` — **0 vulnerabilities**.
- `npm run build` (both workspaces) — **pass**. Web bundle: 400.32KB
  (122.15KB gzip) — grew from the Phase 3 baseline (240KB/73KB gzip) as
  expected for a router, a query cache, a modal library, and four new
  routed resources; `apps/api/dist` confirmed free of `.test.js` files.
- **Manual end-to-end verification against the real running system**
  (`npm run db:up` + both dev servers), via `curl`: registered a user,
  created a project, a requirement, a linked top-level task, and a
  subtask; confirmed `?parentTaskId=none`/`=<id>` filtering returns the
  correct sets; registered a second user and confirmed 404 on reading the
  first user's requirement/task and on creating a task under the first
  user's project; created a second project and confirmed a cross-project
  requirement link is rejected (400); **deleted the project and confirmed
  the requirement and task were actually gone afterward** (cascade delete
  verified, not just trusted from reading the code); grepped the API log
  for the session — zero leaked cookies/tokens/passwords, redaction
  confirmed working; simulated the exact CORS-preflight +
  credentialed-request cycle a browser would perform for a protected
  route. All test data deleted afterward, both dev servers stopped.
- **Browser verification**: attempted the Claude-in-Chrome extension —
  **not connected**, same as every phase in this project so far. This is
  recorded honestly as **not verified**, not glossed over: the new UI's
  actual on-screen rendering (forms, dialogs, the task tree, responsive
  nav collapse at mobile widths) was never visually confirmed in a real
  browser. What _was_ verified: React Testing Library component behavior
  (32 tests) and the curl-based HTTP/CORS/cookie contract above. A manual
  browser spot-check (`npm run dev:api` + `npm run dev:web`, open
  `localhost:5173`, register, create a project/requirement/task, resize to
  a mobile width) is a concrete recommended follow-up, not assumed done.

### Known limitations (also recorded in `docs/SECURITY.md` / `docs/PROJECT_OVERVIEW.md`)

- No AI planning, no dependency graph (Batch B, not started).
- Multi-hop `parentTask` cycles aren't detected (only direct self-
  parenting is rejected) — low real-world risk since the UI never offers
  a way to construct one, but not defended against at the API layer.
- No dashboard task-count aggregation across projects.
- No pagination on the task list.
- Visual browser rendering of the entire Batch A UI is unverified per the
  caveat above.
- Responsive/mobile layout has no automated test.

**Next steps**: Batch B — the `AIProvider` interface against Ollama
(`analyzeRequirement` first, Zod-validated output, graceful
provider-unavailable handling), then the dependency-graph engine in
`packages/shared` (cycle detection, topological sort, task readiness) with
a visualization wired into `ProjectOverviewTab`'s current placeholder.

## 2026-09-23 — Focused Corrective Pass: Multi-Hop `parentTask` Cycle Validation

**What was implemented**: Inspected `task.service.ts`'s `assertReferences`
and confirmed the defect flagged in ADR-008/`docs/SECURITY.md`'s "known
limitation" was real, not just theoretical: only same-project membership
and direct self-parenting (`parentTaskId === taskId`) were checked on
`parentTaskId` writes — nothing walked the ancestor chain, so a multi-hop
cycle (e.g. build A←B←C via three creates, then `PATCH` A's parent to C)
was constructible through the live API. Added `assertNoCycle(ownerId,
proposedParentId, taskId)`: walks upward from the proposed parent via
`parentTask` links, rejecting (`400`, "This parent assignment would create
a cycle in the task hierarchy") if the walk ever reaches the task being
updated. A `visited` `Set` plus a `MAX_ANCESTOR_HOPS` cap bound the
traversal even against a hypothetical pre-existing corrupt chain. Wired
into `assertReferences` only when `selfId` is set (i.e. only on update —
a newly created task can't yet be anyone's ancestor, so create needs no
walk). No API contract change, no route/controller/validator changes, no
unrelated refactor.

**Why**: Explicitly requested as a narrowly-scoped pre-Batch-B corrective
pass — the app's ownership/cross-project checks were already solid, but
this one hierarchy-integrity gap remained.

**Files changed**: `apps/api/src/services/task.service.ts` (added
`assertNoCycle`, wired into `assertReferences`), one type annotation fix
(`TS7022` — `parent` needed an explicit `Pick<TaskDocument, "parentTask">`
annotation to resolve a self-referential inference error inside the loop).
`apps/api/src/routes/__tests__/task.integration.test.ts` (new
`"parentTask cycle prevention"` nested `describe` block, 9 tests, using
its own fresh tasks rather than the file's shared/mutated `taskId`/
`subtaskId` state — kept deterministic and isolated per instructions).
`docs/DECISIONS.md` (ADR-008 updated in place — the original "rejected an
explicit ancestor-cycle check... isn't currently possible" reasoning was
wrong and is corrected, not silently left stale). `docs/SECURITY.md` and
`docs/PROJECT_OVERVIEW.md`/`docs/TESTING.md` (the "known limitation" /
"not tested" entries updated to reflect the fix rather than left
inaccurate).

**Tests added** (all passing against the real database): valid parent
assignment; direct self-parenting rejected; 2-hop cycle rejected (with
confirmation the rejected update didn't mutate data); 3-hop cycle
rejected; 4-hop cycle rejected (confirmed the whole chain untouched);
valid re-parenting across a different branch of the same tree succeeds;
cross-project parent reference still rejected (confirms the cycle check
didn't regress the existing check); cross-user parent reference still
rejected (same); a valid 5-node acyclic chain re-parented within itself
(E onto A) is **not** falsely rejected — directly exercises "do not
accidentally reject valid acyclic hierarchies."

**Commands run and results** (targeted first, full suite once, per
instructions — no repeated expensive runs):

- `npm run typecheck --workspace apps/api` — failed once (`TS7022`
  self-referential inference on the unannotated `parent` variable), fixed
  with an explicit `Pick<TaskDocument, "parentTask">` annotation, then
  **pass**.
- `npm run lint` — **pass** (0 errors; the one pre-existing unrelated
  `react-refresh` warning in a frontend test-helper file is untouched by
  this change).
- Typecheck failed once more after adding the tests (`TS2375`, the same
  recurring `exactOptionalPropertyTypes` class of issue — a test helper's
  return type `{status: number; id?: string}` needed `id: string |
undefined` instead), fixed, then **pass**.
- `npx vitest run src/routes/__tests__/task.integration.test.ts`
  (targeted) — **pass**, 24 passed, 1 skipped.
- `npm run format` / `format:check` — **pass**, no changes needed beyond
  what `format` already applied.
- `npm run test --workspace apps/api` (full backend suite, run once to
  check for regressions) — **pass**, 91 passed, 5 skipped (up from 82
  passed pre-change — exactly the 9 new tests, no regressions elsewhere).

**Remaining limitations/concerns**:

- The cycle check adds one MongoDB round-trip per ancestor hop on every
  `parentTaskId` update — acceptable at realistic hierarchy depths (a
  handful of levels); would need revisiting (e.g. a materialized-path or
  closure-table representation) only if task hierarchies ever grow
  pathologically deep, which nothing in the current product justifies
  building for now.
- No automated test exercises the `MAX_ANCESTOR_HOPS` cap itself (would
  require constructing a 1000+-task chain) — the `visited` `Set` is the
  actual correctness guarantee; the hop cap is a secondary, defense-in-
  depth bound, not separately load-tested.
- Did not re-run the full frontend suite or a manual browser/curl
  end-to-end pass for this change, since it's backend-only, no API
  contract changed, and the full backend suite (real database, not
  mocked) already re-validated every existing ownership/cross-project/
  cross-user path alongside the new cycle checks — consistent with the
  instruction to avoid repeated expensive verification without a failure
  to investigate.

## 2026-09-23 — Batch B: AI Planning + Dependency Graph Foundation

**What was implemented**: A server-side `AIProvider` abstraction
(`services/ai/aiProvider.ts` interface + `ollamaProvider.ts` real Ollama
implementation + `index.ts` lazy singleton, the mock seam for tests) —
never called from the frontend, and manual (non-AI) workflows remain fully
usable if Ollama is down. A deterministic, framework-agnostic dependency
graph engine (`lib/dependencyGraph.ts`): node/edge validation (duplicate
edges, self-dependencies, dangling references, cycles all rejected),
Kahn's-algorithm topological sort with deterministic tie-breaking, and
ready/blocked task lookups. Edge direction convention: `{from: "A", to:
"B"}` means "A depends on B; B must complete before A is ready" — the same
convention used by the AI plan schema's `dependsOn`, `Task.dependencies`,
and every graph function, documented in `docs/DEPENDENCY_ENGINE.md`. A
structured, Zod-validated AI plan schema (`validators/aiPlan.validators.ts`)
with temp task identifiers, bounds on task/list-item/text sizes, and full
semantic + graph validation reused by both plan generation and plan
editing — malformed or invalid AI output is never persisted or
auto-approved. A `Plan` model (`needs_review → approved | rejected`,
immutable once reviewed) and `plan.service.ts` implementing the full
workflow: auth → ownership → input validation → prompt → parse → Zod
validate → graph validate → persist as `needs_review`, with every failure
mode (provider unavailable, timeout, malformed JSON, schema-invalid,
cyclic) rejected with nothing persisted. REST API for plan generation,
listing, retrieval, editing, approval, and rejection
(`controllers/plan.controller.ts`, `routes/plan.routes.ts`,
`routes/ai.routes.ts`), all ownership-enforced with the same 404-not-403
pattern as every other resource. `Task.dependencies` added to the `Task`
model, populated on plan approval by resolving the AI's temporary task ids
to real `Task` ObjectIds. A frontend planning tab (`ProjectPlansTab.tsx`):
requirement picker, generate button (disabled when the AI is unavailable
or no requirement is selected), a provider-unavailable warning banner, a
plans list, and a review dialog (assumptions/risks/suggested tasks in
computed topological order, approve/reject) — list-based review only, no
graph editor, as scoped.

**Why**: The core product differentiator — a requirement turned into a
structured, dependency-validated, human-reviewed implementation plan,
where the dependency logic is enforced by real code, not just AI prose.
Explicitly scoped to Batch B only (no Batch C/D work).

**Files changed**: see `PROJECT_DECISIONS.md`'s "What Exists Right Now"
tree and `docs/API_DOCUMENTATION.md`'s new "AI Status"/"Plans" sections for
the full file/endpoint list; not re-enumerated here to avoid duplication.

**Tests added**: `lib/__tests__/dependencyGraph.test.ts` (20, no DB),
`validators/__tests__/aiPlan.validators.test.ts` (12, no DB/AI),
`routes/__tests__/plan.integration.test.ts` (20 passed, 1 skipped — real
database, AI provider mocked via `vi.mock` with `importOriginal` to
preserve the real `AIProviderError` class, per ADR-012), and
`pages/project/__tests__/ProjectPlansTab.test.tsx` (5, frontend).

**Two real bugs found and fixed this batch** (both caught by actually
running tests/review, not assumed):

1. `approvePlanForOwner` returned stale `createdTasks` — the array
   collected `Task` documents from the first creation pass, before the
   second pass wrote `dependencies` to the database, so the API response
   showed `dependencies: []` even though `[]` → `[realId]` was correctly
   persisted. Caught by a test asserting `expected [] to deeply equal
[...]`. Fixed by re-fetching (`Task.find({_id: {$in: [...]}})`) after
   both write passes complete.
2. `deleteProjectForOwner`'s cascade delete covered `Requirement` and
   `Task` but not `Plan` — would have orphaned `Plan` documents referencing
   a deleted project. Caught during this batch's own review (not by an
   initially-failing test), fixed by adding `Plan.deleteMany({project,
owner})` to the cascade, and guarded with a new test.

**Consolidated verification pass** (run once at the end, per instructions
— not repeatedly during implementation):

- `npm run typecheck` (both workspaces) — **pass**, clean.
- `npm run lint` — **pass**, 0 errors (1 pre-existing, unrelated
  `react-refresh` warning in a frontend test helper).
- `npm run format:check` — **failed** initially: 13 newly-added Batch B
  files (mix of new source and updated docs) were unformatted. Fixed with
  `prettier --write` on exactly those 13 files, then **pass**.
- `npm run test` (both workspaces, one combined run) — **pass**: backend
  143 passed, 6 skipped (149 total, 15 test files); frontend 37 passed (8
  test files). Confirms all pre-existing functionality (auth, project/
  requirement/task/subtask CRUD, `parentTask` cycle protection, ownership)
  still passes alongside the new Batch B suites, in the same run.
- `npm run build` (both apps) — **pass**, clean; frontend bundle
  407.14 kB / 123.62 kB gzip (no `NODE_ENV`-leak regression — see ADR-006).
- Git diff/secret review: staged the full batch (`git add -A`), grepped
  the diff for password/secret/API-key/token patterns — only test-fixture
  placeholder values matched (e.g. `"correct horse battery staple"`,
  `"a-real-password-123"`), no real credentials. Confirmed `.env` is
  gitignored and was never staged. Confirmed no non-`localhost` URLs or
  tokens in the AI provider/env diff.
- Environment review found and fixed one real issue: `AI_MAX_RETRIES` was
  declared in `env.ts`'s schema and `.env.example`/`.env` but never
  actually read anywhere — `OllamaProvider` has no retry logic. Removed
  the dead config var (rather than adding unrequested retry behavior,
  which wasn't part of this batch's scope) from `env.ts`, `.env.example`,
  and `.env`. Re-ran typecheck and the full test suite afterward — same
  143/6-skipped + 37 pass counts, confirming the removal was safe.

No blocking failures found; the one formatting issue and one dead-config
issue were both fixed within this single consolidated pass, per
instructions.

**Remaining limitations/concerns**: no dedicated dependency-graph
visualization endpoint/UI (list-based review was the explicit scope for
this batch); `Task.dependencies` is populated only via plan approval, not
yet settable through the general task-update endpoint; no AI-specific rate
limiting; the AI planning tab's on-screen rendering wasn't visually
confirmed in a real browser (Claude-in-Chrome not connected in this
environment, same caveat as every prior phase — covered instead by the RTL
suite); no automated test exercises `OllamaProvider` against a real
running Ollama instance (always mocked in the suite, per ADR-012). See
`docs/PROJECT_OVERVIEW.md`'s "Known Limitations" and `docs/TESTING.md`'s
"Known Untested Areas" for the complete, non-duplicated list.

## 2026-09-23 — Local-First Product Alignment

**What was implemented**: Nothing code-level — this pass redefined
DevFlow's product direction (local-first, single-user, import-and-analyze
a real codebase) and reviewed the existing Batch A/B implementation
against it, documented in a new `docs/PRODUCT_SCOPE_LOCAL.md` and
`docs/DECISIONS.md` ADR-013. Inspected authentication/ownership, MongoDB,
the AI provider/plan/graph code, and frontend routing/copy against the
new direction. Decided: authentication and ownership are retained
(load-bearing across every model/service/route; "single-user" means one
person per instance, not "no login" — revisit only if ever proven to be
pure friction), MongoDB is retained (already loopback-only, no cloud
dependency to begin with), and no misleading multi-user/SaaS copy was
found in the actual UI (dashboard/login pages already read single-user) —
so no UI text changes were made.

**Why**: Explicitly requested product-direction pivot, to be completed
_before_ the next batch of feature work so that batch starts from an
honestly-scoped foundation rather than silently building on stale
assumptions.

**Files changed**: New `docs/PRODUCT_SCOPE_LOCAL.md`. Updated
`docs/DECISIONS.md` (ADR-013), `docs/ARCHITECTURE.md`, `docs/SECURITY.md`,
`docs/TESTING.md`, `docs/PROJECT_OVERVIEW.md`, `PROJECT_DECISIONS.md`,
`README.md`. No application code, schema, or test files changed.

**Real gap found and deliberately NOT closed**: reviewed the `Plan`
schema for evidence-backed-planning readiness and found real gaps (no
source-file references, no evidence/confidence fields, no confirmed/
inferred/proposed distinction). No schema fields were added, since none
had a consumer yet — adding unconsumed fields would repeat the exact
dead-config mistake (`AI_MAX_RETRIES`) just caught and fixed in Batch B's
own verification. The gap list itself, recorded once in ADR-013, is this
review's actual deliverable.

**Consolidated verification**: `npm run typecheck` (both apps) — pass.
`npm run lint` — pass, 0 errors (1 pre-existing unrelated warning).
`npm run format:check` — failed once on 2 doc files just edited, fixed
with `prettier --write`, then pass. `npm run test` (one combined run) —
143 passed/6 skipped backend, 37 passed frontend, identical to Batch B's
final numbers (confirms zero regressions from a documentation-only pass).
`npm run build` (both apps) — pass, no bundle-size change. Git diff
reviewed (doc-only, no secrets); `.env` confirmed still gitignored and
never staged.

**Remaining limitations/concerns**: none new — this pass didn't implement
anything that could introduce a limitation. The next batch (secure
filesystem boundary + read-only scanner) starts from here; see the entry
below.

## 2026-09-23 — Batch C1: Secure Filesystem Boundary + Deterministic Read-Only Scanner

**What was implemented**: A path-safety module
(`apps/api/src/lib/fsSafety.ts`) that canonicalizes a user-configured
source root via `fs.realpath` and provides a real `path.relative`-based
boundary check (`isPathInsideRoot`) — not a `startsWith` string
comparison, which would incorrectly treat a similarly-prefixed sibling
directory (`App-Outside`) as inside a root (`App`). UNC/device paths
(`\\...`) are rejected before any filesystem call. A deterministic,
read-only scanner (`apps/api/src/services/scanner.service.ts`) that
traverses a validated root using an explicit stack (not recursion),
sorts siblings for deterministic output, classifies each file by
category/language (`apps/api/src/lib/fileClassification.ts`, extension/
path-based only — no content inspection), applies a name-based
case-insensitive ignore policy (`node_modules`, `.git`, `dist`, etc.),
enforces configurable resource limits (max file size/files/depth/
directories/duration, checked cooperatively between entries), and never
follows a symlink or directory junction encountered during traversal
(detected via `fs.lstat().isSymbolicLink()` — confirmed empirically on
this Windows environment that this also catches junctions). Only
`fs.readdir`/`fs.lstat` are ever called against the scanned tree — no
write/delete/rename/exec call exists anywhere in this code path. A new
`Project.sourceConfig` (canonical path, safe display label, configured-at
timestamp) with `canonicalPath` `select: false` plus a `toJSON` transform
stripping it again — the same double-guard `User.ts` uses for
`passwordHash` — so the raw absolute path never reaches a client. A new
`Scan` model persists each scan's outcome/summary/item inventory (same
"own persisted model" pattern as `Plan`, not embedded). Backend API:
`PUT`/`GET /api/projects/:projectId/source` and
`POST /api/projects/:projectId/scans` + `GET .../scans/latest`, all
auth-required and ownership-enforced via the same `{_id, owner}` query
pattern as every other project-scoped resource. Frontend:
`ProjectScanTab.tsx` (source-directory form showing only the safe label,
"Run Scan" action, outcome badge, summary counts, limits-reached warning,
bounded inventory table), wired in as the workspace's fifth project tab.

**Why**: The stated foundation for DevFlow's Codebase Intelligence
system — a project must be safely, verifiably read-only-scannable before
any later batch can extract imports, build a real dependency graph, or
ground AI plans in actual source content. Explicitly scoped to this
foundation only; import extraction, dependency resolution, graph
visualization, and AI grounding were explicitly out of scope and are not
implemented.

**Files changed**: New —
`apps/api/src/lib/fsSafety.ts`, `apps/api/src/lib/fileClassification.ts`,
`apps/api/src/services/scanner.service.ts`,
`apps/api/src/services/sourceConfig.service.ts`,
`apps/api/src/services/scan.service.ts`, `apps/api/src/models/Scan.ts`,
`apps/api/src/validators/scan.validators.ts`,
`apps/api/src/controllers/scan.controller.ts`,
`apps/api/src/routes/scan.routes.ts`,
`apps/web/src/types/scan.ts`, `apps/web/src/services/scanService.ts`,
`apps/web/src/queries/scanQueries.ts`,
`apps/web/src/pages/project/ProjectScanTab.tsx`, plus test files (see
below). Updated — `apps/api/src/models/Project.ts` (`sourceConfig` field

- `toJSON` transform), `apps/api/src/config/env.ts` (`SCAN_MAX_*` vars),
  `apps/api/src/services/project.service.ts` (`Scan` added to the
  cascade-delete, from the start this time — see Batch B's `Plan`-cascade
  miss), `apps/api/src/routes/index.ts` (mounted `sourceRouter`/
  `scanRouter`), `apps/web/src/services/apiClient.ts` (added `put`, its
  first consumer), `apps/web/src/lib/statusMeta.ts` (`SCAN_OUTCOME_META`),
  `apps/web/src/pages/project/ProjectDetailLayout.tsx` (fifth tab),
  `apps/web/src/App.tsx` (route). Docs: `docs/DECISIONS.md` (ADR-014),
  `docs/ARCHITECTURE.md`, `docs/API_DOCUMENTATION.md`,
  `docs/DATABASE_DESIGN.md`, `docs/SECURITY.md`, `docs/TESTING.md`,
  `docs/PROJECT_OVERVIEW.md`, `docs/PRODUCT_SCOPE_LOCAL.md`,
  `PROJECT_DECISIONS.md`, `README.md`, `.env.example`.

**A mistake caught and fixed during writing, before any test ran**: an
early draft of `fileClassification.ts`'s `classifyFile` contained a dead,
nonsensical conditional branch left over from an abandoned approach
(`if (GENERATED_DIR_SEGMENTS.has(basename === relativePath.toLowerCase()
? "" : ""))`) — self-caught on re-reading the file, removed before it
ever ran, let alone shipped. Not a test-caught bug; recorded because it's
exactly the class of "looks complete but is dead" issue this batch's own
`docs/TESTING.md`/`docs/DECISIONS.md` warn about elsewhere (Batch B's
`AI_MAX_RETRIES`).

**A design ambiguity resolved during test-writing, not a code bug**: the
first `maxDepth` test assumed a directory _at_ the depth limit would be
descended into (with only its _children_ skipped). The actual, simpler
semantics — a directory at or beyond `maxDepth` is itself recorded as
skipped and never read — is what the code already did and is a
reasonable definition; the test's expectation was corrected to match,
and a clarifying comment was added to `scanner.service.ts` so this isn't
ambiguous to a future reader either.

**Tests added**: `lib/__tests__/fsSafety.test.ts` (17 passed, 1
conditionally skipped), `services/__tests__/scanner.test.ts` (14 passed,
1 conditionally skipped), `routes/__tests__/scan.integration.test.ts` (16
passed). The one skip in each of the first two files is a file-symlink
test — creating a _file_ symlink on Windows requires Administrator/
Developer Mode privileges; creating a directory _junction_ does not (a
genuinely different NTFS feature) — probed for real in a `beforeAll`
rather than assumed, and the junction-based equivalent test (needing no
elevated privilege) always runs and passed. `pages/project/__tests__/ProjectScanTab.test.tsx`
(7 passed) covers not-configured/configured/completed/warnings/failed/
empty-inventory states and confirms the raw path is never rendered.

**Consolidated verification** (run once at the end, per instructions):

- `npm run typecheck` (both workspaces) — **pass**.
- `npm run lint` — **pass**, 0 errors (1 pre-existing unrelated warning).
- `npm run format:check` — **pass** after `prettier --write` on the
  batch's own newly-added files.
- `npm run test` (one combined run) — **pass**: backend 190 passed, 8
  skipped (18 test files, up from 143 passed/6 skipped — exactly the 47
  new passed + 2 new skipped, no regressions elsewhere); frontend 44
  passed (9 test files, up from 37 — exactly the 7 new tests).
- `npm run build` (both apps) — **pass**.
- Git diff reviewed for the whole batch: grepped for password/secret/
  API-key/token patterns (only test-fixture placeholders matched, no
  real credentials); confirmed `.env` still gitignored and never staged;
  confirmed no scanner test left files behind in the OS temp directory
  beyond what each test's own cleanup removed.
- Environment review: added `SCAN_MAX_FILE_SIZE_BYTES`, `SCAN_MAX_FILES`,
  `SCAN_MAX_DEPTH`, `SCAN_MAX_DIRECTORIES`, `SCAN_MAX_DURATION_MS` to
  `env.ts`, `.env.example`, and `.env` — all five are actually read by
  `scan.service.ts`'s `limitsFromEnv()`, none left unused this time.

No blocking failures found during this pass.

**Remaining limitations/concerns**: filesystem boundary enforcement is
application-level, not OS sandboxing (no chroot/container/restricted OS
user — a bug elsewhere in the Node process isn't contained by this
boundary alone); classification is extension/path-based only, so a
renamed file is misclassified; scanning is synchronous with no background
job system, progress polling, or cancellation; reparse-point coverage is
verified for Windows directory junctions specifically, not every
OS-specific reparse-point type; per-item read/permission-denied errors
mid-traversal are exercised only via a genuine whole-root failure (a
directory deleted immediately before scanning), not a mid-scan
single-file race, since reliably inducing the latter would need either
elevated-privilege changes (unreliable here) or mocking `fs` internals
(wouldn't exercise the real implementation); no real UNC/network share
was tested end-to-end (only the pre-filesystem-call rejection path);
Batch C1's Scan tab UI wasn't visually confirmed in a real browser
(Claude-in-Chrome not connected in this environment, same caveat as every
prior phase). See `docs/PROJECT_OVERVIEW.md`'s "Known Limitations" and
`docs/TESTING.md`'s "Known Untested Areas" for the complete,
non-duplicated list.

## 2026-09-23 — Batch C1 Targeted Security Verification and Corrections

**What was implemented**: A focused re-inspection of the already-shipped
Batch C1 scanner/filesystem-safety code, not new functionality. Two real
defects were found and fixed:

1. **Root re-validation silently followed a symlink substitution.**
   `runScanForOwner` re-validated the configured directory at scan time
   by calling `resolveScanRoot` again — which calls `fs.realpath`, and
   `realpath` always resolves symlinks in the final path component too.
   If the configured directory were deleted and replaced with a symlink
   pointing elsewhere between configuration and a later scan, the
   re-validation would silently resolve through it and scan the wrong
   location, contradicting the scanner's own "never follow a symlink"
   policy (which was only ever enforced for entries discovered _during_
   traversal, not for the root's own re-check). Fixed with a new
   `revalidateScanRoot` (`lib/fsSafety.ts`) that `lstat`s the exact
   stored path — never re-resolving it — and rejects with a new
   `"root_changed"` error code if it's now a symlink. `scan.service.ts`
   now calls this instead of `resolveScanRoot` for its re-validation
   step.
2. **A directory could be recorded twice in one scan's inventory.** The
   scanner pushed a directory's item as `"scanned"` unconditionally,
   then — if `readdir` on it subsequently failed — pushed a _second_
   item for the same `relativePath` with `status: "error"`, violating
   the scanner's own "no duplicate records" guarantee. Restructured so
   `readdir` and `sortEntries` (both of which can throw — see below) are
   computed before the directory's single item is recorded, so exactly
   one of "scanned" or "error" is ever pushed for a given path.

A related robustness gap, found during the same review (not by a failing
test, by re-reading the traversal loop): `sortEntries` calls
`resolveSafeChild`, which can throw an `FsSafetyError` — practically
unreachable with real OS-supplied directory-entry names, but neither of
the two call sites (`scanDirectory`'s root-level call and the nested
per-directory call) were wrapped in a try/catch, so a hypothetical
anomalous entry name would have crashed the entire scan with an unhandled
exception (surfacing as a generic 500) instead of being handled per the
scanner's own stated policy ("continue and record a diagnostic where
safe"). Both call sites now catch it: the root-level occurrence folds
into the existing "failed scan" outcome (root unreadable); the
nested-directory occurrence folds into the existing per-directory
`"error"` item (fix #2 above), so the fix for one defect covers both.

**Why**: Explicitly requested targeted verification — inspect the actual
implementation and correct it, not re-implement or expand scope. No
Batch C2 functionality (import extraction, dependency resolution, graph
construction/visualization, AI integration) was touched.

**Verification performed, with no correction needed** (numbered to match
the request's own checklist; items 2, 4, and 5 are covered above since
they're where real corrections/additions were actually needed):

1. **Environment variables** — `SCAN_MAX_FILE_SIZE_BYTES`,
   `SCAN_MAX_FILES`, `SCAN_MAX_DEPTH`, `SCAN_MAX_DIRECTORIES`,
   `SCAN_MAX_DURATION_MS`: identical names across `env.ts` (with Zod
   `.int().positive()` validation and safe defaults), `.env.example`,
   `.env`, and `scan.service.ts`'s `limitsFromEnv()`. Every declared
   variable is read; every read variable is declared; no orphans in
   either direction. No mismatch found — no correction needed.
2. **Traversal boundary** — confirmed every constructed child path goes
   through `resolveSafeChild` (grepped for direct `path.join`/
   `path.resolve` bypasses in `scanner.service.ts`: none found), symlink
   detection is `lstat`-based (never `stat`), and the only `startsWith`
   usages in `lib/fsSafety.ts` are the UNC-prefix format check and the
   _correct_ use inside `isPathInsideRoot` (checking whether a computed
   _relative_ path climbs with `..` — not a raw absolute-path prefix
   compare). No naive boundary check found — no correction needed.
3. **Read-only guarantee** — grepped `fsSafety.ts`, `fileClassification.ts`,
   `scanner.service.ts`, `scan.service.ts`, `sourceConfig.service.ts`,
   and `scan.controller.ts` for any write/delete/rename/exec-shaped call
   (`writeFile`, `unlink`, `rmdir`, `rename`, `exec`, `spawn`, `chmod`,
   `copyFile`, etc.): zero matches. The byte-identical-fixture test from
   the original implementation is retained unmodified.
4. **Environment/secret review** — `.env` confirmed still gitignored and
   never staged; diffed this pass's changed files for password/secret/
   API-key/token patterns and hardcoded local paths: none found.

**Tests added** (all real, none faked to look like coverage):

- `lib/__tests__/fsSafety.test.ts`: 4 new tests for `revalidateScanRoot`
  (unchanged directory accepted; deleted path rejected `not_found`; a
  path now a file rejected `not_a_directory`; **a path replaced by a real
  junction on disk rejected `root_changed`, not silently followed** — the
  actual proof defect #1 is fixed). 21 passed total (was 17), 1
  conditionally skipped (unchanged).
- `services/__tests__/scanner.test.ts`: 2 new tests directly enforcing
  the two previously-untested limits — `maxDirectories` (root counts as
  the first visited directory, so `maxDirectories: 1` blocks every child
  directory) and `maxDurationMs` (using `-1` so the cooperative
  elapsed-time check trips deterministically on the very first loop
  iteration, regardless of actual fixture timing — not a "hope it's slow
  enough" test). 16 passed total (was 14).
- `services/__tests__/scanner.errorHandling.test.ts` (new file): 4 tests
  using deterministic `node:fs` mocking (`vi.mock("node:fs", ...)`
  wrapping the real implementation and injecting a rejection only for
  one specific target path) — a file's `lstat` failing mid-traversal,
  a nested directory's `readdir` failing mid-traversal, confirming
  siblings are still scanned in both cases, confirming the safe generic
  error message never contains the injected raw error text or the
  fixture's real path, and confirming a scan containing only such errors
  is never reported as a clean `"completed"` outcome. This test file is
  what caught defect #2 (the duplicate-record bug) — the first version
  of the "nested directory becoming inaccessible" test failed with the
  directory's item still showing `"scanned"`, which led directly to
  finding the unconditional-push bug in `scanner.service.ts`.
- `routes/__tests__/scan.integration.test.ts`: 1 new end-to-end test —
  configures a real directory via the actual API, then replaces it with
  a junction on disk (simulating what defect #1 allowed), then confirms
  starting a scan through the real HTTP endpoint returns `400` rather
  than silently scanning the substituted location. 17 passed total (was
  16).

**Consolidated verification** (run once at the end, per instructions):

- `npm run typecheck --workspace apps/api` — **pass**.
- `npm run lint` — **pass**, 0 errors (1 pre-existing unrelated warning).
- `npm run format:check` — **pass** after `prettier --write` on the one
  file whose formatting drifted (`lib/fsSafety.ts`).
- `npm run test` (one combined run) — **pass**: backend 201 passed, 8
  skipped (19 test files, up from 190 passed/8 skipped — exactly the 11
  new passed tests: 4 + 2 + 4 + 1, no regressions elsewhere, no new
  skips); frontend unchanged at 44 passed (no frontend files touched
  this pass).
- `npm run build --workspace apps/api` — **pass**. Frontend build not
  re-run — no frontend code was affected by this pass.
- Git diff reviewed for the 7 files this pass touched: grepped for
  password/secret/API-key/token patterns and the local username/absolute
  paths — none found. Confirmed `.env` still gitignored and never
  staged.

No blocking failures found; both real defects found during this pass
were fixed and covered by a new, real (not faked) test before this
report was written.

**Remaining limitations/concerns** (unchanged from Batch C1's original
entry except where noted): filesystem boundary enforcement is
application-level, not OS sandboxing; classification is extension/path-
based only; scanning is synchronous with no background job system;
reparse-point coverage is Windows-junction-specific; no real UNC/network
share was tested end-to-end; file-symlink-escape testing remains
environment-conditional (this machine can't create file symlinks without
elevated privileges, only junctions). **No longer a limitation**: per-item
mid-traversal read/permission errors are now genuinely tested (via
deterministic `node:fs` mocking), and all five configured resource limits
are now individually tested, not just three of five. See
`docs/TESTING.md`'s "Known Untested Areas" for the complete,
non-duplicated list.

## 2026-09-24 — Batch C2: Deterministic Import Extraction + Evidence-Based Module Resolution

**What was implemented**: Extraction and resolution of real import/
require statements from JS/JSX/TS/TSX source files, evaluated against a
specific scan's own recorded inventory — the next layer on top of Batch
C1's read-only scanner, still not a dependency graph. Two new pure
modules with zero filesystem access: `lib/importExtraction.ts` parses
source text with TypeScript's own parser (`ts.createSourceFile`) — never
regex, never `eval`/`Function`/code execution — and walks the resulting
AST for `ImportDeclaration`, `ExportDeclaration` (with a module
specifier), and `CallExpression` nodes whose callee is `require` or the
`import` keyword. A literal string argument becomes a resolvable
`rawImport`; a non-literal argument (`import(someVar)`,
`require(getName())`) is recorded as a safe, truncated snippet of its
actual source text (`node.getText()` — printed, never evaluated) and
flagged `isLiteral: false`, so it's preserved as evidence without ever
being guessed at. Whole-file syntax errors are detected via
`SourceFile.parseDiagnostics` (verified empirically to work on this
project's pinned TypeScript version, accessed defensively since it isn't
part of the published public API) and reported as `parse_error` with
nothing extracted, rather than returning a partially-trustworthy list.
`lib/importResolution.ts` resolves relative (`./`, `../`) specifiers
against a `Set` of the scan's own recorded relative paths — no disk
access at all — through one fixed, deterministic priority order: exact
match, then `.ts`/`.tsx`/`.js`/`.jsx` extension-appending, then
`index.*` within a matching directory in that same order. Bare
specifiers (`react`, `@scope/pkg`) are always `external`; `@/`/`~/`/
absolute imports are always `unsupported` (no alias config is read);
an explicit non-JS/TS extension (`.css`, `.json`, `.svg`, ...) is always
`unsupported` even when a file by that exact name exists in the
inventory; anything that would normalize outside the scan root is
rejected outright. A new `Analysis` model (own collection, tied to a
`scan` id, same "keep the snapshot, serve the latest" pattern as `Plan`/
`Scan`) and `services/analysis.service.ts` tie it together: load the
scan (ownership-checked), refuse to analyze a scan that itself failed,
re-validate the source root exactly like scanning does
(`revalidateScanRoot`), then for every scanned file in a supported
language, read its current content through the same `resolveSafeChild`
boundary scanning uses, extract, resolve against the scan's inventory,
and persist one relationship record per call site (or one `parse_error`
record per unreadable/unparseable file). New API:
`GET /api/scans/:id` (a real, previously-missing gap-fill needed as the
mounting point, following `plan.routes.ts`'s exact dual-router
convention), `POST`/`GET /api/scans/:id/analysis` — all requiring auth
and ownership-checked via `Scan`'s own denormalized `owner` field, no
client-supplied path accepted anywhere. `typescript` moved from
`devDependencies` to `dependencies` in `apps/api/package.json` since it's
now used at runtime, not just by `tsc` — no new dependency was added.

**Why**: The stated next step toward a real dependency graph — you can't
build a trustworthy graph on relationships nobody can prove, so this
batch's entire job was building the evidence layer first and refusing to
mark anything "confirmed" without an explicit, tested rule behind it.
Explicitly scoped to extraction + resolution only; graph construction,
visualization, and AI integration were out of scope and are not
implemented.

**Files changed**: New — `apps/api/src/lib/importExtraction.ts`,
`apps/api/src/lib/importResolution.ts`, `apps/api/src/models/Analysis.ts`,
`apps/api/src/services/analysis.service.ts`,
`apps/api/src/controllers/analysis.controller.ts`, plus test files (see
below). Updated — `apps/api/src/services/scan.service.ts` (added
`getScanForOwner`), `apps/api/src/controllers/scan.controller.ts` (added
`getOne`), `apps/api/src/routes/scan.routes.ts` (added `scanByIdRouter`
with the new `/analysis` routes), `apps/api/src/routes/index.ts` (mounted
`scanByIdRouter` at `/api/scans`), `apps/api/src/services/project.service.ts`
(`Analysis` added to the cascade-delete, from the start), `apps/api/package.json`
(`typescript` moved to `dependencies`). Docs: `docs/DECISIONS.md`
(ADR-015), `docs/API_DOCUMENTATION.md`, `docs/DATABASE_DESIGN.md`,
`docs/SECURITY.md`, `docs/TESTING.md`, `docs/PROJECT_OVERVIEW.md`,
`PROJECT_DECISIONS.md`.

**Tests added, all passing on the first run** (a genuinely clean
implementation this time — no bug found by a failing test, unlike the
last two batches): `lib/__tests__/importExtraction.test.ts` (18 tests,
pure, no DB/filesystem) covering every syntax category the batch's spec
required — default/named/namespace imports, export-from, `require`,
static and non-literal dynamic imports, multiple/duplicate imports,
JS/JSX/TS/TSX parsing, a genuine parse error, and line/column accuracy.
`lib/__tests__/importResolution.test.ts` (18 tests, pure) covering every
resolution scenario the spec required — extensionless/explicit-extension/
parent-directory/index-file resolution, missing targets, directories
without an index, a determinism proof (the exact same "ambiguous-looking"
inventory resolves identically across repeated calls, always via the
documented priority), bare and scoped external packages never becoming
local edges, alias/absolute rejection, path-traversal rejection, and
unsupported-extension rejection even against an existing file.
`routes/__tests__/analysis.integration.test.ts` (11 tests, real database

- real fixture files) covering auth/ownership on every route, the new
  `GET /api/scans/:id`, refusing to analyze a failed scan, and one
  end-to-end run against real fixture files that hits **every** relationship
  status (`confirmed`/`external`/`unsupported`/`unresolved`/`parse_error`)
  in a single request, with the response body asserted to never contain the
  fixture's raw absolute path.

**Consolidated verification** (run once at the end, per instructions):

- `npm run typecheck --workspace apps/api` — **pass** (two
  `exactOptionalPropertyTypes` issues surfaced during implementation —
  `isSupportedExtractionLanguage`'s parameter type and
  `RelationshipInput`'s optional fields both needed an explicit
  `| undefined`/widened type, the same recurring class of issue as every
  prior phase — fixed immediately, then clean).
- `npm run lint` — **pass**, 0 errors (1 pre-existing unrelated warning).
- `npm run format:check` — **pass** after `prettier --write` on the 6
  newly-added files.
- `npm run test --workspace apps/api` (one combined run) — **pass**: 248
  passed, 8 skipped (22 test files, up from 201 passed/8 skipped — exactly
  the 47 new tests: 18 + 18 + 11, no regressions elsewhere, no new skips).
  Frontend not re-run — no frontend code was touched (this batch's spec
  had no frontend-integration section, unlike Batch C1's).
- `npm run build --workspace apps/api` — **pass**.
- Git diff/secret review: grepped the 14 changed files for password/
  secret/API-key/token patterns and the local username — none found;
  confirmed `.env` still gitignored and never staged; grepped every new
  file for any write/delete/rename/exec-shaped call — zero matches.
- No new environment variable was needed — `SCAN_MAX_FILE_SIZE_BYTES`
  (already declared in Batch C1) is reused for the per-file read-size
  guard in `analysis.service.ts`.

No blocking failures found; the two typecheck issues were fixed within
the same implementation pass, before any test ran against broken code.

**Remaining limitations/concerns**: only JS/JSX/TS/TSX are supported —
Python and every other language are explicitly out of scope, not
silently mishandled; only relative-import resolution is implemented — no
alias/tsconfig-`paths` support, no `node_modules` inspection (every bare
package is `external` regardless of whether it's actually installed);
classification is still extension-based (inherited from Batch C1), so a
misclassified file's language is simply skipped rather than analyzed
incorrectly; analysis is synchronous with no background job system, same
as scanning; no canonical dependency graph, cycle detection, or
visualization exists yet — this batch produces a flat list of evidence,
not a graph. See `docs/PROJECT_OVERVIEW.md`'s "Known Limitations" and
`docs/TESTING.md`'s "Known Untested Areas" for the complete,
non-duplicated list.

## 2026-09-24 — Batch C3: Canonical Dependency Graph Engine

**What was implemented**: A pure, deterministic graph engine
(`apps/api/src/lib/sourceDependencyGraph.ts`) that turns Batch C2's
evidence-backed relationships into an actual graph — nodes, confirmed
edges with evidence, cycle detection, topological order, and structural
analysis. Focused inspection before writing any code found that Batch
B's existing `lib/dependencyGraph.ts` (built for AI-plan task
dependencies) already operates on fully generic `{nodes: string[],
edges: {from,to}[]}` with no task-specific logic in its algorithms, and
uses the _exact same_ edge-direction convention this batch needed ("A
depends on B"). Rather than writing a second DFS cycle detector and a
second Kahn's-algorithm topological sort, `sourceDependencyGraph.ts`
imports and reuses `validateGraph` (for cycle detection — its `cycle`-type
errors), `topologicalSort`, `getDependencies`, `getDependents`,
`getReadyTasks`, and `getBlockedTasks` directly, converting to/from the
shared `{nodes, edges}` shape only at the boundary. `buildDependencyGraph`
itself does the batch-specific work: a node's id is its scan-relative
path (never synthetic, never absolute, never array-index-derived, with
defensive backslash-to-forward-slash normalization); every confirmed
relationship's importer and resolved target are independently
re-validated against the _given_ inventory rather than trusted from the
relationship's own status — so a relationship accidentally sourced from
a different scan produces a structured `importer_not_in_inventory`/
`target_not_in_inventory` validation error instead of becoming a phantom
node; duplicate `(importer, target)` pairs merge into one edge with every
contributing relationship's evidence preserved in an array (never
dropped); `unresolved`/`external`/`unsupported`/`parse_error`
relationships are kept in full in their own arrays, never merged into
confirmed edges. `topologicalOrder` returns a dependency-first order
(leaves before importers) or `null` for a cyclic graph. `getRootNodes`/
`getLeafNodes` identify entry points / base dependencies.
`getStructurallyReadyNodes`/`getStructurallyBlockedNodes` take an
arbitrary caller-supplied "completed" set and are explicitly documented
as purely structural — no task-execution state is invented. New API:
`GET /api/scans/:id/graph` (`services/graph.service.ts`,
`controllers/graph.controller.ts`), computed on demand from the scan's
own inventory and its latest analysis — **no new persistence model**,
since the graph is a pure function of data already stored and a
persisted copy would only risk staleness relative to a re-run analysis.

**Why**: The explicit next step toward evidence-backed AI planning — a
graph that can't be trusted (missed cycles, phantom nodes, lost evidence,
order that changes with input order) is worse than no graph at all, so
this batch's entire job was correctness and determinism, not features.
Explicitly scoped to the graph engine and its read-only query endpoint
only; visualization and AI integration were out of scope and are not
implemented.

**Files changed**: New — `apps/api/src/lib/sourceDependencyGraph.ts`,
`apps/api/src/services/graph.service.ts`,
`apps/api/src/controllers/graph.controller.ts`, plus test files (see
below). Updated — `apps/api/src/routes/scan.routes.ts` (mounted
`GET /:id/graph` on `scanByIdRouter`). No other existing file needed to
change — `Scan`/`Analysis` already exposed everything the graph engine
needed.

**A real TypeScript issue found and fixed during implementation, not a
logic bug**: `graph.service.ts` initially passed `analysis.relationships`
(a Mongoose `DocumentArray` of subdocuments) directly to
`buildDependencyGraph`, which expects a plain `readonly
GraphRelationshipInput[]`. TypeScript rejected this — Mongoose's richer
subdocument array type doesn't structurally satisfy a plain array
parameter type under `exactOptionalPropertyTypes`, the same recurring
class of friction every phase has hit with Mongoose/Zod optional-field
typing. Fixed by mapping to plain objects at the service boundary before
calling the pure engine — arguably better practice anyway, since it
decouples the pure module's input type from Mongoose specifics entirely.

**Tests added, all 52 passing on the first run** (a second consecutive
clean batch — no bug found by a failing test this time, unlike Batch C1
and its corrective pass): `lib/__tests__/sourceDependencyGraph.test.ts`
(46 tests, pure, no DB/filesystem) covering every category the batch's
own spec required with exact-value assertions, not just "an array
exists" — basic shapes (empty/isolated/multi-component/multi-edge/
multi-importer), node validation (missing importer/target, cross-scan
contamination, an absolute-Windows-path-looking id handled as an inert
opaque string, backslash normalization, duplicate inventory dedup,
non-supported-language exclusion), edge construction (each non-confirmed
status verified to never produce an edge, duplicate-relationship evidence
merging, distinct-target-same-raw-text staying distinct, stable edge ids,
correct direction), cycle detection (self/2-node/3-node/5-node/multiple-
independent cycles, no false positive alongside an acyclic component,
identical output under shuffled input), topological order (empty/single/
linear/branching/merging/disconnected graphs, documented tie-breaking,
`null` for a cyclic graph), structural analysis (roots, leaves, direct
deps/dependents, an unknown id in a supplied "completed" set ignored
without mutating it, a cyclic pair never falsely marked ready), one
dedicated full-graph determinism test shuffling both inventory and
relationship order, and a purity test mocking `node:fs` to throw on any
call. `routes/__tests__/graph.integration.test.ts` (6 tests, real
database + real fixture files) covering auth/ownership, a 404 for a
valid owned scan with no analysis yet, and one end-to-end run against a
real `a→b→c` chain plus a real `x↔y` cycle plus a `react` external import,
verifying the exact response shape including `topologicalOrder: null` for
the cyclic result and the raw absolute fixture path absent from the
response.

**Consolidated verification** (run once at the end, per instructions):

- `npm run typecheck --workspace apps/api` — **pass** (one Mongoose-
  subdocument-vs-plain-array typing issue found and fixed during
  implementation, described above).
- `npm run lint` — **pass**, 0 errors (1 pre-existing unrelated warning).
- `npm run format:check` — **pass** after `prettier --write` on the 3
  newly-added files that drifted.
- `npm run test --workspace apps/api` (one combined run) — **pass**: 300
  passed, 8 skipped (24 test files, up from 248 passed/8 skipped —
  exactly the 52 new tests: 46 + 6, no regressions elsewhere, no new
  skips). Frontend not re-run — no frontend code was touched (this
  batch's spec explicitly deferred frontend integration).
- `npm run build --workspace apps/api` — **pass**.
- Git diff/secret review: grepped the 6 changed/new files for password/
  secret/API-key/token patterns and the local username — none found;
  confirmed `.env` still gitignored and never staged; grepped every new
  file for any filesystem/exec-shaped call — zero matches.
- No new environment variable was needed or added.

No blocking failures found; the one typecheck issue was fixed within the
same implementation pass, before any test ran.

**Remaining limitations/concerns**: the graph inherits every Batch C2
limitation (JS/JSX/TS/TSX only, no aliases, no `node_modules` inspection,
no Python) rather than working around any of them; no graph
visualization exists — the graph is JSON-only; no persistence, so there's
no history of how a project's graph changed across scans/analyses over
time (a deliberate trade-off, not an oversight — see ADR-016); structural
readiness/blockedness functions exist and are tested at the library level
but aren't exposed through the API yet, since there's no task-execution
state for a client to meaningfully supply. See `docs/PROJECT_OVERVIEW.md`'s
"Known Limitations" and `docs/TESTING.md`'s "Known Untested Areas" for
the complete, non-duplicated list.

## 2026-09-24 — Batch C4: Dependency Graph Visualization

**What was implemented**: A frontend "Graph" tab (fifth project tab)
that renders Batch C3's `GET /api/scans/:id/graph` response — the first
frontend work to consume the graph, extraction, or analysis layers at
all. `ProjectGraphTab.tsx` fetches the latest scan (`useLatestScan`,
already existing), then the graph for that scan (`useDependencyGraph`,
new), and renders every field the backend returns: stat cards (files,
confirmed dependencies, cycle count, diagnostics count), a validation-
errors warning banner when `validationErrors.length > 0`, a Files table
and a Confirmed Dependencies table (both click-to-select), a Cycles list
showing each cycle's exact ordered path, a four-section collapsible
Diagnostics panel (Unresolved/External/Unsupported/Parse Errors, each
with its own `RELATIONSHIP_STATUS_META` badge — new statusMeta entry),
and a Details panel that shows a selected node's direct dependencies/
dependents or a selected edge's **every** evidence record (never
collapsed to a count). A "Run Analysis" button appears only in the
missing-analysis (404) state and is the only thing that ever calls
`POST /api/scans/:id/analysis` — never fired automatically on load.
Alongside this, `DependencyGraphCanvas.tsx` renders the same graph as an
SVG: nodes positioned in a grid whose column/row comes directly from the
backend's own `topologicalOrder` (or a stable id sort when cyclic), edges
as arrowed lines, cycle-participant edges highlighted (color **and**
a dashed stroke **and** an `aria-label` stating "part of a cycle" — never
color alone), all sharing one selection state with the accessible view.
New types (`types/graph.ts`, `types/analysis.ts`) mirror the backend's
`DependencyGraphResult`/`Analysis` shapes exactly — no reinvented fields.

**Why**: The graph engine (Batch C3) was correct but invisible; this
batch's entire job was making it inspectable without adding a second,
possibly-diverging notion of what the graph contains. Explicitly scoped
to visualization and inspection only — no new backend contract, no AI
integration, no source-code navigation/editing.

**Files changed**: New — `apps/web/src/types/graph.ts`,
`apps/web/src/types/analysis.ts`, `apps/web/src/services/graphService.ts`,
`apps/web/src/queries/graphQueries.ts`,
`apps/web/src/components/graph/DependencyGraphCanvas.tsx`,
`apps/web/src/pages/project/ProjectGraphTab.tsx`, plus its test file (see
below). Updated — `apps/web/src/lib/statusMeta.ts`
(`RELATIONSHIP_STATUS_META`), `apps/web/src/pages/project/ProjectDetailLayout.tsx`
(fifth tab), `apps/web/src/App.tsx` (route). No backend file was touched —
the existing `GET /api/scans/:id/graph` contract already had every field
this batch needed.

**A real architectural decision, not a shortcut**: no graph-visualization
library was added. `@xyflow/react`/Cytoscape/vis-network were all
considered and rejected — each either needs a companion layout library
(the backend's `topologicalOrder` already IS the layout input a library
like dagre would need to compute) or ships a full interaction framework
heavier than warranted, and canvas/graph libraries are notoriously hard
to exercise meaningfully in `jsdom`. The chosen approach — plain SVG,
positions computed by simple arithmetic from data the backend already
computed — kept `apps/web/package.json` unchanged and kept every
interaction fully testable with real DOM assertions. See
`docs/DECISIONS.md` ADR-017.

**Two real ambiguities found and fixed while writing tests, not
component logic bugs**: (1) `screen.getByText("src/a.ts")` matched two
elements — a per-SVG-node `<title>` (added for a native hover tooltip)
and the Files table's own row, since both rendered the exact full path.
The `<title>` was redundant with that same node's own `aria-label`
(already stating the full path for accessibility), so it was removed
rather than working around the ambiguity in the test. (2) A test's
`/depends on/i` regex matched both the intended "Depends on (1)" details
heading and an unrelated, correctly-worded caption sentence ("files
nothing depends on are placed first") — fixed by tightening the test's
regex to `/depends on \(1\)/i`, not by changing the caption.

**Tests added, 15 passed after the two fixes above**:
`pages/project/__tests__/ProjectGraphTab.test.tsx` covering every case
the batch's spec required: loading, no-scan, missing-analysis (with an
explicit assertion that analysis is never called automatically), a
button click that does call it, a safe non-404 error message, empty-
graph, correct importer→imported direction via the SVG's own accessible
label with a full-response-body check for the absence of any absolute
path, node selection showing exact dependency/dependent counts, edge
selection showing all merged evidence, cycle summary/detail, a
validation-error warning, all four diagnostic categories, external
relationships never appearing as a confirmed edge, stable rendering
under reversed backend array order, and the SVG's own accessible
`role="img"` summary.

**Consolidated verification** (run once at the end, per instructions):

- `npm run typecheck --workspace apps/web` — **pass** (one
  `exactOptionalPropertyTypes` issue in a local `StatCard` prop type,
  same recurring class of issue as every prior phase — fixed
  immediately).
- `npm run lint` — **pass**, 0 errors (1 pre-existing unrelated warning).
- `npm run format:check` — **pass** after `prettier --write` on the 3
  files that drifted.
- `npm run test --workspace apps/web` (one combined run) — **pass**: 59
  passed (10 test files, up from 44 passed/9 files — exactly the 15 new
  tests, no regressions elsewhere).
- `npm run build --workspace apps/web` — **pass**, no bundle-size
  anomaly (no new runtime dependency was added).
- Backend was not touched this batch, so its suite was not re-run — a
  `git status` check confirmed zero files under `apps/api` changed
  before skipping that step, per the instruction to only re-verify what
  actually changed.
- Git diff/secret review: grepped every new frontend file for
  `process.env`/secret/token/password references — none found; confirmed
  `.env` still gitignored and never staged; confirmed the frontend never
  requests or renders a raw absolute filesystem path anywhere (verified
  both by code inspection and by a test asserting the full rendered
  response body).
- No new environment variable was needed or added.

No blocking failures found; both real ambiguities were fixed within the
same implementation pass, before this report was written.

**Remaining limitations/concerns**: layout is a simple topological-order
grid, not an aesthetically optimized diagram, so edges can visually cross
on larger graphs; zoom is button-driven and pan is native container
scrolling rather than drag/wheel gestures; the graph tab requires an
explicit "Run Analysis" click when a scan exists but hasn't been
analyzed yet (intentional — never automatic); everything the graph
visualization shows inherits every limitation already documented for
Batch C2/C3 (JS/TS/JSX/TSX only, no aliases, no `node_modules`, no
Python). See `docs/PROJECT_OVERVIEW.md`'s "Known Limitations" and
`docs/TESTING.md`'s "Known Untested Areas" for the complete,
non-duplicated list.

## 2026-09-24 — Batch C4 Real-Browser Verification (Playwright)

**What was done**: The Batch C4 visualization was, for the first time in
this project's history, actually exercised in a real browser via
Playwright rather than only through jsdom-based RTL tests — registering
a real account, creating a real project, and scanning/analyzing two real
directories from this very repository (`apps/api/src`, 115 files, and
`apps/web/src`, 85 files/272 confirmed edges) rather than fabricated
fixture data.

**A real defect found and fixed**: clicking an edge's rendered SVG line
frequently failed — Playwright's real hit-testing showed the click
landing on an unrelated node's `<rect>` instead, because in a dense grid
layout an edge's line routinely passes underneath a node box it isn't
connected to, and SVG gives later-painted (topmost) elements pointer-event
priority regardless of what's visually "underneath." This was invisible
to the jsdom test suite, which doesn't perform real layout/hit-testing.
Fixed by splitting each edge into two elements: a visual-only line
(`pointer-events: none`, unchanged appearance) painted before the nodes,
and an invisible, wider (`stroke-width: 12`) hit-line carrying all the
interactive/accessible attributes, painted _after_ the nodes so it's
reliably reachable. Re-verified in the browser: a representative
diagonal edge (previously guaranteed to fail) now selects correctly and
shows its evidence. **Residual, honestly-reported limitation**: in a very
dense graph (85+ nodes, 272 edges, many crossing lines), the single most
central, longest-spanning edges can still land on a contested pixel where
multiple edges' hit-areas overlap — this is a real layout-density
limitation of the simple grid approach (see ADR-017's "no visualization
library" decision), not something fixable without a proper edge-routing
layout algorithm, which is out of this batch's scope. The always-reliable
alternative is unaffected: every edge remains selectable via the
Confirmed Dependencies table regardless of graph density, confirmed by
clicking a real table row and seeing the same accurate evidence render.

**Everything else verified working, for real, in Chromium**: the
missing-analysis state (before running analysis) and its "Run Analysis"
button; the full graph render with real stat counts; SVG node selection
by mouse click and by keyboard (`Tab`-focus + `Enter`), each producing
accurate "Depends on"/"Imported by" lists in the Details panel; "Clear
Selection"; all three zoom controls (in/out/reset), confirmed via the
SVG's actual `width`/`height` attributes scaling by the exact 1.15×
step and resetting to baseline; panning via container scroll; the
Diagnostics panel's four sections expanding to show real, accurate
relationship data (e.g. a genuine `react-router-dom` external import, a
genuine `./index.css` unsupported-extension import with its real line
number); a real 92-node/0-edge result for the `apps/api/src` scan
(discussed below) rendering the correct "no confirmed local dependencies"
empty state; a visible keyboard focus ring on SVG nodes (confirmed via
computed `outline` style, not assumed); and correct, responsive
stacking/scrolling of every card and table at a 375px viewport, with no
information conveyed by color alone anywhere in the diagnostics or graph.
**Not exercised**: a real cycle, since neither real directory scanned
happened to contain one — cycle rendering remains verified only via the
RTL suite's fixture data, not confirmed in a live browser.

**A significant, real, out-of-scope finding, not fixed here**: scanning
this project's own backend (`apps/api/src`, a TypeScript project using
`"moduleResolution": "NodeNext"`) produced **0 confirmed edges** across
92 analyzable files, with 239 relationships reported `unresolved`. Root
cause: NodeNext requires relative imports to end in an explicit `.js`
extension even though the actual source files are `.ts` (e.g.
`import { X } from "./foo.js"`, where `foo.ts` is the real file on disk).
Batch C2's resolver (`lib/importResolution.ts`) never accounted for this
convention — an import with an explicit extension is only exact-matched
against the inventory, never extension-remapped, so `./foo.js` never
finds `foo.ts`. This is a real, significant accuracy gap for any NodeNext-
style TypeScript project (a very common backend convention — this very
project uses it), discovered only because this verification pass tested
against real, not fabricated, project data. **Not fixed in this pass**,
per its explicit scope (backend graph/resolution semantics were off
limits for this browser-verification task) — flagged here as a priority
candidate for a future Batch C2 corrective pass. The frontend correctly
and honestly displayed this real result (0 edges, 239 unresolved) rather
than hiding or misrepresenting it, which is itself a confirmation that
the visualization layer is accurate to whatever the backend actually
computes, bugs and all.

**Consolidated verification after the fix**: `npm run typecheck --workspace apps/web`
— pass. `npm run test --workspace apps/web` — pass, 59 passed (no
regressions from the fix). `npm run build --workspace apps/web` — pass.
`npm run lint` / `npm run format:check` — pass (0 errors; 1 pre-existing
unrelated warning). `npm run test --workspace apps/api` (regression
check, no backend files were touched) — pass, 300 passed/8 skipped,
identical to before. All verification browser artifacts (screenshots,
Playwright debug snapshots) and the test account/project/scan/analysis
data created for this pass were deleted afterward — nothing from this
verification was left in the repository or the database.

## 2026-09-24 — Batch C2.1: NodeNext-Compatible Relative Import Resolution

Fixes the resolution gap found during Batch C4's real-browser verification
(backend scan: 0 confirmed edges, 239 unresolved). Rules and rationale are
in `docs/DECISIONS.md` ADR-018.

### What changed

- `apps/api/src/lib/importResolution.ts`: a new first resolution step for
  explicit `.js`/`.jsx` specifiers from TypeScript importers. `.js` checks
  the literal file plus `.ts` and `.tsx`, and `.jsx` checks the literal
  file plus `.tsx`. A single match is confirmed (`exact` or
  `nodenext:<from>-><to>`). Two or more matches are `unresolved` as
  ambiguous. No matches falls through to the existing rules, with a reason
  listing the candidates checked. JavaScript importers are unaffected.
- No change to the `Analysis` schema, graph API, frontend, env, or
  dependencies.

### Verification

- Real-repo before/after (actual scanner + extractor + resolver, run
  against `apps/api/src` and `apps/web/src`; no DB writes):
  - `apps/api/src`: before, 0 confirmed / 246 unresolved / 137 external.
    After, 246 confirmed (all `nodenext:.js->.ts`) / 0 unresolved / 137
    external. Every confirmed target is in the scan inventory. (246 rather
    than C4's 239 because the new C2.1 test files add `.js` imports of
    their own.)
  - `apps/web/src`: identical before and after (273 confirmed, 112
    external, 1 unsupported). No previously confirmed relationship
    changed in either tree.
- Focused tests: 109 passed (resolver, source graph, analysis, graph, and
  the new NodeNext integration test) with MongoDB running.
- `npm run test --workspace apps/api`: 328 passed, 8 skipped (was 300/8;
  +25 unit, +3 integration).
- API typecheck and build pass. `eslint .` gives 0 errors (1 pre-existing,
  unrelated warning in `apps/web`), and `prettier --check .` passes.
- Frontend not re-verified: no frontend files changed.

### Known limitations

- Not mapped: `.mjs`/`.cjs`→`.mts`/`.cts`, `.js`→`.jsx`, `.d.ts`
  declaration targets, tsconfig `paths` aliases, `package.json`
  `imports`/`exports`.
- The mapping is keyed to the importer's file extension, not to any
  tsconfig's `moduleResolution`. A Bundler-mode TypeScript project that
  writes `./foo.js` also gets it, which is also how TypeScript resolves
  that specifier in Bundler mode.
- A literal `foo.js` beside `foo.ts` (for example, compiled output checked
  in next to its source) is always reported as ambiguous rather than
  guessed.
