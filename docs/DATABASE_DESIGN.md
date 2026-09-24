# Database Design

MongoDB via Mongoose. Local development runs it in Docker (see
`docker-compose.yml`); `MONGODB_URI` is the single source of truth for where
the API connects, so swapping to a managed service (e.g. Atlas) later is a
config change, not a code change.

## Collections

### `users`

| Field                     | Type        | Notes                                                                                                                                                                                                                                                                        |
| ------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email`                   | String      | required, unique (indexed), lowercased + trimmed, format-validated                                                                                                                                                                                                           |
| `passwordHash`            | String      | required, `select: false` (excluded from query results by default) **and** stripped again by a `toJSON` transform (Phase 3) — two independent guards against leaking it; populated by `bcryptjs` (12 salt rounds) on registration — never a plaintext password, never logged |
| `displayName`             | String      | required, trimmed, 1–100 chars                                                                                                                                                                                                                                               |
| `role`                    | String enum | `"member" \| "admin"`, default `"member"` — minimal role model; a full permissions system isn't needed yet                                                                                                                                                                   |
| `createdAt` / `updatedAt` | Date        | via Mongoose `timestamps: true`                                                                                                                                                                                                                                              |

Source: `apps/api/src/models/User.ts`.

### `projects`

| Field                        | Type                  | Notes                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                       | String                | required, trimmed, 1–200 chars                                                                                                                                                                                                                                                                                                                                          |
| `description`                | String                | trimmed, ≤2000 chars, default `""`                                                                                                                                                                                                                                                                                                                                      |
| `owner`                      | ObjectId (ref `User`) | required, indexed — the primary access-control field once Phase 3 authorization lands ("a user may only act on projects they own")                                                                                                                                                                                                                                      |
| `status`                     | String enum           | `"planning" \| "active" \| "on_hold" \| "completed" \| "archived"`, default `"planning"`                                                                                                                                                                                                                                                                                |
| `sourceConfig.canonicalPath` | String                | Batch C1. The server-side absolute path of an imported local project directory. `select: false` **plus** a `toJSON` transform strip it — same double-guard `User.passwordHash` uses — so it never appears in an ordinary API response. Only `sourceConfig.service.ts`/`scan.service.ts` read it, via an explicit `.select("+sourceConfig.canonicalPath")`. See ADR-014. |
| `sourceConfig.label`         | String                | The safe display value returned to clients instead — the path's basename, computed server-side.                                                                                                                                                                                                                                                                         |
| `sourceConfig.configuredAt`  | Date                  | When the source directory was last (re)configured.                                                                                                                                                                                                                                                                                                                      |
| `createdAt` / `updatedAt`    | Date                  | via Mongoose `timestamps: true`                                                                                                                                                                                                                                                                                                                                         |

Source: `apps/api/src/models/Project.ts`.

### `requirements`

| Field                     | Type                     | Notes                                                                                                                                            |
| ------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `project`                 | ObjectId (ref `Project`) | required, indexed                                                                                                                                |
| `owner`                   | ObjectId (ref `User`)    | required, indexed — denormalized from `project.owner` at creation time (never client-settable, never changes). See "Denormalized `owner`" below. |
| `title`                   | String                   | required, trimmed, 1–200 chars                                                                                                                   |
| `description`             | String                   | trimmed, ≤5000 chars, default `""`                                                                                                               |
| `status`                  | String enum              | `"draft" \| "approved" \| "implemented"`, default `"draft"`                                                                                      |
| `priority`                | String enum              | `"low" \| "medium" \| "high" \| "critical"` (shared with `Task` — see `models/Requirement.ts`), default `"medium"`                               |
| `acceptanceCriteria`      | String[]                 | default `[]`                                                                                                                                     |
| `createdAt` / `updatedAt` | Date                     | via `timestamps: true`                                                                                                                           |

Source: `apps/api/src/models/Requirement.ts`.

### `tasks`

| Field                     | Type                                   | Notes                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`                 | ObjectId (ref `Project`)               | required, indexed                                                                                                                                                                                                                                                                                                               |
| `owner`                   | ObjectId (ref `User`)                  | required, indexed — denormalized, same as `Requirement.owner`                                                                                                                                                                                                                                                                   |
| `requirement`             | ObjectId (ref `Requirement`) \| `null` | optional, indexed. Must belong to the _same_ `project` as the task — enforced in `task.service.ts`, not by the schema (Mongoose refs don't cross-validate).                                                                                                                                                                     |
| `parentTask`              | ObjectId (ref `Task`) \| `null`        | optional, indexed — see ADR-008 for why subtasks are separate documents with this self-reference rather than embedded. Must belong to the same `project`; a task cannot reference itself. Both enforced in `task.service.ts`.                                                                                                   |
| `title`                   | String                                 | required, trimmed, 1–200 chars                                                                                                                                                                                                                                                                                                  |
| `description`             | String                                 | trimmed, ≤5000 chars, default `""`                                                                                                                                                                                                                                                                                              |
| `status`                  | String enum                            | `"todo" \| "in_progress" \| "blocked" \| "in_review" \| "done"`, default `"todo"`                                                                                                                                                                                                                                               |
| `priority`                | String enum                            | shared with `Requirement`, default `"medium"`                                                                                                                                                                                                                                                                                   |
| `acceptanceCriteria`      | String[]                               | default `[]`                                                                                                                                                                                                                                                                                                                    |
| `dependencies`            | ObjectId[] (ref `Task`)                | Batch B. Direction: this task depends on each listed task — see `docs/DEPENDENCY_ENGINE.md`. Validated (same-project, acyclic) by `apps/api/src/lib/dependencyGraph.ts`. Populated today only via `Plan` approval (`plan.service.ts`) — not yet settable through the general task-update endpoint; see Known Limitations below. |
| `createdAt` / `updatedAt` | Date                                   | via `timestamps: true`                                                                                                                                                                                                                                                                                                          |

Source: `apps/api/src/models/Task.ts`. Indexed: `{project: 1, dependencies: 1}`
(multikey) for dependent lookups.

### `plans`

| Field                     | Type                                                                             | Notes                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`                 | ObjectId (ref `Project`)                                                         | required, indexed                                                                                                                                                            |
| `owner`                   | ObjectId (ref `User`)                                                            | required, indexed — denormalized, same pattern as `Requirement`/`Task`                                                                                                       |
| `requirement`             | ObjectId (ref `Requirement`)                                                     | required — the source requirement the plan was generated from                                                                                                                |
| `status`                  | String enum                                                                      | `"needs_review" \| "approved" \| "rejected"`, default `"needs_review"`. See `docs/AI_SYSTEM.md`'s Human Approval Lifecycle.                                                  |
| `title`, `summary`        | String                                                                           | required                                                                                                                                                                     |
| `assumptions`, `risks`    | String[]                                                                         | default `[]`                                                                                                                                                                 |
| `suggestedTasks`          | Array of `{tempId, title, description, acceptanceCriteria, priority, dependsOn}` | embedded subdocuments (`{_id: false}`) — proposals, not real `Task`s; only materialized into real `Task` documents on approval                                               |
| `suggestedOrder`          | String[]                                                                         | `tempId`s in topological order — **computed by the dependency graph engine**, never trusted from the AI                                                                      |
| `validation`              | `{valid: Boolean, errors: Mixed[]}`                                              | a snapshot of the validation outcome at generation time; `errors` is expected to always be empty in practice since an invalid plan is never saved — kept for audit/debugging |
| `aiMeta`                  | `{provider, model, generatedAt, durationMs}`                                     | traceability metadata; the raw prompt and full provider response are **not** stored (avoid retaining a potentially large/sensitive payload beyond what explains the plan)    |
| `reviewedAt`              | Date \| `null`                                                                   | set on approve/reject                                                                                                                                                        |
| `createdAt` / `updatedAt` | Date                                                                             | via `timestamps: true`                                                                                                                                                       |

Source: `apps/api/src/models/Plan.ts`. Indexed: `{project: 1, createdAt: -1}`.

### `scans`

| Field                     | Type                                                                                                                              | Notes                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`                 | ObjectId (ref `Project`)                                                                                                          | required, indexed                                                                                                                                                |
| `owner`                   | ObjectId (ref `User`)                                                                                                             | required, indexed — denormalized, same pattern as `Requirement`/`Task`/`Plan`                                                                                    |
| `outcome`                 | String enum                                                                                                                       | `"completed" \| "completed_with_warnings" \| "failed"` — see `docs/DECISIONS.md` ADR-014 and `apps/api/src/services/scanner.service.ts`                          |
| `summary`                 | `{totalScanned, totalSkipped, totalErrors, filesByCategory, filesByLanguage, limitsReached, durationMs}`                          | aggregate counts computed by the scanner, never trusted-and-passed-through from anything external                                                                |
| `items`                   | Array of `{relativePath, type, category?, language?, extension?, sizeBytes?, status, skipReason?, errorCategory?, errorMessage?}` | embedded subdocuments (`{_id: false}`), one per scanned/skipped/errored file or directory, bounded by `SCAN_MAX_FILES`                                           |
| `errorMessage`            | String                                                                                                                            | only set when `outcome === "failed"` — a short, safe category description (see `scanner.service.ts`'s `safeErrorMessage`), never a raw OS error or absolute path |
| `createdAt` / `updatedAt` | Date                                                                                                                              | via `timestamps: true`                                                                                                                                           |

Source: `apps/api/src/models/Scan.ts`. Indexed: `{project: 1, createdAt: -1}`
(same pattern as `plans`, for "most recent scan" lookups).

### `analyses`

| Field                     | Type                                                                                                                                            | Notes                                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`                 | ObjectId (ref `Project`)                                                                                                                        | required, indexed                                                                                                                                                                     |
| `owner`                   | ObjectId (ref `User`)                                                                                                                           | required, indexed — denormalized, same pattern as `Scan`/`Plan`                                                                                                                       |
| `scan`                    | ObjectId (ref `Scan`)                                                                                                                           | required, indexed — the specific scan snapshot this analysis was run against; resolution is only ever validated against this one                                                      |
| `outcome`                 | String enum                                                                                                                                     | `"completed" \| "completed_with_warnings" \| "failed"` — see `docs/DECISIONS.md` ADR-015                                                                                              |
| `summary`                 | `{totalFilesAnalyzed, totalFilesSkipped, totalRelationships, byStatus}`                                                                         | `totalFilesSkipped` counts files whose language isn't yet supported for extraction (not an error); `byStatus` is a per-status count map                                               |
| `relationships`           | Array of `{importerRelativePath, rawImport, isLiteral, importType?, line?, column?, status, resolvedRelativePath?, resolutionMethod?, reason?}` | embedded subdocuments (`{_id: false}`), one per extracted import/require/export-from/dynamic-import call site, or one per file that couldn't be read/parsed (`status: "parse_error"`) |
| `errorMessage`            | String                                                                                                                                          | only set when `outcome === "failed"`                                                                                                                                                  |
| `createdAt` / `updatedAt` | Date                                                                                                                                            | via `timestamps: true`                                                                                                                                                                |

Source: `apps/api/src/models/Analysis.ts`. Indexed: `{scan: 1, createdAt: -1}`
(same "most recent for this scan" pattern as `plans`/`scans`).

Not yet added: `ActivityEvent` — lands in Phase 8 once there's real
behavior to attach it to.

### Denormalized `owner` on `Requirement` and `Task`

Both collections copy `owner` from their parent `Project` at creation time
rather than relying solely on the `project` reference. This means every
single-resource lookup (`GET /api/requirements/:id`, `GET /api/tasks/:id`,
and their `PATCH`/`DELETE` equivalents) can be a single, query-level-
ownership-enforced query — `Requirement.findOne({_id, owner})` — exactly
like `Project` itself, instead of a two-step "fetch the resource, then
fetch its parent project to check ownership" pattern. There's no
project-transfer/collaboration feature yet, so the denormalized copy can
never drift out of sync with the source of truth.

## Indexes

| Collection     | Index                                                                                                           | Why                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`        | `email` unique                                                                                                  | Enforces one account per email at the database level (schema `unique: true` — see caveat below) and speeds up login lookups.                                                                                                                                                                                                                                                              |
| `projects`     | `owner`                                                                                                         | Every "list my projects" / ownership-check query filters by `owner`; without this index that's a collection scan. **Load-bearing for authorization as of Phase 3** — `project.service.ts` bakes `owner: req.user.id` directly into every find/update/delete query filter (not a fetch-then-check), so this index is on the hot path of every protected project request, not just listing. |
| `requirements` | `project`, `owner`, compound `{project, createdAt}`                                                             | `project` + `owner` back every scoped query (list-by-project, single-resource ownership check); the compound index backs the sorted `find({project}).sort({createdAt: -1})` in `listRequirementsForProject`.                                                                                                                                                                              |
| `tasks`        | `project`, `owner`, `requirement`, `parentTask`, compound `{project, status}`, compound `{project, parentTask}` | `owner` for single-resource ownership checks (same pattern as `projects`/`requirements`); `requirement`/`parentTask` back the task-list filters (`?requirementId=`, `?parentTaskId=`); the compound indexes back the two most common list queries (filtered by status, or by parent for subtask lookups) without a full collection scan per project.                                      |
| `plans`        | `project`, `owner`, compound `{project, createdAt}`                                                             | Same "list-by-project + ownership check + recent-first" pattern as `requirements`.                                                                                                                                                                                                                                                                                                        |
| `scans`        | `project`, `owner`, compound `{project, createdAt}`                                                             | Backs `GET .../scans/latest`'s `findOne({project, owner}).sort({createdAt: -1})`.                                                                                                                                                                                                                                                                                                         |
| `analyses`     | `project`, `owner`, `scan`, compound `{scan, createdAt}`                                                        | `scan` backs the ownership-scoped "does this analysis belong to this scan" check; the compound index backs `GET .../analysis`'s `findOne({scan, owner}).sort({createdAt: -1})`.                                                                                                                                                                                                           |

**Caveat on `unique: true`**: Mongoose's `unique: true` only builds a unique
index — it is not itself a validation rule, so it's enforced by MongoDB at
write time (a duplicate `email` throws a MongoServerError, code 11000), not
by `document.validateSync()`. This is why `User.test.ts` doesn't test
uniqueness (no DB connection) and `database.integration.test.ts` /
`auth.integration.test.ts` do (against the real database) — see
`docs/TESTING.md`.

**This index is now genuinely load-bearing (Phase 3)**: `auth.service.ts`'s
`registerUser()` does **not** pre-check whether an email exists before
inserting — it attempts `User.create()` directly and translates the
resulting duplicate-key error into a `409`. A pre-check-then-insert
pattern would leave a race window between two concurrent registrations for
the same email; the database's unique index, not application code, is what
actually prevents two accounts with the same email from ever existing.

## Referencing vs. Embedding

`Project.owner` references `User` by ObjectId rather than embedding user
data, because: a user owns many projects (embedding would duplicate user
data across every project document), and project documents are queried
independently of user documents far more often than they're queried
together. Standard normalized reference for a 1-to-many ownership
relationship in Mongoose.

## Validation

Schema-level validation (`required`, `enum`, `minlength`/`maxlength`, the
email regex) runs on every `save()`/`create()` via Mongoose, and is also
exercised directly and cheaply in unit tests via `document.validateSync()`
— no database connection needed for that layer. Zod is used at the env-
config and (starting Phase 3) API-request-body layer; Mongoose schemas are
the validation layer for what's actually persisted. These are deliberately
separate: a request can be well-formed JSON per Zod but still violate a
DB-level constraint like uniqueness, and the API needs to handle both.

## Deletion Behavior

Implemented as of Batch A (verified against the real database — see
`docs/IMPLEMENTATION_LOG.md`):

- **Deleting a project cascades** to every `Requirement`, `Task`, `Plan`,
  `Scan`, and `Analysis` with that `project` id (`project.service.ts`'s
  `deleteProjectForOwner`). Projects already have a non-destructive
  alternative (`status: "archived"`), so an actual `DELETE` is a
  deliberate, irreversible action — cascading avoids leaving orphaned
  child documents behind rather than silently creating them. (`Plan` was
  missed here initially in Batch B and left orphaned rows behind — caught
  during Batch B's consolidated review and fixed; `Scan` and `Analysis`
  were both added to the cascade from the start in their own batches,
  having learned that lesson; see `docs/IMPLEMENTATION_LOG.md`.) Note
  this only deletes DevFlow's own
  records — a project's `sourceConfig.canonicalPath` points at a real
  local directory that DevFlow never had write access to in the first
  place, so there is nothing on disk to clean up.
- **Deleting a requirement does _not_ delete tasks that reference it** —
  it clears their `requirement` field (`requirement.service.ts`'s
  `deleteRequirementForOwner` runs `Task.updateMany(..., {$set: {requirement: null}})`).
  A task's identity isn't owned by the requirement the way a subtask is
  owned by its parent task.
- **Deleting a task cascades to its full subtask subtree** — a BFS over
  `parentTask` references collects every descendant before deleting them
  all in one `deleteMany` (`task.service.ts`'s `deleteTaskForOwner`).
  Deleting a task that has subtasks does not orphan them.

## Connection Lifecycle

`apps/api/src/config/database.ts`:

- `connectDB()` — connects with a bounded `serverSelectionTimeoutMS`
  (`DB_CONNECT_TIMEOUT_MS`, default 5000ms) so an unreachable database fails
  fast instead of hanging on Mongoose's 30s default. Called at server
  startup independently of `app.listen()` — a database outage does not
  prevent the process from starting or from serving the liveness check at
  `GET /api/health`.
- `disconnectDB()` — called during graceful shutdown (SIGTERM/SIGINT).
- `getDbState()` — exposes the current Mongoose `readyState` for
  `GET /api/health/db` (returns 200 when connected, 503 otherwise) — a
  standard liveness/readiness split so a DB outage is diagnosable without
  taking down the liveness check other tooling might depend on.
- Connection event listeners (`error`, `disconnected`, `reconnected`) log
  every state transition. Verified for real in Phase 2: stopping and
  restarting the `mongo` container while the API was running produced
  exactly the expected log sequence and `GET /api/health/db` status codes
  (200 → 503 → 200) with no process crash. See
  `docs/IMPLEMENTATION_LOG.md`.

## Example Documents (no sensitive data)

```json
// users
{
  "_id": "665f1a2b3c4d5e6f7a8b9c0d",
  "email": "dev@example.com",
  "displayName": "Dev User",
  "role": "member",
  "createdAt": "2026-09-23T10:00:00.000Z",
  "updatedAt": "2026-09-23T10:00:00.000Z"
  // passwordHash omitted from example — it's select:false and never logged
}

// projects
{
  "_id": "665f1a2b3c4d5e6f7a8b9c0e",
  "name": "DevFlow AI",
  "description": "Dependency-aware AI engineering planning workspace",
  "owner": "665f1a2b3c4d5e6f7a8b9c0d",
  "status": "active",
  "createdAt": "2026-09-23T10:05:00.000Z",
  "updatedAt": "2026-09-23T10:05:00.000Z"
}
```
