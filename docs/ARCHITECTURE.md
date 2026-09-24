# Architecture

Reflects what's actually implemented as of Batch B (AI planning +
dependency graph foundation) plus the local-first product-alignment pass
that followed it (no architecture changed in that pass — see ADR-013 in
`docs/DECISIONS.md` and `docs/PRODUCT_SCOPE_LOCAL.md` for the revised
product direction this architecture is now scoped against). Real-time
updates remain not-yet-built — see `docs/PROJECT_OVERVIEW.md` for the
roadmap.

## High-Level Architecture

```
┌─────────────────┐        HTTP/JSON         ┌──────────────────┐        Mongoose        ┌───────────┐
│   apps/web       │  ───────────────────▶   │   apps/api        │  ──────────────────▶  │  MongoDB   │
│ React + Vite     │  ◀───────────────────   │ Express + TS      │  ◀──────────────────  │ (Docker)   │
│ localhost:5173   │      CORS-restricted     │ localhost:4000    │                        │ :27017     │
└─────────────────┘                          └──────────────────┘                        └───────────┘
```

Two independent Node processes in dev (`npm run dev:web`, `npm run dev:api`),
a single npm-workspaces monorepo, one shared root `.env`. No reverse proxy,
no BFF layer — the frontend talks to the API directly over CORS-restricted
HTTP. Introduced only if a real need (e.g. a second consumer of the API)
justifies it.

## Backend Architecture

`apps/api/src/`:

- `server.ts` — process entry point. Starts the HTTP listener and the
  MongoDB connection independently (a DB outage doesn't block the process
  from starting), wires graceful shutdown (SIGTERM/SIGINT →
  `server.close()` → `disconnectDB()` → `process.exit()`, with a 10s
  force-exit fallback), and top-level `unhandledRejection`/
  `uncaughtException` handlers.
- `app.ts` — `createApp()` builds the Express app (Helmet, CORS, JSON body
  parsing, `pino-http` request logging, routes, 404 handler, centralized
  error handler) without binding a port, so it's testable via Supertest
  without a real network listener.
- `config/env.ts` — Zod schema over `process.env`, loaded explicitly from
  the monorepo-root `.env` (not the app's own cwd — see the comment in the
  file). Fails fast with a readable error if config is invalid.
- `config/database.ts` — Mongoose connection lifecycle (`connectDB`,
  `disconnectDB`, `getDbState`) and connection event logging. See
  `docs/DATABASE_DESIGN.md`.
- `models/` — Mongoose schemas (`User`, `Project`, `Requirement`, `Task`,
  `Plan`, `Scan`). Each exports its schema type, hydrated-document type,
  and the model — no separate repository abstraction layer; a handful of
  models with straightforward queries still don't justify one (see ADR
  discussion criteria in `docs/DECISIONS.md`).
- `lib/dependencyGraph.ts` — the deterministic graph engine (validate,
  topological sort, ready/blocked lookups). Framework- and DB-agnostic on
  purpose — see `docs/DEPENDENCY_ENGINE.md` for the full API and why it
  lives here rather than `packages/shared` (ADR-010).
- `lib/fsSafety.ts` — path-boundary primitives for local project import
  (Batch C1): canonicalizes a configured root, and a `path.relative`-based
  (not `startsWith`) check for whether a path is inside it. Framework- and
  DB-agnostic, same style as `dependencyGraph.ts`. See `docs/DECISIONS.md`
  ADR-014 and `docs/SECURITY.md`.
- `lib/fileClassification.ts` — pure, extension/path-based file
  classification and the directory ignore policy used by the scanner —
  no filesystem calls, no content inspection.
- `services/scanner.service.ts` — the deterministic, read-only directory
  traversal engine built on `fsSafety`/`fileClassification`. Synchronous
  per call, bounded by configurable limits (`SCAN_MAX_FILES` etc.). See
  `docs/DECISIONS.md` ADR-014.
- `services/ai/` — the `AIProvider` abstraction (`aiProvider.ts`),
  its Ollama implementation (`ollamaProvider.ts`), the lazily-constructed
  singleton accessor (`index.ts#getAIProvider`), and the prompt template
  (`promptBuilder.ts`). See `docs/AI_SYSTEM.md`.
