# Security

Reflects what's actually implemented and verified as of Batch B (AI
planning + dependency graph foundation) plus the local-first
product-alignment pass. Updated as later phases add features with
security implications.

## Local-First Product Alignment

The product direction changed to local-first/single-user (see
`docs/PRODUCT_SCOPE_LOCAL.md`), but **no security control described below
was removed or weakened** — authentication and ownership enforcement are
retained as-is (ADR-013 in `docs/DECISIONS.md`), consistent with the
product principle that security boundaries remain intact even in a
local-first application.

## Filesystem Access Boundary (Batch C1)

DevFlow can now read from a locally-configured project directory (project
import + read-only scanning — see `docs/DECISIONS.md` ADR-014). What's
actually enforced, and its real limits:

- **Boundary check, not sandboxing**: `lib/fsSafety.ts`'s
  `isPathInsideRoot` uses `path.relative`-based comparison (rejects `..`
  climbs and cross-drive absolute paths), not a `startsWith` string
  check, which is a real and previously-documented class of bug (a
  similarly-prefixed sibling directory would pass a naive prefix check).
  This is an application-level boundary, not OS-level isolation — no
  chroot, container, or restricted OS user. A bug elsewhere in the Node
  process is not contained by this boundary alone.
- **Scan-time root re-validation uses `lstat`, not `realpath`**: a
  directory's approval doesn't carry forward blindly — `scan.service.ts`
  re-checks the stored path immediately before every scan via
  `revalidateScanRoot`. This deliberately does not re-resolve the path
  through `fs.realpath` (which would follow a symlink if the path had
  since been replaced by one); it `lstat`s the exact stored path and
  rejects outright if it's no longer a real directory. Found and fixed
  during a targeted post-implementation verification pass, verified with
  a real directory-to-junction substitution on disk. See
  `docs/DECISIONS.md` ADR-014.
- **Read-only, enforced by omission**: the scanner (`scanner.service.ts`)
  only ever calls `fs.readdir`, `fs.lstat`, and (implicitly, via those)
  reads metadata — there is no write/delete/rename/exec call anywhere in
  this code path. Verified by a dedicated test that fixture file contents
  and mtimes are byte-identical before and after a scan (see
  `docs/TESTING.md`).
- **Symlinks/junctions are never followed** during traversal — detected
  via `fs.lstat().isSymbolicLink()` and skipped, recorded as
  `skipReason: "symlink"`. Verified empirically on this Windows
  environment that this also catches directory junctions (a separate NTFS
  feature from symlinks). **Not verified**: behavior for every
  reparse-point type on every OS (e.g. cloud-sync placeholder files use
  reparse points too) — a real, stated limitation, not a claim of
  universal coverage.
- **Resource limits are cooperative, not preemptive**: `SCAN_MAX_FILES`/
  `SCAN_MAX_DEPTH`/`SCAN_MAX_DIRECTORIES`/`SCAN_MAX_DURATION_MS` are
  checked between directory entries — a single slow/huge in-flight `fs`
  call cannot be preempted mid-read.
- **No absolute-path leakage**: `Project.sourceConfig.canonicalPath` is
  `select: false` plus stripped again by a `toJSON` transform (the same
  double-guard `User.passwordHash` uses); every API response carries only
  `label` (the basename). Verified by an integration test that greps the
  full response body for the raw fixture path. Scan error messages are
  mapped to a short safe category (`"Permission denied"`, `"Read error"`,
  etc.) rather than passing through raw OS error text, which can contain
  local paths.
- **No OS-level sandboxing, no content-based malware/secret scanning**:
  out of scope for this batch, not implemented, not claimed.

## Import Extraction & Resolution (Batch C2)

Reads scanned files' _content_ for the first time (Batch C1 only read
metadata) — this reuses the exact same boundary as scanning, nothing new
or weaker:

- File reads go through `resolveSafeChild`/`revalidateScanRoot`, the same
  functions the scanner itself uses — no separate or parallel filesystem
  access path was introduced for this feature.
- No client-supplied path is ever used for analysis — the only input is
  a scan id (ownership-checked, validated `ObjectId`); the source
  directory always comes from the project's already-configured,
  server-side `sourceConfig.canonicalPath`.
- **Parsing never executes code.** `lib/importExtraction.ts` only calls
  TypeScript's syntax parser (`ts.createSourceFile`) — no
  `eval`/`Function`/`vm`/child-process/require-of-arbitrary-code path
  exists anywhere in the extraction or resolution code. A dynamic
  `import()`/`require()` whose argument isn't a plain string literal is
  never evaluated — only its literal source text is recorded (safely
  truncated), and it's always classified `"unsupported"`.
