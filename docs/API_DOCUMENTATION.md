# API Documentation

Base URL: `http://localhost:4000/api` (local dev; `VITE_API_BASE_URL`
controls what the frontend targets). All request/response bodies are JSON.
Auth endpoints and every `/projects` endpoint set/require the
`devflow_token` httpOnly cookie — see `docs/DECISIONS.md` ADR-007 and
`docs/SECURITY.md`.

Error responses always have the shape:

```json
{ "error": { "message": "...", "code": "...", "details": {} } }
```

`details` is only present for `VALIDATION_ERROR` (Zod's flattened field
errors).

## Health

### `GET /api/health`

Liveness check — no database dependency, always 200 if the process is up.

```json
{ "status": "ok", "uptimeSeconds": 42, "timestamp": "2026-09-23T10:00:00.000Z" }
```

### `GET /api/health/db`

Readiness check — reflects the current Mongoose connection state.

- `200` `{ "status": "ok", "db": "connected" }`
- `503` `{ "status": "error", "db": "disconnected", "message": "Database is not connected" }`

## Authentication

### `POST /api/auth/register`

Rate-limited (`AUTH_RATE_LIMIT_MAX` per `AUTH_RATE_LIMIT_WINDOW_MS` per IP).

Request:

```json
{ "email": "dev@example.com", "password": "a-real-password", "displayName": "Dev User" }
```

- `email`: valid email format, normalized to lowercase/trimmed.
- `password`: 8–72 characters.
- `displayName`: 1–100 characters.

Responses:

- `201` — sets the `devflow_token` cookie, body: `{ "user": { "_id", "email", "displayName", "role", "createdAt", "updatedAt" } }` (never includes `passwordHash` or the raw token).
- `400 VALIDATION_ERROR` — invalid input.
- `409` — email already registered (`"An account with this email already exists"`).
- `429 RATE_LIMITED` — too many attempts.

### `POST /api/auth/login`

Rate-limited, same as register.

Request: `{ "email": "...", "password": "..." }`

Responses:

- `200` — sets a fresh cookie, body: `{ "user": {...} }`.
- `400 VALIDATION_ERROR` — missing/empty fields.
- `401` — `"Invalid email or password"` for **both** wrong password and
  nonexistent account (deliberately identical — see `docs/SECURITY.md`).
- `429 RATE_LIMITED`.

### `POST /api/auth/logout`

No auth required (idempotent no-op if already logged out).

- `200` `{ "message": "Logged out" }` — clears the cookie.

### `GET /api/auth/me`

Requires the auth cookie.

- `200` `{ "user": {...} }` — the currently authenticated user.
- `401` — missing, malformed, expired, or otherwise invalid token, or the
  token's user no longer exists. Always the same generic message,
  `"Invalid or expired session"` / `"Authentication required"` — never
  reveals _why_ a token failed.

## Projects

All routes below require the auth cookie (`401` if missing/invalid).
Ownership is enforced per the authenticated user — see
`docs/SECURITY.md`'s Authorization section for how.

### `POST /api/projects`

Request: `{ "name": "...", "description"?: "...", "status"?: "planning" | "active" | "on_hold" | "completed" | "archived" }`

- `201` `{ "project": {...} }` — `owner` is set to the authenticated user, never client-supplied.
- `400 VALIDATION_ERROR`.

### `GET /api/projects`

Lists only the authenticated user's own projects.

- `200` `{ "projects": [...] }`

### `GET /api/projects/:id`

- `200` `{ "project": {...} }`
- `400` — `:id` is not a valid MongoDB ObjectId.
- `404` — the project doesn't exist, **or** exists but belongs to someone
  else (indistinguishable, by design).

### `PATCH /api/projects/:id`

Request: any subset of `{ "name", "description", "status" }`.

- `200` `{ "project": {...} }` — the updated document.
- `400 VALIDATION_ERROR` or invalid ID.
- `404` — not found / not yours.

### `DELETE /api/projects/:id`

- `204` — no body.
- `400` — invalid ID.
- `404` — not found / not yours.
- **Cascades**: also deletes every `Requirement` and `Task` belonging to
  this project. See `docs/DATABASE_DESIGN.md` Deletion Behavior.

## Requirements