- `routes/` — one router file per resource, aggregated in `routes/index.ts`.
  **Each router is mounted at an explicit path prefix**
  (`apiRouter.use("/auth", authRouter)`, `apiRouter.use("/projects",
projectRouter)`) rather than at `/` — see the Phase 3 bug writeup below
  for why this specifically matters. `requirement.routes.ts` and
  `task.routes.ts` each export **two** routers: a `*CollectionRouter`
  (`Router({ mergeParams: true })`, mounted at
  `/api/projects/:projectId/requirements` or `.../tasks` — `:projectId`
  lives in the _mount path_, which Express supports) for list/create, and
  a `*ByIdRouter` (mounted at `/api/requirements` / `/api/tasks`) for
  get/update/delete-by-id, since those don't need `:projectId` in the URL
  at all — ownership is checked via the resource's own denormalized
  `owner` field (see `docs/DATABASE_DESIGN.md`).
- `controllers/` — thin: parse `req`, call a service, shape the response.
  No business logic here (`auth.controller.ts`, `project.controller.ts`,
  `requirement.controller.ts`, `task.controller.ts`, `plan.controller.ts`,
  `scan.controller.ts`).
- `services/` — the actual business logic (`auth.service.ts`:
  registration/login/session lookup; `project.service.ts`:
  ownership-aware CRUD queries, plus the cascade-delete of a project's
  requirements/tasks/plans/scans; `requirement.service.ts`: project-ownership-checked
  CRUD, clears `Task.requirement` on delete; `task.service.ts`:
  project-ownership-checked CRUD, cross-project reference validation for
  `requirementId`/`parentTaskId`, self-parent rejection, BFS subtree
  cascade delete — see `docs/DATABASE_DESIGN.md` and ADR-008;
  `plan.service.ts`: generate/list/get/update/approve/reject — see
  `docs/AI_SYSTEM.md`; `sourceConfig.service.ts`: validates and stores a
  project's local source directory; `scan.service.ts`: runs
  `scanner.service.ts` against the configured directory and persists the
  result — see `docs/DECISIONS.md` ADR-014). Introduced in Phase 3 — this
  is the point flagged in Phase 2's version of this doc as "once real
  domain logic exists."
- `validators/` — Zod request-body **and query-string** schemas
  (`auth.validators.ts`, `project.validators.ts`, `requirement.validators.ts`,
  `task.validators.ts`, `plan.validators.ts`, `aiPlan.validators.ts`,
  `scan.validators.ts`),
  applied via the `validateBody`/`validateQuery` middleware. Task list
  filters (`?status=`, `?priority=`, `?requirementId=`, `?parentTaskId=`,
  `?search=`) are validated the same way as request bodies — malformed
  query params get a clean `400` rather than silently being ignored or
  crashing a query. `aiPlan.validators.ts` additionally validates raw AI
  output (structural + graph checks) — see `docs/AI_SYSTEM.md`.
- `middleware/` — `notFound.ts` (404 handler), `errorHandler.ts`
  (centralized error handling — distinguishes Zod validation errors,
  Mongoose `CastError`/duplicate-key errors, `AppError` operational errors,
  and unexpected exceptions; never leaks stack traces in production),
  `auth.middleware.ts` (`requireAuth` — verifies the JWT cookie, attaches
  `req.user`), `rateLimit.middleware.ts` (`authLimiter`, scoped to
  `/auth/register` and `/auth/login`), `validate.ts` (generic Zod
  body-validation wrapper).
- `utils/` — `logger.ts` (`pino`, redacts cookie/authorization headers —
  see `docs/SECURITY.md`), `AppError.ts`, `password.ts` (bcrypt hashing,
  including the timing-safety dummy-hash helper), `jwt.ts` (sign/verify,
  normalizes every failure into one `InvalidTokenError`), `authCookie.ts`
  (single source of truth for the cookie name and attributes, shared
  between setting and clearing it), `asyncHandler.ts` (wraps async route
  handlers so a rejected promise reaches `errorHandler.ts` — Express 4
  does not do this automatically).