- **Resolution never touches the filesystem** — it matches import
  strings against the scan's own already-recorded file list in memory,
  so there's no additional path-traversal surface beyond what scanning
  itself already defends against (ADR-014's boundary check applies
  identically here, since resolved paths are checked against real
  scanned relative paths, never constructed from unchecked strings).
- File reads are bounded by the existing `SCAN_MAX_FILE_SIZE_BYTES` limit
  (checked via `fs.stat` before `fs.readFile`) — no new env var was
  needed.

## Canonical Dependency Graph (Batch C3)

`lib/sourceDependencyGraph.ts` has **zero filesystem access of any
kind** — verified both by inspection (no `fs` import anywhere in the
file) and by a test that mocks `node:fs` to throw on any call and
confirms the engine still builds and analyzes a graph successfully. It
operates only on plain data already produced by scanning (Batch C1) and
analysis (Batch C2): a scan's recorded file list and an analysis's
extracted relationships. `GET /api/scans/:id/graph` computes the graph
on demand from the already-ownership-checked scan and its latest
analysis — no client-supplied path is accepted anywhere in this
endpoint, and node identifiers in every response are scan-relative
paths, never the server's absolute filesystem paths (which remain
`select: false` on `Project.sourceConfig`, untouched by this batch).

## Authentication

- **Token**: a single JWT access token (HS256, `jsonwebtoken`), payload
  `{ sub: userId, role }`. Signed with `JWT_ACCESS_SECRET` — required, no
  default, validated to be ≥32 characters via Zod; the app refuses to boot
  otherwise.
- **Transport**: httpOnly, `SameSite=Lax` cookie (`devflow_token`), never
  returned in a JSON response body. `secure: true` only when
  `NODE_ENV=production` (local dev is plain HTTP). See
  `docs/DECISIONS.md` ADR-007 for the full reasoning and alternatives
  considered.
- **Expiry**: `JWT_ACCESS_TTL`, default 1 hour. No refresh-token rotation
  in this phase (see Limitations).
- **Logout**: clears the cookie. Stateless JWT — no server-side revocation
  (see Limitations).

## Password Security

- Hashed with `bcryptjs`, 12 salt rounds (`apps/api/src/utils/password.ts`).
  Plaintext is never stored, logged, or returned in any response.
- `User.passwordHash` is `select: false` (excluded from queries by
  default) **and** stripped again by a `toJSON` transform on the schema —
  two independent guards, so it can't leak through generic serialization
  even if a future query explicitly re-selects it.
- Password policy: 8–72 characters, no forced complexity rules (length
  over composition, per NIST 800-63B). 72 is bcrypt's own input limit —
  validated at the Zod layer so an over-length password gets a clear 400
  instead of silent truncation.
- **Login timing safety**: a login attempt for a nonexistent email still
  runs a real bcrypt compare (against a fixed dummy hash) before returning
  401, so the response time doesn't reveal whether the email is
  registered — bcrypt's cost dominates total request time, so skipping it
  for "no such user" would make that path measurably faster and leak
  account existence via timing even though the response body is identical.
- **No account enumeration via error message**: login failures (wrong
  password vs. nonexistent account) return the exact same message,
  `"Invalid email or password"`, with the same status code (401).
  Registration _does_ reveal a duplicate email (`409`, "already exists") —
  this is intentional and standard: the user needs to know to log in
  instead, and registration doesn't carry the same enumeration risk as a
  login oracle.

## Authorization (Project Ownership)

- Every project route requires authentication (`requireAuth` middleware).
- Ownership is enforced **in the query itself**
  (`Project.findOne({ _id, owner: req.user.id })`), not by fetching a
  document and checking a field afterward — a non-owner's request simply
  matches nothing.
- A project that exists but belongs to someone else returns **404**, the
  same as a project that doesn't exist at all — deliberately
  indistinguishable. A `403` would confirm the ID refers to a real project
  even to a non-owner, letting them enumerate/probe IDs.
- `req.user.id` comes only from the verified JWT payload — no route ever
  trusts a client-supplied user id from a request body or param instead.
- Verified directly (not just unit-tested): registered two real users
  against the running database, confirmed User B gets 404 reading/
  updating/deleting User A's project, confirmed the project is unchanged
  afterward, confirmed a malformed ID returns 400 and a well-formed but
  nonexistent ID returns 404. See `docs/IMPLEMENTATION_LOG.md` Phase 3
  entry.

