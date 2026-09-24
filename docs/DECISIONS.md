# Architecture Decision Records

## ADR-001: Package manager — npm workspaces

**Context**: Need a monorepo tool for `apps/web`, `apps/api`, `packages/shared`.
**Options considered**: npm workspaces, pnpm workspaces, yarn workspaces, Turborepo/Nx.
**Selected**: npm workspaces.
**Reason**: npm 11 is already installed and supports workspaces natively.
pnpm/yarn aren't installed and add a setup step (corepack enable, lockfile
migration) with no meaningful benefit at this scale (2 apps + 1 shared
package). Turborepo/Nx would be premature complexity for a project this size.
**Trade-offs**: npm workspaces have weaker caching/task-graph features than
Turborepo, but the project is small enough that this doesn't matter.
**Consequences**: single root `package.json` with `workspaces`, single
`package-lock.json`, `npm run <script> --workspace <name>` for per-app commands.

## ADR-002: Database hosting — MongoDB via Docker Compose

**Context**: Need MongoDB for local development. No native `mongod`/`mongosh`
installed on this machine.
**Options considered**: native local install, Docker Compose, MongoDB Atlas free tier.
**Selected**: Docker Compose for local dev; `MONGODB_URI` stays env-driven so
Atlas can be swapped in without code changes.
**Reason**: Docker Desktop is already installed (daemon just needs to be
started), avoiding a native MongoDB install/uninstall on the host machine.
Keeping the URI in env vars means this decision doesn't lock in the
deployment target.
**Trade-offs**: Requires Docker Desktop running for local dev; documented in
`PROJECT_DECISIONS.md` and `README.md` as a setup prerequisite.
**Consequences**: `docker-compose.yml` will define a `mongo` service with a
named volume; `.env.example` documents `MONGODB_URI` for both Docker and Atlas.

## ADR-003: AI provider — Ollama (local), behind a provider interface

**Context**: The AI planning feature needs a real, working LLM backend. Must
not fake responses. Must support graceful failure (provider down, model
missing, timeout).
**Options considered**: Ollama (local), a hosted API (OpenAI/Anthropic), both.
**Selected**: Ollama with `qwen2.5:7b`, accessed through an `AIProvider`
TypeScript interface (`analyzeRequirement`, `generateTaskBreakdown`,
`identifyDependencies`, `identifyRisks`, `generateAcceptanceCriteria`).
**Reason**: Ollama is already installed and running locally with the model
pulled — genuinely functional today, zero API cost, no external data
exposure (relevant since requirements may contain project-sensitive text).
The interface abstraction means a hosted provider can be added later as a
second implementation without touching controllers/services.
**Trade-offs**: Local 7B model quality/latency is weaker than hosted
frontier models; must be transparent about this in `docs/AI_SYSTEM.md` and
never overstate AI capability in resume claims.
**Consequences**: `OLLAMA_BASE_URL` / `OLLAMA_MODEL` are env-configurable;
provider status must be checked and surfaced to the frontend (not silently
assumed available).

## ADR-004: Dependency graph engine built in-house (not a library)