- `types/express.d.ts` — augments `Express.Request` with an optional
  `user: { id, role }`, set only by `requireAuth`.

### A real routing bug, found and fixed in Phase 3

`projectRouter.use(requireAuth)` was originally mounted with
`apiRouter.use(projectRouter)` — no path prefix. Express's `.use()`
middleware with no path filter runs for _every_ request that reaches that
router, not just ones matching a route defined in it. Since a router
mounted at `/` receives every request that falls through the routers
before it, `requireAuth` was intercepting requests to nonexistent routes
too — `GET /api/does-not-exist` returned `401` instead of falling through
to the `404` handler. Caught because the existing Phase 1 `health.test.ts`
404 test started failing the moment the project router was added. Fixed by
mounting both `authRouter` and `projectRouter` at explicit prefixes
(`/auth`, `/projects`) so unrelated requests never enter them at all. See
`docs/DECISIONS.md` context in the Phase 3 implementation log for the full
diagnosis.

## Database Architecture

See `docs/DATABASE_DESIGN.md` for the full schema/index/lifecycle writeup.
In short: MongoDB via Mongoose, one collection per model, references (not
embedding) for the `Project.owner → User` relationship, a bounded
connection timeout so an unreachable database fails fast, and a
liveness/readiness split (`GET /api/health` vs `GET /api/health/db`) so a
database outage is diagnosable without the whole API appearing down.

## Authentication & Authorization Architecture

- **Token strategy**: httpOnly JWT cookie, no refresh token in this phase.
  Full reasoning and trade-offs in `docs/DECISIONS.md` ADR-007.
- **Middleware chain for a protected route**: `requireAuth` reads
  `req.cookies.devflow_token`, verifies it (`utils/jwt.ts`), and attaches
  `req.user = { id, role }` — or rejects with a generic `401` on any
  failure (missing, malformed, wrong signature, expired). Route handlers
  read `req.user`, never a client-supplied id.
- **Authorization is per-operation, not a separate layer**:
  `project.service.ts`'s queries bake `owner: req.user.id` into the
  `find`/`findOneAndUpdate`/`deleteOne` filter itself, so a non-owner's
  request simply matches nothing — see `docs/SECURITY.md` for why this
  returns `404` rather than `403`.
- **Why authentication and authorization stay separate concerns**:
  `requireAuth` only answers "who is this request from, if anyone" and
  never looks at _what_ they're trying to access; ownership checks live
  entirely in the service layer next to the query they protect. This
  keeps `requireAuth` reusable for any future protected resource without
  it needing to know about projects, requirements, or tasks.

## Request Lifecycle (current)

```
Client
  │  GET /api/health/db
  ▼
Helmet (security headers)
  │
CORS check (env-configured origin)
  │
express.json() (body parsing, 100kb limit)
  │
pino-http (request/response logging)
  │
routes/index.ts → health.routes.ts
  │  reads Mongoose connection readyState (no DB round-trip)
  ▼
200 {status:"ok", db:"connected"}  |  503 {status:"error", db:"<state>", message}
```

Errors thrown anywhere in that chain (including Zod validation errors, once
request-body validation is added in Phase 3) fall through to
`errorHandler.ts`, which picks the right status code and never returns a
raw stack trace when `NODE_ENV=production`.

## Frontend Architecture

`apps/web/src/`:

### Data layer

- `services/apiClient.ts` — the only place `fetch` is called. Wraps
  base-URL resolution, JSON error parsing into a typed `ApiError`,
  `credentials: "include"` on every request (required for the httpOnly
  auth cookie — see ADR-007), and 204-No-Content handling (`DELETE`
  responses have no body). `get`/`post`/`put`/`patch`/`delete` methods
  (`put` added in Batch C1 for the source-config endpoint — the first
  consumer of it).
- `services/{health,auth,project,requirement,task,plan,scan}Service.ts` —
  one function per API operation, built on `apiClient`. Query-string
  filters (task list) are built with `URLSearchParams` in the service, not
  scattered across components.