All routes require the auth cookie. Ownership is checked via the
requirement's own denormalized `owner` field (set from the parent
project's owner at creation, never client-supplied) — see
`docs/DATABASE_DESIGN.md`.

### `POST /api/projects/:projectId/requirements`

Request: `{ "title": "...", "description"?: "...", "status"?: "draft" | "approved" | "implemented", "priority"?: "low" | "medium" | "high" | "critical", "acceptanceCriteria"?: string[] }`

- `201` `{ "requirement": {...} }`
- `400 VALIDATION_ERROR`.
- `404` — `:projectId` doesn't exist or isn't the caller's (same
  anti-enumeration pattern as everywhere else).

### `GET /api/projects/:projectId/requirements`

Optional query: `?status=draft|approved|implemented`.

- `200` `{ "requirements": [...] }`, newest first.
- `404` — project not found/not yours.

### `GET /api/requirements/:id`

- `200` `{ "requirement": {...} }`
- `400` — invalid ID. `404` — not found / not yours.

### `PATCH /api/requirements/:id`

Request: any subset of the create body.

- `200` `{ "requirement": {...} }`
- `400 VALIDATION_ERROR` or invalid ID. `404` — not found / not yours.

### `DELETE /api/requirements/:id`

- `204` — no body. `400` — invalid ID. `404` — not found / not yours.
- **Does not delete tasks that reference it** — clears their `requirement`
  field instead. See `docs/DATABASE_DESIGN.md`.

## Tasks

All routes require the auth cookie. Same ownership pattern as Requirements.

### `POST /api/projects/:projectId/tasks`

Request: `{ "title": "...", "description"?: "...", "status"?: "todo" | "in_progress" | "blocked" | "in_review" | "done", "priority"?: "low" | "medium" | "high" | "critical", "acceptanceCriteria"?: string[], "requirementId"?: string | null, "parentTaskId"?: string | null }`