## Authorization (Requirements & Tasks — Batch A)

Extends the same model, with two additional attack surfaces specific to
these resources: **nested-collection routes** (`:projectId` in the URL)
and **cross-resource references** (`requirementId`/`parentTaskId` in the
request body).

- **`Requirement`/`Task` denormalize `owner`** from their parent project at
  creation (never client-settable) so single-resource routes
  (`GET/PATCH/DELETE /api/requirements/:id`, `/api/tasks/:id`) are
  query-level-ownership-enforced exactly like `Project` — no route ever
  fetches a requirement/task first and checks ownership as a second step.
- **Nested collection routes cannot be used to access another user's
  project.** `POST/GET /api/projects/:projectId/requirements` (and the
  `/tasks` equivalent) call `getProjectForOwner(userId, projectId)` before
  doing anything else — if `:projectId` isn't the caller's, this throws
  404 before any requirement/task read or write happens. **Verified
  directly**: registered User A and User B, had User B attempt
  `POST /api/projects/<A's project>/requirements` and
  `POST /api/projects/<A's project>/tasks` — both returned 404, nothing
  was created. See `docs/IMPLEMENTATION_LOG.md`.
- **Cross-project references are rejected, not silently accepted.**
  `assertRequirementInProject`/`assertParentTaskInProject`
  (`task.service.ts`) query `{_id, owner, project}` together — a
  `requirementId`/`parentTaskId` that's real, owned by the caller, but
  belongs to a _different_ project than the task being created/updated
  still fails (`400`, not treated as valid). This closes what would
  otherwise be an IDOR-adjacent hole: a user can't use their own real
  resource IDs to smuggle a cross-project link that the UI never intended
  to allow. **Verified directly**: created a requirement under Project 1,
  attempted to link a new task under Project 2 to it — rejected with 400.
- **A task cannot be its own parent, nor part of a multi-hop cycle.**
  Direct self-parenting (`parentTaskId === taskId`) is checked explicitly
  before the cross-project check runs. Beyond that, `assertNoCycle` walks
  the full proposed-parent ancestor chain and rejects the update if it
  ever reaches the task being updated — a cycle of any length, fixed in
  the 2026-09-23 focused corrective pass (see ADR-008).