- `queries/{project,requirement,task}Queries.ts` — TanStack Query hooks
  (`useProjects`, `useProject`, `useCreateProject`, ... one file per
  resource). Introduced in Batch A — this is the point flagged in Phase 1's
  ADR as "planned starting Phase 5 when real caching/mutation needs exist."
  Mutations invalidate the relevant query keys on success (e.g. deleting a
  requirement invalidates both `["requirements", projectId]` and
  `["tasks", projectId]`, since deleting a requirement changes tasks that
  referenced it). `hooks/useHealth.ts` is the one holdout still on plain
  `useEffect`/`useState` — a single endpoint with no mutations/caching
  needs doesn't justify converting it.
- `context/AuthContext.tsx` + `hooks/useAuth.ts` — global auth state
  (`loading | authenticated | unauthenticated`, current user, `register`/
  `login`/`logout`). React's built-in Context, not a state library — the
  phase instructions call for avoiding one unless justified, and a single
  piece of app-wide state (the current user) doesn't justify Redux/Zustand.

### Routing (`routes/`, `App.tsx`)

Introduced in Phase 4, replacing the Phase 3 conditional-render gate:

```
/                          → redirect to /app/dashboard or /login (via ProtectedRoute)
/login, /register          → PublicOnlyRoute (redirects an already-authenticated visitor to /app/dashboard)
/app                       → ProtectedRoute → AppLayout (sidebar + header)
  /app/dashboard
  /app/projects
  /app/projects/new
  /app/projects/:projectId → ProjectDetailLayout (fetches the project once, tabs share it via useOutletContext)
    /overview (index)
    /requirements
    /tasks
*                          → NotFoundPage
```

- `routes/ProtectedRoute.tsx` — never redirects while `status === "loading"`
  (the initial `GET /api/auth/me` check in flight); only redirects to
  `/login` once the check has actually resolved to "unauthenticated." This
  is what prevents an authentication loop / a false redirect flash for an
  already-logged-in user refreshing the page.
- `routes/PublicOnlyRoute.tsx` — the inverse guard for `/login`/`/register`.
- `pages/project/ProjectDetailLayout.tsx` fetches the project **once**
  (`useProject(projectId)`) and passes it to its three tab children via
  `<Outlet context={project} />` / `useProjectContext()` — the tabs don't
  each re-fetch the same project.

### UI primitives (`components/ui/`, `components/forms/`)

- `Button`, `Card`, `Badge` (with a `tone` prop mapped from
  `lib/statusMeta.ts` — one place that maps every status/priority enum
  value to a label + color, instead of scattering `switch` statements
  across components), `EmptyState`, `LoadingState`, `ErrorState`,
  `Dialog`/`ConfirmDialog` (the one Radix-based primitive — see ADR-009).
- `components/forms/{FormField,TextareaField,SelectField}.tsx` — all
  `forwardRef`, all following the pattern established in Phase 3
  (`react-hook-form`'s `register()` needs the ref to reach the real DOM
  element — see the Phase 3 bug writeup below).

### Feature components & pages