- `201` `{ "task": {...} }`
- `400 VALIDATION_ERROR` — includes a malformed `requirementId`/`parentTaskId`
  (wrong ObjectId format), **or** a well-formed one that doesn't belong to
  this project ("Requirement reference is invalid or belongs to a
  different project" / "Parent task reference is invalid or belongs to a
  different project") — cross-project references are always rejected.
- `404` — `:projectId` not found/not yours.

### `GET /api/projects/:projectId/tasks`

Optional query filters (all combinable): `?status=`, `?priority=`,
`?requirementId=`, `?parentTaskId=` (an id → that task's direct subtasks;
literal `none` → top-level tasks only; omitted → both, flat), `?search=`
(case-insensitive substring match on title).

- `200` `{ "tasks": [...] }`, newest first. **The frontend groups this flat
  list into a top-level/subtask tree client-side** — this endpoint doesn't
  return a nested structure. See `docs/ARCHITECTURE.md`.
- `404` — project not found/not yours.

### `GET /api/tasks/:id`

- `200` `{ "task": {...} }`
- `400` — invalid ID. `404` — not found / not yours.

### `PATCH /api/tasks/:id`

Request: any subset of the create body. Same cross-project-reference
validation as create, plus: a task cannot be set as its own `parentTask`
(`400`, "A task cannot be its own parent").

- `200` `{ "task": {...} }`
- `400 VALIDATION_ERROR` / invalid reference / invalid ID. `404` — not found / not yours.

### `DELETE /api/tasks/:id`

- `204` — no body. `400` — invalid ID. `404` — not found / not yours.
- **Cascades to the full subtask subtree** (a subtask of a subtask is also
  deleted). See `docs/DATABASE_DESIGN.md`.

## AI Status

### `GET /api/ai/status`

Requires the auth cookie (no project/ownership scope — this is global
provider info, not per-project data).

- `200` `{ "available": boolean, "provider": "ollama", "model": "qwen2.5:7b" }`
  — `provider`/`model` are names only, never a base URL or other
  server-side config. See `docs/SECURITY.md`.

## Plans

All routes require the auth cookie. Ownership follows the same
denormalized-`owner` pattern as Requirements/Tasks. See `docs/AI_SYSTEM.md`
for the full generation/validation/approval workflow.

### `GET /api/scans/:id/impact?file=<path>[&maxDepth=n][&maxNodes=n]`

Read-only change impact for one file (ADR-022), computed over the same
canonical graph as `/graph` (the scan's latest analysis). There is no AI
call, no rescan, no reanalysis and no filesystem access.

Edges point **importer → imported**:

- `directDependencies`: files the selected file imports.
- `directDependents`: files that import it.
- `transitiveDependents`: files that reach it through two or more
  confirmed imports. Each entry has a `depth` and a `via` (the next file
  on the shortest path), plus the evidence of that hop.

A change to the file _may_ affect its dependents. Its dependencies are not
implied to be affected. Only confirmed edges appear in these lists. The
file's own unresolved, external and unsupported imports are returned
separately in `nonConfirmedImports` and never count as impact.
`untraceable` gives whole-scan counts of relationships that could hide
more dependents, and `limitations` states that import edges don't prove
runtime usage.

- `file` follows the same path rules as AI-proposed paths: absolute,
  drive-letter and `..` paths are rejected with `400`.
- `maxDepth` (default 10, max 25) and `maxNodes` (default 200, max 1000)
  bound the traversal and each direct list. `totals` gives the exact
  direct counts, and `truncated` is `true` whenever a bound cut anything.
- `cycles`: at most 10 proven cycles that include the file, each
  `{ files, length, truncated }` with `files` cut to 50. `cyclesTotal` gives
  the exact number of such cycles.
- `nonConfirmedImports.{unresolved,external,unsupported}`: each capped at
  `maxNodes`; `nonConfirmedImports.totals` gives the exact counts.
- `scanLimitsReached`: walk-stopping scan limits (e.g. `maxFiles`). If it
  isn't empty, dependents may be missing entirely.
- `inGraph: false` for scanned files outside the analysed languages (e.g.
  `.css`): there is no import data for them, which is not the same as
  "no impact".
- `200` `{ "impact": { scanId, analysisId, analysisCreatedAt, file, ... } }`.
- `400` — unsafe or missing path, out-of-range bounds, or an invalid scan id.
- `401` — not authenticated.
- `404` — scan not found or not yours, no analysis for the scan, or the
  file isn't a file this scan observed. Near matches are never guessed.

### `POST /api/projects/:projectId/plans/generate`

Request: `{ "requirementId": string, "scanId"?: string }`.

A grounded prompt is fitted to the model's budget deterministically
(ADR-027). `sourceContext.fitting` records `budgetTokens`,
`estimatedTokensBefore`/`After`, the `steps` applied in order, and
`reductions` (`{ section, shown, total }`, with exact totals). `steps` is
empty when the full context fit. If even the smallest safe context
doesn't fit, the response is `422` ("smallest safe planning context …"),
returned before any AI call.

Optional `impactFile` (requires `scanId`; same path rules; `400` if unsafe
or given without `scanId`, `404` if it isn't a file this scan observed,
checked before any AI call). The target's bounded change impact (ADR-023,
depth 6, 30 files) is added to the prompt, and `sourceContext.impact`
records what the model was shown. Each in-scan affected file then gets a
server-verified `impactRelation`: `target`, `dependency`,
`direct_dependent`, `transitive_dependent`, or
`dependency_and_dependent` (a cycle). Absent means the file was not found
within the bounded impact, which is _not_ the same as unrelated. An
`impactRelation` supplied by the AI or a client is ignored.

C5.1 additions (all optional in AI output, so older plans stay valid):
each suggested task can have a `testingApproach`; each affected file can
have `change` (`"modify" | "create" | "test" | "reference"`, default
`"modify"`) as the AI's _claim_. The server adds `conflict` when the claim
contradicts the scan (for example `"create"` on an existing file, or
`"modify"`/`"reference"` on a path that isn't in the scan). A grounded
plan's `sourceContext` also records `focusTerms` and `focusFiles`: the
lexical requirement focus the model was shown.

With `scanId` (Batch C5), the plan is grounded in that scan and its latest
dependency analysis. The prompt gets a bounded, deterministic summary of
the recorded evidence, and the response carries `plan.sourceContext`
(scan and analysis ids plus exact evidence counts). Each suggested task
can have a `rationale` and `affectedFiles[]`. The server sets each file's
`evidence`: `"in_scan"` (with `dependentsCount`/`dependenciesCount` for
source files), `"not_in_scan"` (a proposed new file) or `"unverified"`
(no `scanId`). An `evidence` value supplied by the AI or client is ignored.

- `201` `{ "plan": {...} }` — status `"needs_review"`.
- `400 VALIDATION_ERROR` — malformed `requirementId` or `scanId`.
- `400` — the scan itself failed.
- `404` — project, requirement, or scan not found/not yours (requirement
  and scan must both belong to `:projectId`).
- `409` — the scan has no (successful) dependency analysis yet. The AI
  is not called.
- `422` — the AI's output failed structural or graph validation, including
  an absolute, drive-letter, or `..` file path (message lists every issue
  found); **nothing is persisted**.
- `422` — the prompt would not fit the configured model context
  (`OLLAMA_NUM_CTX`). It is not sent to the model; nothing is persisted.
- `502` — the provider's response wasn't valid JSON, or was too large to
  process.
- `503` — the AI provider is unavailable or timed out.

### `GET /api/projects/:projectId/plans`

- `200` `{ "plans": [...] }`, newest first. `404` — project not found/not yours.

### `GET /api/plans/:id`

- `200` `{ "plan": {...} }`. `400` — invalid ID. `404` — not found / not yours.

### `PATCH /api/plans/:id`

Request: any subset of `{ "title", "summary", "assumptions", "risks", "suggestedTasks" }`.

- `200` `{ "plan": {...} }` — the updated document.
- `409` — the plan has already been `approved`/`rejected` (immutable once reviewed).
- `422` — an edited `suggestedTasks` array failed graph re-validation (self/duplicate/cyclic/dangling dependency).
- `400 VALIDATION_ERROR` or invalid ID. `404` — not found / not yours.

### `POST /api/plans/:id/approve`

- `200` `{ "plan": {...}, "createdTasks": [...] }` — status becomes
  `"approved"`; `suggestedTasks` are materialized into real `Task`
  documents with `dependencies` resolved from the plan's `dependsOn`
  tempIds to real ObjectIds. Each created task carries `planEvidence`
  (C5.1): `{ plan, tempId, rationale, testingApproach, affectedFiles,
sourceContext: { scan, analysis, contextVersion } | null }`. It is an
  exact copy of that plan task's evidence at approval time: nothing is
  re-scanned, re-analysed or re-derived. Task create and update ignore
  `planEvidence` in the request body.
- `409` — already reviewed. `400`/`404` as above.

### `POST /api/plans/:id/reject`

- `200` `{ "plan": {...} }` — status becomes `"rejected"`. No tasks are created.
- `409` — already reviewed. `400`/`404` as above.

## Source Directory & Scanning (Batch C1)

All routes require the auth cookie. Ownership follows the same
denormalized-`owner` / query-scoped pattern as every other project-scoped
resource. See `docs/PRODUCT_SCOPE_LOCAL.md` and `docs/DECISIONS.md`
ADR-014 for the read-only boundary this is built on.

### `PUT /api/projects/:projectId/source`

Request: `{ "path": string }` — a local filesystem directory on the
machine running the API. Validated (must exist, must be a directory, UNC
paths rejected) before saving; saving does **not** trigger a scan.

- `200` `{ "sourceConfig": { "label": string, "configuredAt": string, "hasPath": true } }`
  — `label` is the path's basename, computed server-side. **The raw
  absolute path is never returned in any response.**
- `400` — empty/missing path, path doesn't exist, path is a file not a
  directory, or a UNC/device path.
- `404` — project not found/not yours.

### `GET /api/projects/:projectId/source`

- `200` `{ "sourceConfig": { "label": string | null, "configuredAt": string | null, "hasPath": boolean } }`.
- `404` — project not found/not yours.

### `POST /api/projects/:projectId/scans`

Runs a scan **synchronously** (the request blocks until it completes or a
limit stops it — see ADR-014; there is no background job system,
progress polling, or cancellation in this batch) and persists the result.

- `201` `{ "scan": {...} }` — `outcome` is `"completed"`,
  `"completed_with_warnings"`, or `"failed"`; `items` is the file
  inventory (see `docs/DEPENDENCY_ENGINE.md`-style honesty:
  `docs/DECISIONS.md` ADR-014 for what "read-only" actually guarantees).
- `400` — no source directory is configured for this project, or the
  configured directory is no longer valid (moved/deleted since
  configuration).
- `404` — project not found/not yours.

### `GET /api/projects/:projectId/scans/latest`

- `200` `{ "scan": {...} | null }` — `null` if no scan has been run yet.
- `404` — project not found/not yours.

### `GET /api/scans/:id`

Single-scan-by-id, ownership enforced via `Scan`'s own denormalized
`owner` field (no `:projectId` needed in the URL — same pattern as
`/api/plans/:id`).

- `200` `{ "scan": {...} }`.
- `400` — invalid id. `404` — not found / not yours.

## Import Extraction & Resolution (Batch C2)

All routes require the auth cookie. Ownership follows the scan's own
`owner` field. See `docs/DECISIONS.md` ADR-015 and
`docs/PRODUCT_SCOPE_LOCAL.md` for the extraction/resolution rules and
what "confirmed" actually means.

### `POST /api/scans/:id/analysis`

Runs extraction + resolution **synchronously** against the given scan's
own recorded file inventory (not live disk state) and persists the
result.

- `201` `{ "analysis": {...} }` — `outcome` is `"completed"` or
  `"completed_with_warnings"`; `relationships` lists every extracted
  import/require/export-from/dynamic-import site with its resolution
  `status` (`confirmed` / `unresolved` / `external` / `unsupported` /
  `parse_error`) and evidence (importer, raw import string, line/column,
  resolution method where applicable).
- `400` — the referenced scan itself has `outcome: "failed"` (nothing to
  analyze), or the project's configured source directory is no longer
  valid.
- `404` — scan not found/not yours.

### `GET /api/scans/:id/analysis`

- `200` `{ "analysis": {...} | null }` — `null` if analysis hasn't been
  run yet for this scan.
- `404` — scan not found/not yours.

## Canonical Dependency Graph (Batch C3)

### `GET /api/scans/:id/graph`

Computed on demand from the scan's own inventory and its **latest**
analysis — nothing is persisted separately, so this always reflects the
most recent `POST .../analysis` run. See `docs/DECISIONS.md` ADR-016.

- `200` `{ "graph": {...} }` —
  - `scanId`, `analysisId`: which scan/analysis this graph was built from.
  - `nodes`: `{id, language?, category?}[]`, sorted by `id`. `id` is the
    scan-relative path — never an absolute filesystem path.
  - `edges`: `{id, from, to, evidence: [...]}[]`, sorted by `(from, to)`.
    `from` imports `to`. `evidence` lists every underlying relationship
    that resolved to this exact pair (never just the first one).
  - `unresolved` / `external` / `unsupported` / `parseErrors`: every
    non-confirmed relationship, in full, never merged into `edges`.
  - `validationErrors`: structural problems found (e.g. a confirmed
    relationship whose target isn't actually in this scan's inventory).
  - `cycles`: every cycle found, each as an ordered id list with the
    start node repeated at the end. Empty if `isAcyclic` is `true`.
  - `topologicalOrder`: dependency-first order (a node appears only
    after everything it imports), or `null` if the graph has a cycle.
  - `rootNodes` / `leafNodes`: nodes nothing imports / nodes that import
    nothing locally.
- `400` — invalid scan id.
- `404` — scan not found/not yours, or no analysis has been run yet for
  this scan.

## Not Yet Implemented

A dedicated visualization endpoint for the Batch B (task) dependency
graph engine's ready/blocked/topological-order functions (exercised
during plan generation and unit-tested directly — see
`docs/DEPENDENCY_ENGINE.md` — but not yet exposed as their own
project-wide API), dashboard/analytics aggregation endpoints,
visualization of the Batch C3 canonical source-code dependency graph
(the graph itself now exists and is queryable via
`GET /api/scans/:id/graph`, but no frontend renders it),
evidence-backed AI plan generation grounded in that graph (see
`docs/PRODUCT_SCOPE_LOCAL.md`), paginated scan-inventory/analysis/graph
retrieval (all three return their full bounded result in one response),
Python (or any non-JS/TS/JSX/TSX) import extraction, alias/tsconfig-paths
resolution, `node_modules` inspection. This document is updated as each
lands; it does not describe endpoints that don't exist yet.