- **Query filters are validated, not just trusted.** `validateQuery` runs
  the same Zod-schema treatment on `?status=`/`?priority=`/
  `?requirementId=`/`?parentTaskId=`/`?search=` as request bodies get —
  an invalid enum value or malformed ObjectId in a query param returns a
  clean 400 rather than either being silently ignored (which could
  surprise a user into thinking a filter is active when it isn't) or
  reaching a raw Mongoose query.
- **Deletion cascades stay owner-scoped.** `deleteProjectForOwner`'s
  cascade (`Requirement.deleteMany`/`Task.deleteMany`) filters by both
  `project` _and_ `owner` — even though `project` alone would already be
  correct (a project can only be deleted by its owner, and requirements/
  tasks can only belong to one project), the redundant `owner` filter is
  defense in depth against a future refactor accidentally loosening the
  project-ownership check without someone also updating the cascade.

## AI Planning & Authorization (Batch B)

- **Same ownership model as Requirements/Tasks**: `Plan` denormalizes
  `owner`, so single-resource routes are query-level-enforced;
  `POST /api/projects/:projectId/plans/generate` and the collection `GET`
  call `getProjectForOwner` before touching anything, same as
  requirements/tasks. **Verified directly**: registered two users, had
  User B attempt to generate a plan under User A's project and to read/
  edit/approve/reject User A's plan — all four returned `404`. See
  `docs/IMPLEMENTATION_LOG.md`.
- **AI output is never trusted, and never auto-approved.** Every
  generation is re-validated (Zod structural checks + the dependency
  graph engine's cycle/self/duplicate/missing-reference checks) before
  anything is persisted — an invalid plan is rejected with `422` and
  **not saved at all**, not saved-then-flagged. A valid, saved plan still
  requires an explicit `POST /api/plans/:id/approve` before any `Task`
  document is created; there is no code path where a generated plan
  becomes real project data without that step. **Verified directly** (not
  just unit-tested): a cyclic AI-suggested plan was generated (mocked
  provider) and confirmed both `422` and zero `Plan` documents written to
  the database.
- **Prompt injection can't bypass validation.** The requirement
  title/description (user-controlled text) is embedded directly in the
  prompt sent to the model (`promptBuilder.ts`) — a malicious or
  adversarial requirement description could attempt to instruct the model
  to ignore the schema, emit extra fields, or otherwise misbehave. This
  is a real, known LLM risk category. The mitigation isn't trying to
  sanitize the prompt input (impractical against a determined attempt) —
  it's that **the response is validated identically regardless of what
  instructions it contains**: `aiPlanSchema` and the graph checks operate
  purely on the returned JSON's shape and edges, with no path where
  prompt content influences what gets accepted. Worst case, a successful
  injection makes the model return unhelpful or malformed output, which
  is rejected the same way any other malformed output is.
- **Cross-project reference validation is reused, not reimplemented.**
  Approval resolves `suggestedTasks[].dependsOn` tempIds into real
  `Task.dependencies` ObjectIds — but the underlying graph structure was
  already validated as acyclic (with no dangling references) at
  generation time, using the exact same `validateGraph` function real
  manual task edits would use if that path existed (see
  `docs/DEPENDENCY_ENGINE.md`). There is no second, separately-written
  cycle-detection path for AI-suggested edges that could drift out of
  sync with the one that protects manually-entered `parentTask` edges
  (Phase 3's corrective pass) or would eventually protect manual
  `Task.dependencies` edits.
- **`GET /api/ai/status` never leaks server-side config.** Returns only
  `{available, provider, model}` — `provider`/`model` are configuration
  _names_ (`"ollama"`, `"qwen2.5:7b"`), never `OLLAMA_BASE_URL` or any
  other value from `env.ts`. Confirmed by reading the controller: it
  calls `checkAIProviderStatus()`, which itself only reads `env.AI_PROVIDER`/
  `env.OLLAMA_MODEL` for the name strings — `OLLAMA_BASE_URL` is never
  referenced anywhere outside `ollamaProvider.ts`.
- **The AI provider is never called from frontend code.** `apps/web` only
  ever talks to `apps/api`'s own routes (`/plans/generate`, `/ai/status`);
  there is no code path, dependency, or env var (`VITE_*` or otherwise)
  that would let the frontend bundle reach Ollama directly or learn its
  address. Checked directly: `apps/api/src/services/ai/` is never
  imported from anything under `apps/web/src/`.
- **No secrets to leak in this configuration.** Ollama is local and
  requires no API key — there is no AI provider credential in `.env` to
  accidentally expose. This changes if a hosted provider is ever added
  (see `docs/AI_SYSTEM.md`'s Known Limitations); that addition would need
  its own credential-handling review at that time.

## Input Validation

- Every auth and project request body is validated with Zod
  (`validateBody` middleware) before it reaches a service or the database.
  Failures return `400 VALIDATION_ERROR` with field-level detail, handled
  centrally in `errorHandler.ts`.
- The database's unique index on `email` — not an application-level
  pre-check — is what's authoritative for duplicate registration. A
  pre-check-then-insert pattern would leave a race window between two
  concurrent registrations for the same email; instead the insert is
  attempted directly and the resulting duplicate-key error (Mongo code 11000) is translated to a `409`.

## Rate Limiting

- `POST /api/auth/register` and `POST /api/auth/login` only (not a
  general API rate limit — see `AUTH_RATE_LIMIT_WINDOW_MS`/
  `AUTH_RATE_LIMIT_MAX`, default 10 attempts / 15 minutes / IP).
- **Limitation**: in-memory store (`express-rate-limit`'s default) — resets
  on process restart and isn't shared across multiple instances. Fine for
  a single-instance deployment; would need a shared store (Redis) to scale
  horizontally.
- **Limitation**: IP-based. Naive behind a shared NAT or corporate proxy
  (many real users share one IP) and spoofable if the app is ever deployed
  behind a proxy without correctly configured `trust proxy` / forwarded-IP
  handling — not yet configured, since this is a local-dev deployment
  today.
- Disabled when `NODE_ENV=test` — otherwise the test suite's many
  deliberate invalid-login/duplicate-registration cases would trip it and
  produce flaky, unrelated 429s. This is an intentional, standard testing
  pattern, not a bypass that exists in real environments.

## Logging

- `pino` request/response logging redacts `req.headers.cookie`,
  `req.headers.authorization`, and `res.headers["set-cookie"]` —
  verified directly: ran the real login/register/me/logout flow against a
  running dev server and grepped the log output; every occurrence showed
  `"[redacted]"`, and no plaintext password appeared anywhere in the log
  file. See `docs/IMPLEMENTATION_LOG.md`.
- Request bodies are not logged by `pino-http` by default, so passwords in
  a register/login request body are never logged either.

## CSRF

`SameSite=Lax` on the auth cookie means it isn't sent on cross-site
POST/fetch/XHR requests initiated by a third-party page — the classic CSRF
vector — while still being sent on same-site requests between
`localhost:5173` and `localhost:4000`. Combined with the existing strict
CORS allow-list (only `CORS_ORIGIN` is permitted for credentialed
requests), this covers the current same-site local topology without a
separate CSRF-token system.

**Limitation**: this stops working the way it's designed to if frontend
and API are ever deployed to genuinely different registrable domains — a
cross-site deployment needs `SameSite=None; Secure`, which reopens the CSRF
vector `Lax` currently closes, and would need a real CSRF token
(double-submit cookie or synchronizer token) at that point. Documented here
so it isn't forgotten at deployment time (Phase 11).

## Known Limitations (Phase 3)

- **No refresh-token rotation** — a single 1-hour access token, longer
  than the 15-minute default typically paired with refresh rotation. This
  is a deliberate, documented trade-off (see ADR-007), not an oversight.
- **No server-side token revocation** — logout clears the cookie but
  doesn't invalidate the token server-side; a token captured before logout
  (via a compromised machine with disk/memory access — not via XSS, since
  httpOnly blocks that vector) remains valid until its natural expiry.
- **No account lockout / anomaly detection** beyond the rate limiter above.
- **No email verification** — registration is immediate, no confirmation
  step. Acceptable for the current scope; would matter for a real
  deployment with real user accounts.
- **No password reset flow** — out of scope for this phase.
- **No inactive/disabled account state** — the User schema has no status
  field beyond `role`; not introduced since nothing in this phase needs it
  (per the phase instructions: "if such states are introduced" — they were
  not).
- Graceful-shutdown behavior (`disconnectDB()` on process termination) is
  covered by an automated test but real OS-level `SIGTERM` delivery to a
  running process wasn't verified in this environment (Windows has no true
  POSIX signal equivalent) — same limitation noted in Phase 1/2.

## Known Limitations (Batch A)

- ~~Multi-hop `parentTask` cycles aren't detected.~~ **Fixed** (2026-09-23,
  focused corrective pass): `task.service.ts`'s `assertNoCycle` walks the
  full proposed-parent ancestor chain on every update that sets
  `parentTaskId`, rejecting (`400`) a cycle of any length, not just direct
  self-parenting. Verified with real 2-hop, 3-hop, and 4-hop cycle test
  cases against the live database, plus confirmation that valid deep
  acyclic chains and cross-branch re-parenting are _not_ falsely rejected.
  See ADR-008 and `docs/IMPLEMENTATION_LOG.md`.
- **The dashboard's project statistics are computed client-side** from
  data the browser already has via `GET /api/projects` (which is already
  ownership-scoped to the caller) — no separate aggregation endpoint, so
  no new server-side data-exposure surface was added for it.

## Known Limitations (Batch B)

- **`Task.dependencies` isn't settable through the general task-update
  endpoint** — only populated via plan approval. Manual dependency editing
  is a documented near-term enhancement, not a security gap (there's
  simply no additional attack surface until that endpoint exists).
- **No AI-specific rate limiting.** `POST /api/projects/:projectId/plans/generate`
  isn't rate-limited the way `/api/auth/login`/`/register` are — a
  malicious authenticated user could spam generation requests against
  their own project (self-inflicted cost, not a cross-user risk, but
  still a real resource-exhaustion concern against the local Ollama
  process and worth addressing before any multi-tenant/hosted deployment).
- **No per-user or global AI usage quota/cost tracking** — irrelevant for
  a free local model, would matter immediately if a paid hosted provider
  is ever added.
- **Prompt/response content isn't logged**, which is good for not leaking
  potentially sensitive requirement text into logs, but also means there's
  no audit trail of exactly what was sent to or received from the
  provider beyond `aiMeta`'s metadata — a debugging/trust trade-off worth
  being aware of, not treated as a defect.

## Production Recommendations (not yet implemented)

- Add refresh-token rotation with revocation if session length needs to
  shorten below 1 hour.
- Configure `trust proxy` correctly and consider a distributed rate-limit
  store if deployed behind a load balancer or to multiple instances.
- Add a CSRF token if frontend and API are ever deployed to different
  registrable domains.
- Add email verification and password reset flows if real user accounts
  are ever created (not just a portfolio demo).
- Rate-limit `POST /api/projects/:projectId/plans/generate` before any
  deployment where AI compute has a real cost or shared capacity
  constraint (see Known Limitations, Batch B).