**Context**: The product's core differentiator is dependency-aware planning:
cycle detection, topological ordering, blocked/ready task computation.
**Options considered**: use a graph library (e.g. `graphology`) for cycle
detection/topo-sort, or implement the algorithms directly.
**Selected**: Implement the core graph algorithms directly in
`packages/shared`, unit-tested against the edge cases listed in the master
spec (empty graph, linear/branching/merging deps, cycles, self-deps, missing
deps, duplicates).
**Reason**: This is the part of the project meant to demonstrate real
algorithmic engineering understanding for interviews — hiding it behind a
library defeats the purpose. The algorithms involved (DFS-based cycle
detection, Kahn's-algorithm topological sort) are well-understood and don't
risk correctness the way e.g. hand-rolled crypto would.
**Trade-offs**: More code to write and test ourselves vs. a battle-tested
library; mitigated by thorough unit tests per the spec's edge-case list.
**Consequences**: `docs/DEPENDENCY_ENGINE.md` documents the algorithm choice
and Big-O complexity once implemented.

## ADR-005: Testing — Vitest for both apps

**Context**: Need a test runner for the Express API and the React frontend.
**Options considered**: Jest for both, Vitest for both, Jest (API) + Vitest (web).
**Selected**: Vitest for both `apps/api` and `apps/web`.
**Reason**: One test runner/config style across the monorepo instead of two;
Vitest has first-class Vite integration for the frontend and works fine for
a Node/TS backend via `vitest` + `supertest`. Reduces config duplication.
**Consequences**: Playwright is added separately in Phase 10 for E2E only.

## ADR-006: `NODE_ENV` excluded from the shared root `.env`

**Context**: `apps/web/vite.config.ts` sets `envDir` to the monorepo root so
both apps read one `.env` file. During Phase 2 verification, `npm run build`
for `apps/web` unexpectedly produced a 334.87KB bundle (101.39KB gzip) —
roughly 2.3x the Phase 1 baseline of 146.99KB (47.43KB gzip) — with React
development-mode warning strings present in the output.
**Root cause (confirmed empirically, not assumed)**: the root `.env` had
`NODE_ENV=development`. Removing that single line and rebuilding restored
the 146.99KB output exactly. Vite's env loader reads `NODE_ENV` from any
loaded `.env` file and it leaks into esbuild's dependency pre-bundling step,
forcing React into its development code path even though `vite build`
itself correctly runs in production mode.
**Selected**: Do not define `NODE_ENV` in the shared `.env`/`.env.example`
at all. `apps/api/src/config/env.ts`'s Zod schema already defaults
`NODE_ENV` to `"development"` when unset, so local dev is unaffected. A real
deployment sets `NODE_ENV=production` at the platform/process level (Docker,
a PaaS, a process manager) — which is where it belongs regardless of this
bug, since env files checked into example configs shouldn't dictate a
runtime mode that varies per deployment.
**Trade-offs**: none identified — this is strictly safer than the previous
setup.
**Consequences**: `.env.example` documents this with the measured before/
after numbers so the mistake isn't silently reintroduced later. Verified via
`npm run build --workspace apps/web` before/after the fix.

## ADR-007: Auth token strategy — single JWT access token in an httpOnly cookie

**Context**: Phase 3 needs to pick how the access token is created, verified,
and transported between `apps/web` (`localhost:5173`) and `apps/api`
(`localhost:4000`) — two different origins, same "site" (both `localhost`).
This decision has to be made and documented _before_ writing auth code,
since it drives the shape of the middleware, the frontend `apiClient`, CORS
config, and the test suite.

**Options considered**:

1. JWT in `localStorage`/`sessionStorage`, sent via `Authorization: Bearer`.
2. JWT in an httpOnly, `SameSite` cookie, verified server-side per request.
3. Full session-store approach (server-side session ID in a cookie,
   session data in MongoDB/Redis).
4. Access + refresh token pair with rotation (either transport).

**Selected**: Option 2 — a single short-to-moderate-lived JWT access token,
signed with `jsonwebtoken` (HS256), stored **only** in an httpOnly,
`SameSite=Lax` cookie. No refresh token in this phase.

**Reason**:

- **httpOnly cookie over `localStorage`**: `localStorage` is readable by any
  script running on the page, so a single XSS vulnerability anywhere in the
  frontend (including a compromised third-party dependency) means full
  token theft. An httpOnly cookie is invisible to JavaScript entirely — the
  browser attaches it automatically, the frontend code never touches the
  raw token, and it never appears in `fetch`/`axios` code, browser devtools
  "Local Storage" tab, or accidentally-logged request bodies. Given this is
  explicitly a security-sensitive phase, this is the stronger default.
- **CSRF mitigation without a separate CSRF-token system**: `localhost:5173`
  and `localhost:4000` are different origins but the same registrable
  "site," so a `SameSite=Lax` cookie is sent on same-site `fetch`/XHR
  requests (with `credentials: "include"` + matching CORS
  `credentials: true` + an explicit, non-wildcard `CORS_ORIGIN` — all
  already in place since Phase 1) but is **not** sent on cross-site
  POST/fetch/XHR requests initiated by a third-party page — which is
  exactly the classic CSRF vector. Combined with the existing strict CORS
  allow-list (only `CORS_ORIGIN` is permitted, credentialed requests from
  any other origin are rejected by the browser before they'd even carry the
  cookie), this closes the primary CSRF risk for a JSON API without a
  separate CSRF-token mechanism. In production, a genuinely cross-site
  frontend/API deployment (different registrable domains) would need
  `SameSite=None; Secure` instead, which reopens CSRF risk and would need a
  real CSRF token at that point — documented as a limitation below.
- **No refresh token in this phase**: a refresh-token pair with rotation
  and revocation is a meaningfully larger feature (secure storage of
  refresh tokens or a revocation list, a rotation endpoint, replay
  detection). The phase instructions explicitly prioritize "correctness and
  testability over adding a large number of authentication features," so
  it's deferred. To keep sessions usable without it, the access token TTL
  is set longer than the security-optimal 15 minutes typically paired with
  refresh rotation — see the trade-off below.
- **Not a full session store**: would require a new piece of
  infrastructure (Redis, or a `sessions` Mongo collection) purely to hold
  what a signed, stateless JWT already encodes. Revisit if server-side
  session revocation becomes a real requirement (see Limitations).

**Token contents & config**:

- Payload: `{ sub: <user id>, role: <user role> }` — no email, no PII beyond
  what's needed to identify the user and check role.
- Secret: `JWT_ACCESS_SECRET`, now **required** (no default) and validated
  to be at least 32 characters via Zod — the app refuses to boot with a
  missing or weak secret, consistent with the existing fail-fast env
  validation pattern.
- Expiry: `JWT_ACCESS_TTL`, default **1 hour**. This is longer than the
  15-minute default typically paired with refresh rotation — a deliberate
  trade-off documented here, not an oversight: without a refresh flow, a
  15-minute token would force re-login mid-session/mid-demo. 1 hour bounds
  exposure to a single work session while staying usable. Shortening this
  to 15 minutes and adding refresh rotation is listed as a near-term
  security improvement in `docs/SECURITY.md`.
- Cookie attributes: `httpOnly: true`, `sameSite: "lax"`,
  `secure: NODE_ENV === "production"` (local dev is plain HTTP, so `secure`
  would silently prevent the cookie from ever being set), `maxAge` matching
  the JWT TTL, `path: "/"`.
- `JWT_REFRESH_SECRET`/`JWT_REFRESH_TTL` (scaffolded as optional/unused in
  Phase 1) are **removed** from `env.ts`/`.env.example` in this phase —
  dead config for a feature that doesn't exist yet. They'll return when
  refresh rotation is actually implemented.

**Logout behavior**: since the token is stateless (no server-side session
record), logout clears the cookie (`Set-Cookie` with `maxAge: 0`, matching
attributes) — there is no server-side revocation. A token captured before
logout (e.g., via a compromised machine with disk/memory access — NOT via
XSS, since httpOnly blocks that vector) would remain valid until its
natural 1-hour expiry even after logout. This is a standard, documented
limitation of stateless JWTs without a revocation store — see
`docs/SECURITY.md`.

**Trade-offs**:

- No server-side revocation (see Logout behavior above).
- 1-hour access-token TTL is a larger blast-radius window than the 15-minute
  standard, accepted specifically because there's no refresh flow yet.
- `SameSite=Lax` + strict CORS is sufficient for this app's current
  same-site local topology but would need revisiting (real CSRF tokens, or
  a same-registrable-domain deployment topology) if frontend and API are
  ever deployed to genuinely different domains.

**Consequences**: `apps/api` adds `cookie-parser` to read the cookie and
`jsonwebtoken`/`bcryptjs` for signing and password hashing.
`apps/web/src/services/apiClient.ts` must send `credentials: "include"` on
every request so the cookie is attached/received. Verified end-to-end in
Phase 3 (see `docs/IMPLEMENTATION_LOG.md`).

## ADR-008: Subtasks as separate Task documents with a `parentTask` reference (not embedded)

**Context**: Batch A (Phases 4–6) needs to model tasks and subtasks. This
has to be decided before writing the schema, since it affects querying,
authorization, and — critically — compatibility with the dependency-graph
engine planned for Batch B.

**Options considered**:

1. Embed subtasks as an array of subdocuments inside their parent `Task`.
2. Separate `Task` documents with a `parentTask: ObjectId` self-reference.

**Selected**: Option 2 — subtasks are ordinary `Task` documents that happen
to have `parentTask` set.

**Reason**:

- **Batch B's dependency graph needs every task (including subtasks) as a
  uniform graph node.** If subtasks were embedded subdocuments, the graph
  engine would need two different code paths to build nodes/edges — one
  for top-level tasks, one for reaching into each parent's embedded array
  — and a dependency edge between a subtask and a top-level task (or
  between two subtasks of different parents) would be awkward to express
  at all. A flat `Task` collection where every document, subtask or not,
  is addressable by its own `_id` is what a graph algorithm actually wants.
- **Independent querying/filtering.** The task list needs to filter by
  status/priority/requirement/search across _all_ tasks including
  subtasks (see `task.service.ts`'s `listTasksForProject` and its
  `parentTaskId` query semantics). That's a single `find()` with embedded
  subdocuments requiring a `$elemMatch`-style query, or a separate
  subquery into each parent's array — a plain top-level query is simpler
  and matches how the frontend already needs the data shaped (a flat list
  it groups into a tree client-side — see
  `apps/web/src/pages/project/ProjectTasksTab.tsx`).
- **No duplicated validation/status/priority logic.** A subtask has
  exactly the same fields and rules as a top-level task (status enum,
  priority enum, acceptance criteria, requirement link). Embedding would
  mean either a second, parallel subdocument schema with the same rules
  (duplication) or contorting the main schema to serve double duty.
- **Explicitly not the same as dependency edges.** The instructions call
  out that "dependency edges are not the same as parent/subtask
  relationships and should remain conceptually separate" — `parentTask` is
  a simple tree-structure pointer (one parent, ordinary hierarchy); actual
  dependency edges (`taskA` blocked-by `taskB`) are Batch B's concern and
  deliberately not modeled yet, so no `dependencies` field exists on `Task`
  today (adding it now would be exactly the "avoid speculative fields"
  the phase instructions warn against).

**Trade-offs**:

- Deleting a task must explicitly cascade to its subtasks (`Task.service.ts`'s
  `deleteTaskForOwner` does a BFS over `parentTask` to collect and delete the
  full subtree) — with embedding this would be "free" (deleting the parent
  document deletes its embedded array automatically). Accepted: the BFS is a
  handful of lines and the alternative's downsides (above) are worse.
  **Update (2026-09-23, focused corrective pass)**: this ADR originally
  deferred ancestor-cycle detection, reasoning that a multi-hop cycle
  wasn't reachable through the API. That reasoning was wrong — a
  `PATCH .../tasks/:id` re-parent onto a task whose own ancestor chain
  loops back to the task being updated _is_ reachable (e.g. build a chain
  A←B←C, then re-parent A onto C). `task.service.ts`'s `assertReferences`
  now calls `assertNoCycle(ownerId, proposedParentId, taskId)` for every
  update that sets `parentTaskId`: it walks upward via `parentTask` links
  from the proposed parent, and rejects (`400`) if that walk ever reaches
  the task being updated — a cycle of any length, not just direct
  self-parenting. A `visited` `Set` bounds the walk even against a
  pre-existing corrupt chain (can't loop forever), plus an explicit
  `MAX_ANCESTOR_HOPS` cap as a second bound. Not needed on **create**,
  since a brand-new task can't yet be anyone's ancestor. See
  `routes/__tests__/task.integration.test.ts`'s `"parentTask cycle
prevention"` block (2-hop, 3-hop, 4-hop cycles; valid branch
  re-parenting; valid deep-chain re-parenting not falsely rejected;
  cross-project/cross-user checks still intact).
- No enforced nesting-depth limit (a subtask of a subtask is allowed). Not
  restricted because nothing in the current UI or requirements needs a
  restriction; revisit if deep nesting turns out to be a real product need.

**Consequences**: `Task.parentTask: ObjectId | null`, indexed
(`{project: 1, parentTask: 1}`). `docs/DATABASE_DESIGN.md` documents the
resulting query patterns.

## ADR-009: Batch A frontend stack additions

**Context**: Phase 4 needs routing, a design system, and reusable UI
primitives; Phases 5–6 need real data fetching/mutation for four resources
(projects, requirements, tasks, and their forms).

**Decisions** (each evaluated against "is it necessary / does an existing
tool already cover it / what's the maintenance cost," per the phase
instructions):

- **React Router** (`react-router-dom`) — the only real option for
  client-side routing in a Vite SPA; no existing routing solution to reuse.
  Used with plain `<Routes>`/`<Route>` (not the newer data-router/loader
  APIs) since this app already has its own fetching layer (TanStack Query)
  — adopting both would be two competing data-fetching stories.
- **TanStack Query** (`@tanstack/react-query`) — this is the point flagged
  back in Phase 1's ADR: "planned starting Phase 5 when real caching/
  mutation needs exist." Four resources with list/detail/create/update/
  delete and cross-resource cache invalidation (deleting a requirement
  must refresh the tasks that referenced it) is exactly that need. Replaces
  what would otherwise be a hand-rolled fetch/loading/error/cache system
  duplicated four times.
- **`@radix-ui/react-dialog`** — the only new _UI_ dependency. Focus
  trapping, Escape-to-close, and click-outside-to-close for a modal are
  genuinely easy to get subtly wrong by hand (focus can leak to the page
  behind the dialog, breaking keyboard/screen-reader users); Radix solves
  this correctly and is unstyled (no design-system lock-in, still styled
  with this project's own Tailwind classes). The full shadcn/ui toolchain
  was considered and **rejected** — it's a code-generation CLI that scaffolds
  many components at once; this batch needs exactly one hard primitive
  (Dialog), not a dozen. `Button`, `Card`, `Badge`, `EmptyState`, form
  fields, etc. are hand-built Tailwind components (a few lines each,
  nothing accessibility-hard about them) rather than pulled from a library.
- **`lucide-react`** — icons, per the master spec's explicit "use Lucide
  icons consistently" instruction. No alternative considered.
- **No shared enum package.** Requirement/task status and priority enums
  are defined once in each backend model file
  (`apps/api/src/models/Requirement.ts`, `Task.ts`) and re-declared as
  frontend TS union types (`apps/web/src/types/requirement.ts`, `task.ts`).
  `packages/shared` remains empty. Setting up a real workspace-linked,
  built shared package for a handful of string-literal unions isn't
  justified yet — per the phase instructions' explicit allowance to
  document this trade-off rather than force sharing. `packages/shared` is
  still the intended home for the Batch B dependency-graph engine, where
  the API and (likely) a frontend graph visualization genuinely need the
  same algorithm, not just the same string literals.
- **No shadcn/ui, no Redux/Zustand, no second validation library, no new
  ORM** — none introduced; all explicitly out of scope per the batch
  instructions and nothing in this batch's actual requirements needed them.

**Consequences**: `apps/web/package.json` gains `react-router-dom`,
`@tanstack/react-query`, `@radix-ui/react-dialog`, `lucide-react`. Bundle
size grew from the Phase 3 baseline (240KB/73KB gzip) to 400KB/122KB gzip —
reasonable for four new routed resources, a router, a query cache, and a
modal library; verified via `npm run build --workspace apps/web`, not
assumed.

## ADR-010: Dependency graph engine lives in `apps/api/src/lib`, not `packages/shared`

**Context**: ADR-009 (Batch A) reserved `packages/shared` specifically for
this engine, on the assumption a future frontend graph visualization would
need it too. Batch B's actual scope explicitly rules that out this batch
("a list-based dependency review is sufficient... do not build a complex
graph editor"), so there is no current cross-package consumer.

**Selected**: Implement in `apps/api/src/lib/dependencyGraph.ts` (plain
functions over `{nodes, edges}`, no framework/DB coupling) instead.
`packages/shared` stays empty.

**Reason**: Setting up a real build pipeline for a shared package — a
`package.json` whose `exports` resolves correctly under both `tsc`
typecheck _and_ the actual `node dist/server.js` production runtime (a
bare `"./src/index.ts"` export resolves fine for typecheck/dev via
tsx/vitest's on-the-fly TS handling, but plain Node in production cannot
execute a `.ts` file directly without a build step compiling
`packages/shared` to JS and wiring that into the root build pipeline) — is
real infrastructure work with no current payoff, since nothing outside
`apps/api` imports this code yet. Full reasoning and the exact runtime
mechanics in `docs/DEPENDENCY_ENGINE.md`.

**Trade-offs**: if/when a frontend graph visualization is built, this
module moves to `packages/shared` (unchanged internals, just relocated
with its test file) and the build tooling gets set up at that point,
because something will concretely need it then.

**Consequences**: `docs/DEPENDENCY_ENGINE.md` documents this so the choice
isn't mistaken for an oversight of the earlier ADR-009 commitment.

## ADR-011: Plan persistence — a dedicated `Plan` model, materialized to real `Task`s only on approval

**Context**: Batch B needs to persist AI-generated plans for human review
without ever treating them as real project data until approved.

**Options considered**: (1) a dedicated `Plan` model holding suggested
tasks as embedded subdocuments; (2) create real `Task` documents
immediately with a `source: "ai-suggested"` / `status: "proposed"` flag,
skipping a separate model entirely.

**Selected**: Option 1 — `Plan` (embedded `suggestedTasks` subdocuments,
`{ _id: false }` since they're never queried independently of their
parent plan) with lifecycle `needs_review → approved | rejected`.
Approval materializes `suggestedTasks` into real `Task` documents in
`plan.service.ts#approvePlanForOwner`; rejection creates none.

**Reason**: Option 2 would mean every task-listing query in the app (the
Tasks tab, filters, counts) has to account for a "not really a task yet"
state, and a rejected/unedited AI suggestion would need to be deleted
rather than just have its `Plan` marked `rejected` — more surface area for
a bug to leak an unapproved suggestion into what the user sees as their
real task list. Keeping proposals in a separate model makes "has this
been approved" structurally unambiguous: if it's a `Task`, a human
approved it (or created it manually) — there's no third state to account
for anywhere else in the codebase.

**No stored intermediate "generated but not yet validated" state**:
generation and validation happen synchronously in the same request
(`plan.service.ts#generatePlan`); an invalid plan is never written to the
database at all (`422`, nothing persisted). The lifecycle column starts at
`needs_review`, not `generated` — "Generated → Validated" collapses into
one step because nothing is saved until it's already validated.

**No MongoDB transaction for approval**: this deployment runs standalone
MongoDB (Docker Compose, no replica set — see ADR-002), which doesn't
support multi-document transactions. `approvePlanForOwner` creates
multiple `Task` documents without one. Safe without a transaction
specifically because the resulting real-id dependency graph is a
structural relabeling (tempId → ObjectId, 1:1) of the graph already
validated as acyclic at generation time — there's no code path where
materialization itself introduces a defect the earlier validation didn't
already rule out. This reasoning does not generalize to arbitrary
multi-document writes; documented here because it's the actual argument
for why skipping a transaction is safe in this one case, not a general
policy.

**Consequences**: `docs/DATABASE_DESIGN.md` documents the `Plan` schema
and the two-pass materialization (create all tasks first to learn real
ids, then resolve `dependsOn` references — see the code comment in
`plan.service.ts` for why a single pass can't work).

## ADR-012: AI provider mocked in backend tests — first use of `vi.mock` outside frontend code

**Context**: every backend test so far (Phases 2–3, Batch A) runs against
the real MongoDB container — deliberately, per this project's established
testing philosophy that integration tests against the real thing catch
more than mocks do. Batch B's AI provider is different: it's slow,
non-deterministic, and the instructions explicitly require tests not to
depend on a running Ollama instance.

**Selected**: `plan.integration.test.ts` still runs against the real
database (real `Plan`/`Task`/`Requirement`/`Project`/`User` documents,
real ownership/cross-project checks) but mocks only
`services/ai/index.js`'s `getAIProvider` via `vi.mock` with
`importOriginal` preserving the real `AIProviderError` class (so
`instanceof` checks in `plan.service.ts` still work against errors
constructed in tests).

**Reason**: this isn't a general retreat from the "test against the real
thing" philosophy — MongoDB is a dependency this project controls and can
run reliably in CI/local dev (`npm run db:up`); a third-party LLM server
is not, and requiring it for `npm test` would make the suite flaky and
slow for no correctness benefit (the provider's _own_ correctness isn't
what's being tested — `plan.service.ts`'s handling of what the provider
returns is).

**Consequences**: every AI-provider failure mode (unavailable, timeout,
malformed JSON, schema-invalid, cyclic) is exercised deterministically via
mocked `complete()` responses — see `docs/AI_SYSTEM.md`'s failure table
and `docs/TESTING.md`.

## ADR-013: Local-first product direction — what's retained, what's deferred

**Context**: the product direction changed from an implicit multi-user
SaaS engineering-workspace framing to an explicit local-first,
single-user planning assistant that imports an existing project,
analyzes it read-only, and produces evidence-backed plans (see
`docs/PRODUCT_SCOPE_LOCAL.md`). This ADR records the architectural
decisions made to align the existing Phases 0–3/Batch A/Batch B
implementation with that direction, without a rewrite.

**1. Authentication and ownership: retained as-is, not removed or
simplified now.** `requireAuth` (`apps/api/src/middleware/auth.middleware.ts`)
and the denormalized `owner` field on every resource (`Project`,
`Requirement`, `Task`, `Plan`) are load-bearing: every service/controller
in the codebase queries via `Model.findOne({_id, owner})`, and every
route is gated on `req.user`. Removing or simplifying this now would
touch every model, service, controller, route, and test in the project
for no product benefit — "single-user" describes how many people use one
DevFlow instance at a time, not "no login." A local account also remains
useful groundwork if DevFlow ever supports multiple local profiles or
multiple imported-project workspaces sharing one instance. **Decision:
retained temporarily; revisit in a controlled future phase** if it proves
to be pure friction once ingestion features land, per the explicit
options given for this decision. This satisfies product principle 11
("security boundaries must remain intact even in a local-first
application") by construction — nothing was weakened.

**2. MongoDB: retained for local persistence.** The existing
`docker-compose.yml` already binds MongoDB to `127.0.0.1` only (ADR-002)
— it was never a cloud dependency, so nothing about it conflicts with
"local-first." Introducing an embedded/file-based database (e.g. SQLite)
would be a real migration with no demonstrated requirement driving it;
per the efficiency rules, that's not a change to make on convenience
alone. **Decision: no change.**

**3. Imported source project representation: decided, not yet
implemented.** A future `Project` will optionally reference a local
filesystem directory (a `sourcePath`-shaped field) distinct from
DevFlow's own managed data (name/description/status/requirements/tasks/
plans, all in MongoDB as today). No schema field was added in this pass
— see point 6 below for why. The distinction that matters: **DevFlow-
managed data** (everything in MongoDB) may be freely created/edited/
deleted by DevFlow; **the imported project's own files** are foreign data
DevFlow only ever reads.

**4. Source-project read-only boundary.** Recorded as a hard constraint
in `docs/PRODUCT_SCOPE_LOCAL.md`: once ingestion exists, DevFlow's
backend may only read files under an imported project's path (open/stat/
readFile) — never write, delete, rename, or execute anything inside it.
No ingestion code exists yet, so there is nothing to enforce this against
today; it's recorded now so the constraint is designed in from the first
line of that future code, not retrofitted after the fact.

**5. Ollama stays server-side.** Unchanged from Batch B (ADR-003) — the
frontend has never called Ollama directly, and nothing about this
direction change requires revisiting that boundary.

**6. Plan/Task schema: no fields added this pass, despite Batch B gaps.**
Reviewed `Plan.suggestedTasks` against what evidence-backed planning will
eventually need and found real gaps: no source-file references, no
evidence/confidence fields, no confirmed/inferred/proposed distinction,
no impacted-file representation, no "why is this file relevant"
explanation, no source-analysis metadata, no project-import context. **None
of these gaps were closed in this pass.** Adding schema fields with zero
consumers (no API reads/writes them, no UI renders them) would be exactly
the kind of dead, unused configuration this project just found and
removed elsewhere (Batch B's `AI_MAX_RETRIES` — see
`docs/IMPLEMENTATION_LOG.md`) — a field is not "safe" just because it's
optional; an unconsumed field is still a maintenance liability and a
false signal of progress. The gap list above is the actual deliverable of
this review: it's what the revised Batch C's schema work needs to close,
recorded once here rather than rediscovered later. Today's `Plan` schema
remains fully backward compatible — nothing about it changed.

**7. Deterministic analysis vs. AI interpretation (product principles 5–6,
8).** Not yet applicable in code — there is no deterministic
source-analysis step to distinguish from AI interpretation, because
ingestion doesn't exist. Recorded as a design constraint for when it does:
whatever a future scanner/analyzer determines with certainty (a file
exists, an import statement references another file) must be represented
separately from what the AI infers or proposes, and the AI must never be
allowed to assert a "confirmed fact" that didn't come from the
deterministic layer. The dependency graph engine (`lib/dependencyGraph.ts`)
is a template for this pattern — it already never trusts the AI's claimed
edges without independently validating them — but it operates on
AI-proposed task dependencies, not real code dependencies, so it is not
itself the deterministic code-analysis layer this principle describes.

**Consequences**: this pass is documentation- and product-boundary-only;
see `docs/IMPLEMENTATION_LOG.md`'s "Local-First Product Alignment" entry
for the complete, non-code-changing file list. The revised Batch C
implementation (ingestion, scanning, evidence-backed plan schema) starts
from a clean, honestly-scoped foundation rather than from code that
silently claimed capabilities it didn't have.

## ADR-014: Secure filesystem boundary + read-only scanner (Batch C1)

**Context**: ADR-013 deferred project ingestion entirely. This batch (C1)
implements its foundation: associating a project with a local directory
and scanning it read-only. Several decisions had real trade-offs.

**1. Boundary enforcement: canonicalize once at configuration, reject
symlinks during traversal — not a chroot/sandbox.** `lib/fsSafety.ts`
resolves the configured root through `fs.realpath` once (trusting the
project owner's explicit choice), then during traversal `scanner.service.ts`
calls `fs.lstat` (never `fs.stat`) on every entry and skips — never
follows — anything reporting `isSymbolicLink()`, which on Windows also
covers directory junctions (verified empirically on this environment, not
assumed — see `docs/TESTING.md`). This is a real, enforced boundary at the
application layer, not OS-level sandboxing/isolation (no chroot, no
container, no restricted user) — a compromised or buggy Node process
itself is not contained. That level of isolation wasn't attempted; it's a
known limitation, not a claim.

**1a. Scan-time root re-validation uses `lstat`, not `realpath` (added in
a targeted post-implementation verification pass).** The initial
implementation re-validated the stored root at scan time by calling
`resolveScanRoot` again — which calls `fs.realpath`, and `realpath`
always resolves symlinks in the _final_ path component too. That meant
if the configured directory were deleted and replaced by a symlink
pointing elsewhere between configuration and scan time, re-validation
would silently follow it — exactly the kind of substitution the
traversal's own "never follow a symlink" policy exists to prevent,
just not applied to the root itself. Fixed with a dedicated
`revalidateScanRoot` (`lib/fsSafety.ts`) that `lstat`s the exact stored
path and rejects if it's now a symlink (`root_changed`), never
re-resolving through it. Verified both at the unit level (a real
junction substituted for a real directory on disk) and end-to-end
through the actual scan API. See `docs/TESTING.md`.

**1b. A real duplicate-record bug, found by a mocked-failure test, not
inspection.** The scanner originally recorded a directory's item as
`"scanned"` unconditionally, then — if `readdir` on it subsequently
failed — pushed a _second_ item for the same `relativePath` with
`status: "error"`. Two records for one path violates the scanner's own
"no duplicate records" guarantee (see point 6's ignore-policy/output
determinism discussion) and would have misled anything reading the
inventory (which record is authoritative?). Caught by a deterministically
mocked `readdir`-failure test — the scan-crashing risk fixed alongside
this (see point 1) meant `sortEntries`, which the directory branch also
calls, could throw too, so both `readdir` and `sortEntries` are now
computed _before_ the directory's single item is recorded, and exactly
one of "scanned" or "error" is pushed, never both. See `docs/TESTING.md`.

**2. `path.relative`-based boundary check, not `startsWith`.**
`isPathInsideRoot` computes `path.relative(root, candidate)` and rejects
anything that climbs (`..`) or is itself absolute (a different drive) —
the standard correct technique. A naive string-prefix check would
incorrectly treat `C:\Projects\App-Outside` as inside `C:\Projects\App`;
this is directly tested (see `docs/TESTING.md`).

**3. Scanning is synchronous, not a background job.** A single API
request runs the scan to completion (or until a limit stops it) and
returns the result. No job queue, no polling endpoint, no cancellation.
Chosen over building a job system because: the configured limits
(`SCAN_MAX_FILES`, `SCAN_MAX_DURATION_MS`, etc.) already bound worst-case
request time to something reasonable, and a job system is real
infrastructure (queue, worker, status polling, the frontend UX for all of
that) with no demonstrated need yet at this project's actual scale. If a
future batch needs genuinely large-project scanning, this will need
revisiting — recorded here so it isn't silently forgotten.

**4. `Project.sourceConfig.canonicalPath` is `select: false` plus a
`toJSON` transform strips it — the same double-guard `User.ts` uses for
`passwordHash`.** The canonical absolute path is a real local filesystem
path on whatever machine runs the API; there's no product reason to ever
return it to a client, and every ordinary `Project` query already omits
it by default. Only `sourceConfig.service.ts`/`scan.service.ts` opt in
via `.select("+sourceConfig.canonicalPath")`. The frontend only ever sees
`label` (the path's basename, computed server-side) — see
`docs/API_DOCUMENTATION.md`.

**5. `Scan` is its own persisted model, not embedded on `Project`** — same
reasoning as `Plan` (ADR-011): a project can accumulate many scans over
time, each is a snapshot worth keeping for its own sake (audit/debugging),
and an unbounded embedded array on `Project` would grow the document
without limit. Cascade-deleted alongside `Requirement`/`Task`/`Plan` on
project deletion (see `project.service.ts`).

**6. Ignore policy is name-based and case-insensitive, not glob-based.**
No glob library was added (`node_modules`, `.git`, etc. are matched by
exact directory name via a fixed `Set`, lowercased for comparison) —
sufficient for the common generated/dependency directories this batch
targets, and avoids a new dependency for a problem this small. A
path-based or glob-based policy is a documented possible future
enhancement, not implemented now.

**7. Classification is extension/path-based only — no content
inspection.** `lib/fileClassification.ts` never reads a file's bytes to
classify it; a renamed file (e.g. a binary given a `.txt` extension) will
be misclassified. This is explicitly documented as a limitation rather
than silently assumed accurate — see `docs/TESTING.md` and the "Known
limitations" section of the Batch C1 implementation-log entry.

**Consequences**: `docs/API_DOCUMENTATION.md` documents the new
`/source` and `/scans` endpoints; `docs/DATABASE_DESIGN.md` documents the
`Scan` collection and `Project.sourceConfig`; `docs/SECURITY.md`
documents the read-only guarantee and its actual (not idealized) limits.

## ADR-015: Deterministic import extraction + resolution (Batch C2)

**Context**: Batch C1 produces a file inventory but no relationships
between files. Batch C2 extracts real import/require statements from
supported source files and resolves the ones it can prove, against the
scan's own recorded inventory — the foundation for a future dependency
graph, not the graph itself.

**1. Parser: TypeScript's own `ts.createSourceFile`, not regex.**
`lib/importExtraction.ts` uses the `typescript` package's public parsing
API — already a project dependency (moved from `devDependencies` to
`dependencies` in `apps/api/package.json` since it's now used at
runtime, not just for `tsc`/typecheck). No new dependency was added.
Chosen over regular expressions because import syntax has real edge
cases a regex handles unreliably (string quoting, comments containing
the word `import`, template literals) — and over adding a separate
parser library, since one already ships with the project. Only syntax
parsing is performed — no `Program`/`TypeChecker` is created, so nothing
is type-checked, no other files are touched, and no code is ever
executed or evaluated.

**2. Non-literal dynamic `import()`/`require()` arguments are recorded,
never guessed.** `import(someVariable)` or `require(getModuleName())`
are real call sites worth preserving as evidence, but their target can't
be known without executing code. Extraction records a safe, truncated
snippet of the actual source expression (`node.getText()` — printing
source text, never evaluating it) and marks it `isLiteral: false`;
resolution immediately classifies these `"unsupported"` rather than
attempting anything clever. `SourceFile.parseDiagnostics` (an internal,
not-publicly-typed field, verified empirically to work — see
`docs/TESTING.md`) drives whole-file `"parse_error"` detection, with a
fail-open fallback (treated as no errors) if that field is ever absent,
since a false "healthy" read is safer here than a false "broken" one.

**3. Resolution runs against the scan's frozen inventory, never live
disk.** `lib/importResolution.ts` takes zero filesystem calls — it
matches a raw import string against the `Set` of relative paths a
_specific scan_ already recorded. This is deliberate: the scan is
already the project's frozen source of truth (ADR-014), and resolving
against live disk state would let a confirmed relationship silently
depend on files that didn't exist at scan time, or fail to find ones
that did but have since been deleted. A stale analysis is only ever
compared against its own scan, never blended with another one's
inventory. Reading file _content_ (extraction's input) is the one step
that does need disk I/O, and reuses the exact same `revalidateScanRoot`/
`resolveSafeChild` boundary scanning already uses — no new or weaker
filesystem access path was introduced.

**4. Resolution rules are deliberately narrow, not "best effort."**
Only relative specifiers (`./`, `../`) are resolved, in one fixed
priority order (exact match → `.ts`/`.tsx`/`.js`/`.jsx` extension
appending → `index.*` in that same order within a matching directory).
Bare specifiers (`react`, `@scope/pkg`) are always `"external"` — never
inspected against `node_modules`, which doesn't exist in the scan
inventory at all. Aliases (`@/`, `~/`) and absolute/rooted imports are
always `"unsupported"` — no tsconfig `paths` config is read or honored.
An import with an explicit, non-JS/TS extension (`.css`, `.json`, `.svg`,
...) is always `"unsupported"` too, even if a file with that exact name
exists in the inventory — resolving CSS-module/JSON-as-module imports
has real semantics (bundler loaders, Node's JSON support) this batch
does not implement, and an exact-name match isn't evidence that those
semantics apply. None of this is guessed or inferred from convention;
every rule is one specific, tested code path.

**5. `Analysis` is its own model, tied to a `scan` id, not embedded on
`Scan` or folded into a graph model.** Same reasoning as `Scan`/`Plan`:
a scan can be analyzed more than once (e.g. after this code changes),
each run is a snapshot worth keeping, and `GET .../scans/:id/analysis`
returns the latest one — mirroring the `Plan`/`Scan` "keep the record,
serve the most recent" pattern rather than inventing a new one.
Deliberately NOT a dependency graph: `relationships` is a flat list of
extracted evidence, not nodes/edges with cycle detection or topological
order — building an actual graph from this evidence is out of scope for
this batch (see `docs/PRODUCT_SCOPE_LOCAL.md`).

**6. `parse_error` is a relationship-level status, not a separate
top-level failure.** A file that can't be read or parsed still produces
exactly one relationship record (empty `rawImport`, `status:
"parse_error"`, a safe `reason`) rather than being silently dropped or
aborting the whole analysis — consistent with the scanner's own
"diagnostics are recorded, not discarded" policy (ADR-014). A whole-
analysis `"failed"` outcome is reserved for the case where analysis
can't even start (e.g. the scan itself already failed, or the source
directory is no longer valid) — checked before any file is read, so it
never appears alongside partial relationship data.

**Consequences**: `docs/API_DOCUMENTATION.md` documents the new
`/api/scans/:id` and `/api/scans/:id/analysis` endpoints;
`docs/DATABASE_DESIGN.md` documents the `Analysis` collection;
`docs/TESTING.md` documents the full extraction/resolution test matrix
and the `parseDiagnostics` empirical verification.

## ADR-016: Canonical dependency graph engine (Batch C3)

**Context**: Batch C2 produces evidence-backed relationships, but nothing
turns them into an actual graph — nodes, edges, cycle detection,
topological order. Batch C3 builds that layer, purely, from data that's
already persisted.

**1. New file: `lib/sourceDependencyGraph.ts`, not `lib/dependencyGraph.ts`.**
That name is already taken — Batch B's dependency graph engine (task
`dependsOn` edges for AI plans) lives there. Inspecting it first paid
off: it already operates on plain `{nodes: string[], edges: {from,to}[]}`
with `string` ids and has zero task-specific logic in its algorithms
(`validateGraph`, its internal cycle detection, `topologicalSort`,
`getDependencies`, `getDependents`, `getReadyTasks`, `getBlockedTasks`).
Rather than reimplementing cycle detection and topological sort a second
time, `sourceDependencyGraph.ts` **imports and reuses those exact
functions** — already tested by Batch B's 20 tests — converting its own
richer node/edge/evidence model to and from the core `{nodes, edges}`
shape at the boundary. This is the same "don't rebuild a working, tested
algorithm" reasoning that led to reusing `revalidateScanRoot`'s lstat
approach elsewhere; here it meant a smaller, more trustworthy diff than a
second hand-rolled DFS.

**2. Edge direction: importer → imported module, and it's the SAME
convention Batch B already uses.** `{from: A, to: B}` means "A imports
B" — equivalently "A depends on B; B must exist/be understood before A's
import of it is meaningful." This is identical in shape to Batch B's "A
depends on B; B must complete before A is ready," which is exactly why
the core module's `getDependencies`/`getDependents` map over without any
semantic translation: `getDirectDependencies(graph, "src/App.tsx")` is
the files App.tsx imports; `getDirectDependents(graph, "src/Header.tsx")`
is the files that import Header.tsx. Documented once, here, and never
reversed in any function in either file.

**3. A node's id IS its scan-relative path — no synthetic id.** Stable,
deterministic, scan-scoped, and impossible to derive from array position
(there is no array position involved). Never an absolute filesystem
path — the engine never touches the filesystem at all, so there's
nothing to derive an absolute path from in the first place. Backslashes
are normalized to forward slashes defensively (scan-relative paths are
already always forward-slash per Batch C1/C2, but the graph engine
doesn't assume its caller got that right).

**4. `buildDependencyGraph` never trusts a "confirmed" status blindly.**
Every confirmed relationship's importer and resolved target are
independently re-checked against the inventory `buildDependencyGraph`
was actually given — not the inventory the relationship was originally
resolved against. A relationship whose paths don't appear in the given
inventory (e.g. accidentally sourced from a different scan) produces a
structured `importer_not_in_inventory`/`target_not_in_inventory`
validation error and is skipped — it never becomes a phantom node or a
silently-accepted edge. This is the direct enforcement of "cross-scan
relationship contamination" the batch's own spec called out, and is
tested with a dedicated fixture.

**5. Duplicate (importer, target) pairs merge into one edge; no evidence
is ever dropped.** If a file imports the same resolved target more than
once (two statements, or two raw specifiers that both resolve to the
same file), that's one structural dependency — represented as one edge
— but every contributing relationship's evidence (raw import text, line/
column, resolution method) is kept in that edge's `evidence` array, in
the order encountered. Two imports with the _same raw text_ but
_different resolved targets_ remain two distinct edges — deduplication
keys on the resolved `(from, to)` pair, never on raw text alone.

**6. `unresolved`/`external`/`unsupported`/`parse_error` relationships
are preserved in full, in their own arrays — never merged into confirmed
edges, never discarded.** This mirrors Batch C2's own "never silently
drop a relationship" principle one layer up: the graph is additive proof
of what's confirmed, not a filter that quietly loses everything else.

**7. Structural readiness invents no task-execution state.**
`getStructurallyReadyNodes`/`getStructurallyBlockedNodes` take an
arbitrary, caller-supplied `completedNodeIds` set with whatever meaning
the caller assigns — the engine itself has no concept of a file being
"done." Naming and doc comments say "structurally" explicitly so this is
never mistaken for a real task/build status the engine doesn't have.

**8. No new persistence — the graph is computed on demand from `Scan`

- `Analysis`, both already stored.** `services/graph.service.ts` loads
  the scan (ownership-checked) and its latest analysis, converts the
  Mongoose relationship subdocuments to plain objects at that boundary
  (their richer Mongoose-array type doesn't structurally satisfy the pure
  engine's plain-array parameter type — a real, if minor,
  `exactOptionalPropertyTypes`-adjacent TypeScript issue hit during
  implementation), and calls `buildDependencyGraph`. No `Graph` Mongoose
  model exists, and none was needed: the graph is a pure, deterministic
  function of data that's already durable, so a persisted copy would only
  ever be a cache that could go stale relative to a re-run analysis — the
  smallest-implementation instruction this batch was given, applied
  literally.

**Consequences**: `docs/API_DOCUMENTATION.md` documents
`GET /api/scans/:id/graph`; `docs/TESTING.md` documents the full
graph-correctness test matrix (basic shapes, node validation, edge
construction, cycle detection, topological order semantics, structural
analysis, determinism-under-shuffling, and purity).

## ADR-017: Frontend dependency graph visualization (Batch C4) — no new library

**Context**: Batch C3's `GET /api/scans/:id/graph` produces a complete,
correct graph, but nothing renders it. This batch needed to decide how.

**1. No graph-visualization library was added — plain SVG instead.**
Considered `@xyflow/react`/Cytoscape/vis-network-class libraries, all of
which either need a companion layout library (they place nodes, not lay
them out) or ship a full interaction/rendering framework heavier than
this feature needs. Given the batch's own stated priority — "Accuracy,
traceability, performance... more important than visual complexity" and
"Do not add a dependency merely for visual polish" — and given the
backend already computes everything a layout would need
(`topologicalOrder`), a library added no real capability here beyond
gesture polish, at the cost of a new dependency to vet/lock/maintain and
a canvas/SVG library that's typically hard to exercise meaningfully in
`jsdom`. `apps/web/package.json` is unchanged this batch.

**2. Layout is derived data, not a graph algorithm.** The frontend never
detects cycles, resolves paths, or constructs graph structure — it only
assigns screen coordinates using values the backend already computed:
node column/row position comes directly from `graph.topologicalOrder`
(or a stable id sort when the graph is cyclic and no order exists),
wrapped into a fixed-width grid purely for on-screen readability.
"Which edges are part of a cycle" is read by taking consecutive pairs
within each `cycles` entry — indexing into data already given, not
re-running cycle detection. See `apps/web/src/components/graph/DependencyGraphCanvas.tsx`.

**3. The accessible structured view is the primary interface; the SVG is
a complement, not a replacement.** `ProjectGraphTab.tsx` always renders a
sortable/clickable Files table, a Confirmed Dependencies table, a Cycles
list, and a four-section Diagnostics panel (Unresolved/External/
Unsupported/Parse Errors) as plain semantic HTML — every one of these
works, and is tested, with the SVG canvas absent entirely (e.g. in
jsdom). The SVG adds a visual complement with the same click-to-select
behavior, sharing one selection state with the structured view, and
carries its own single `role="img"` accessible summary
(`aria-label`) describing file/edge/cycle counts as a text alternative
to the whole diagram.

**3a. Edges render as two SVG elements, not one — found necessary by
real-browser verification, not anticipated up front.** A visible,
non-interactive line (`pointer-events: none`) is painted before the
nodes; an invisible, wider hit-line carrying the click/keyboard/
`aria-label` semantics is painted _after_ the nodes. Without this split,
Playwright's real hit-testing showed that a click on an edge's visible
line routinely landed on an unrelated node's `<rect>` instead — SVG
gives later-painted elements pointer-event priority, and in a dense grid
layout an edge's line frequently passes under a node it isn't connected
to. `jsdom`-based tests never caught this, since they don't perform real
layout/hit-testing — a concrete reason the browser-verification pass
existed. Residual limitation, reported honestly rather than chased
further: in a very dense graph, the longest/most-central edges can still
land on a pixel where multiple edges' hit-areas overlap each other; the
Confirmed Dependencies table remains fully reliable regardless of
density.

**4. Selection, not editing.** Clicking a node or edge (in either the
SVG or the tables) only changes local UI state (`selection`) and shows
a read-only Details panel — evidence, direct dependencies/dependents.
No action in this batch writes to the backend except the one explicit,
button-triggered `POST /api/scans/:id/analysis` call (never fired
automatically on page load) needed to make the tab usable when a scan
exists but hasn't been analyzed yet.

**5. Non-confirmed relationships are never visually merged with
confirmed edges.** `unresolved`/`external`/`unsupported`/`parseErrors`
render only in the Diagnostics panel, each carrying its own
status-specific badge (`RELATIONSHIP_STATUS_META`) — never as a line in
the graph canvas or a row in the Confirmed Dependencies table. A
validation-errors banner is shown whenever `validationErrors.length > 0`,
stating the graph "may be incomplete" rather than implying full accuracy.

**Consequences**: `docs/TESTING.md` documents the Batch C4 frontend test
matrix; `docs/API_DOCUMENTATION.md` is unchanged — the existing
`GET /api/scans/:id/graph` contract was already sufficient, no backend
field was missing.