- `components/{projects,requirements,tasks}/*Form.tsx` — one form
  component per resource, reused for both create and edit (an optional
  `defaultValues` prop switches between the two). Acceptance criteria are
  entered as one item per line in a single textarea
  (`validators/*Schemas.ts`'s `criteriaTextToArray`/`criteriaArrayToText`)
  rather than a dynamic add/remove field list — same end result, far less
  code.
- `pages/project/ProjectTasksTab.tsx` — the most complex page. Fetches the
  project's full (already status/priority/requirement/search-filtered)
  task list in one query, then groups it into a top-level/subtask tree
  **client-side** rather than lazy-fetching each parent's children
  on-demand — see ADR-009/`task.service.ts` for why the API is shaped to
  return a flat, filtered list. A subtask whose parent didn't also match
  the current filter is still rendered (as its own root row) rather than
  silently dropped.
- `pages/project/ProjectOverviewTab.tsx` — inline edit (toggles the
  display view for the same `ProjectForm` used on creation) and the
  project delete confirmation flow.
- `pages/project/ProjectPlansTab.tsx` — the AI planning workflow (Batch B):
  a requirement picker + "Generate Plan" (disabled with an explanatory
  banner when `useAIStatus()` reports the provider unavailable — polled
  every 30s), a list of existing plans, and a review `Dialog` (summary,
  assumptions, risks, suggested tasks in the backend-computed topological
  order, each showing its resolved `dependsOn` task titles) with
  Approve/Reject actions shown only while a plan is `needs_review`. A
  list-based review, not a graph editor, per the batch's explicit scope
  limit. This tab is the fourth in `ProjectDetailLayout`'s tab bar,
  alongside Overview/Requirements/Tasks.
- `pages/project/ProjectScanTab.tsx` — the read-only project scanning
  workflow (Batch C1): a source-directory form (shows only the safe
  `label`, never a raw path), a "Run Scan" action (disabled until a
  source is configured), and the latest scan's outcome badge, summary
  counts, any limits reached, and a bounded inventory table. Fifth tab in
  `ProjectDetailLayout`'s tab bar. See `docs/DECISIONS.md` ADR-014.
- `components/layout/AppLayout.tsx` — sidebar nav (desktop) that collapses
  into a header-triggered dropdown (mobile, `<768px`), current user +
  logout in the header, active-route highlighting via `NavLink`.

## Environment & Configuration

A single root `.env` (git-ignored; `.env.example` is the checked-in
template) is read by both apps:

- `apps/api/src/config/env.ts` loads it explicitly via a path relative to
  `process.cwd()` (which `npm run dev --workspace apps/api` sets to
  `apps/api`).
- `apps/web/vite.config.ts` sets `envDir` to the repo root so Vite's
  `VITE_*` variable loading points at the same file.

**Known gotcha, fixed in Phase 2 (see ADR-006 in `docs/DECISIONS.md`)**:
`NODE_ENV` must never be set in this shared file — it leaks into Vite's
esbuild dependency pre-bundling and forces React into development mode in
the "production" build, doubling bundle size. `apps/api`'s Zod schema
already defaults `NODE_ENV` to `"development"` when unset, so omitting it
from `.env` doesn't affect local dev. A real deployment sets
`NODE_ENV=production` at the platform level.

**Phase 3 additions**: `JWT_ACCESS_SECRET` (required, ≥32 chars),
`JWT_ACCESS_TTL` (default `1h`), `AUTH_RATE_LIMIT_WINDOW_MS`/
`AUTH_RATE_LIMIT_MAX` (auth-endpoint brute-force protection, not a general
API rate limit). `JWT_REFRESH_SECRET`/`JWT_REFRESH_TTL`, scaffolded as
unused placeholders in Phase 1, were removed — dead config for a feature
that doesn't exist yet (see ADR-007).

## Trade-offs / Potential Bottlenecks (current)

- Two separate npm processes with no shared build cache beyond what
  Vite/tsc do individually — acceptable at this project's size; would
  reconsider (Turborepo/Nx) if the monorepo grows past a few packages.
- No API gateway/BFF — fine while there's exactly one frontend consumer.
- No connection pooling configuration beyond Mongoose's defaults — revisit
  if/when load testing (Phase 10) shows it matters.
- The dashboard's stats (total/active/completed project counts, recently
  updated) are all derived client-side from the single `GET /api/projects`
  response — no fabricated numbers, but also no task-level aggregation
  (e.g. "total open tasks across all projects") yet, since that would need
  either an N+1 fetch (one tasks query per project) or a dedicated
  aggregation endpoint that doesn't exist. Documented as an explicit gap
  rather than either faking the number or building the aggregation
  prematurely — see `docs/PROJECT_OVERVIEW.md` Known Limitations.
- `ProjectTasksTab` fetches a project's _entire_ filtered task list in one
  request and groups it into a tree client-side (see Frontend Architecture
  above) — fine at expected task volumes for a single project; would need
  revisiting (server-side pagination or a dedicated tree endpoint) if a
  project ever accumulates thousands of tasks. No pagination was built
  preemptively, per the explicit "don't build an elaborate pagination
  system without a need" instruction.
