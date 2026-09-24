# Testing

No test files changed during the local-first product-alignment pass that
followed Batch B — that pass was documentation/product-boundary only (see
ADR-013 in `docs/DECISIONS.md`), so the full test suite was re-run once
to confirm zero regressions rather than re-verified test-by-test. See the
"Local-First Product Alignment" entry in `docs/IMPLEMENTATION_LOG.md` for
that run's results.

## Strategy

Vitest across both apps (ADR-005). Two tiers, used deliberately for
different purposes:

1. **Pure unit tests** — no database, no network. Mongoose schema
   validation via `document.validateSync()`, password hashing via real
   `bcryptjs` calls (never mocked — see `docs/SECURITY.md`), JWT sign/
   verify via real `jsonwebtoken` calls including a genuinely expired
   token (crafted with a past `exp` claim, not a timing-based wait).
2. **Real integration tests** — against the actual running MongoDB
   (`npm run db:up`) and the real Express app via Supertest. Used wherever
   a unit test with mocks would provide less confidence than exercising
   the real thing — explicitly requested for Phase 3's auth/authorization
   suite, and already the pattern for Phase 2's database tests.
3. **Mocked-external-dependency tests** (Batch B, new) — `plan.integration.test.ts`
   still runs against the real database (real `Plan`/`Task`/`Requirement`
   documents, real ownership checks) but mocks the AI provider
   (`vi.mock("../../services/ai/index.js")`) rather than requiring a
   running Ollama instance. This is a deliberate, narrow exception to "test
   against the real thing" — MongoDB is a dependency this project controls
   and runs reliably; a third-party LLM server is not, and the AI
   provider's own correctness isn't what these tests check (`plan.service.ts`'s
   handling of what it returns is). See ADR-012.

Every integration test file gated on database availability uses the same
pattern: attempt a real connection at module load (top-level `await`),
`describe.skipIf(!available)` the real suite, `describe.skipIf(available)`
a one-line placeholder that fails loudly if skipped for the wrong reason.
This means `npm test` passes cleanly with **or** without Docker running,
but silently skipping isn't possible when the database genuinely is
available — the suite always runs for real for anyone with `npm run db:up`
going.

## Commands

```bash
npm test                          # both workspaces
npm run test --workspace apps/api  # backend only
npm run test --workspace apps/web  # frontend only
```

## Backend Coverage (Phase 3)

| Area               | File                                            | What's covered                                                                                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password hashing   | `utils/__tests__/password.test.ts`              | Real bcrypt hash/verify round-trip, wrong password rejected, salted (same password → different hashes).                                                                                                                                                                                             |
| JWT                | `utils/__tests__/jwt.test.ts`                   | Valid round-trip, malformed token, wrong signature, **genuinely expired token** (crafted `exp` in the past), never leaks `jsonwebtoken`'s internal error type.                                                                                                                                      |
| Auth flow          | `routes/__tests__/auth.integration.test.ts`     | Registration (success, duplicate email → 409, DB unique index authoritative, validation errors), login (success, wrong password, nonexistent email — same generic message), `/me` (401 missing/malformed/expired token, 200 valid session), logout (cookie cleared). All against the real database. |
| Project ownership  | `routes/__tests__/project.integration.test.ts`  | Owner CRUD success; cross-user read/update/delete all return 404 (not 403); fabricated well-formed ID → 404; malformed ID → 400; every operation unauthenticated → 401; confirms a rejected cross-user write did **not** actually modify the resource.                                              |
| Schema validation  | `models/__tests__/{User,Project}.test.ts`       | Required fields, format/enum/length rules, defaults — no DB needed.                                                                                                                                                                                                                                 |
| Database lifecycle | `config/__tests__/database.integration.test.ts` | Real connect, readiness endpoint 200→503→200 across a live disconnect/reconnect.                                                                                                                                                                                                                    |
| Health             | `routes/__tests__/health.test.ts`               | Liveness endpoint shape, 404 fallback.                                                                                                                                                                                                                                                              |

Current count (Phase 3): 48 passed, 3 skipped.

## Backend Coverage (Batch A additions)

| Area                          | File                                                                                                                      | What's covered                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirement schema            | `models/__tests__/Requirement.test.ts`                                                                                    | Required fields, enum/default rules — no DB needed.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Task schema                   | `models/__tests__/Task.test.ts`                                                                                           | Required fields, status/priority enum rules, subtask (`parentTask`) shape.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Requirements CRUD & ownership | `routes/__tests__/requirement.integration.test.ts`                                                                        | Full CRUD against the real database; create/list rejected (404) under a project the caller doesn't own; validation errors; cross-user read/update/delete all 404, confirmed the resource is unchanged; malformed id → 400, well-formed-missing → 404.                                                                                                                                                                                                                               |
| Tasks, subtasks & references  | `routes/__tests__/task.integration.test.ts`                                                                               | Full CRUD; a requirement/parentTask reference from a _different_ project is rejected (400); self-parenting rejected (400); an unowned/nonexistent reference is rejected (400); `parentTaskId=none`/`=<id>` filtering; `status`/`priority` filtering; cross-user denial (404) on read/update/delete with confirmation the task was unchanged; deleting a parent cascades to its subtask (both become 404); deleting a requirement clears (not deletes) the tasks that referenced it. |
| `parentTask` cycle prevention | `routes/__tests__/task.integration.test.ts`'s `"parentTask cycle prevention"` block (focused corrective pass, 2026-09-23) | Valid parent assignment; direct self-parenting rejected; 2-hop, 3-hop, and 4-hop cycles all rejected (`400`, unchanged data confirmed); valid re-parenting across branches of the same tree succeeds; a valid 5-node acyclic chain re-parented within itself is **not** falsely rejected; cross-project and cross-user reference checks confirmed still intact alongside the new cycle check.                                                                                       |

Current count (Batch A + corrective pass): **91 passed, 5 skipped** total
for `apps/api`.

**A genuinely flaky test, found and fixed during this batch's verification**:
`testHelpers.ts`'s `uniqueEmail()` combined a per-process counter with
`Date.now()`. Vitest runs different test _files_ in separate worker
processes, each with its own counter starting at 0 — two files registering
their first test user in the same millisecond could generate the identical
email string, and the second registration would fail with a 409 the test
wasn't expecting, surfacing as a `registerTestUser failed` error unrelated
to whatever that test was actually checking. Reproduced (passed in
isolation, failed intermittently in the full suite — a real tell for
cross-process collision, not a logic bug), then fixed by switching to
`crypto.randomUUID()`, which has no shared counter to collide on. Verified
by running the full backend suite three consecutive times after the fix
with 0 failures (a single clean run isn't conclusive for something
intermittent).

## Backend Coverage (Batch B additions)

| Area                                  | File                                             | What's covered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency graph engine               | `lib/__tests__/dependencyGraph.test.ts`          | Empty graph, single task, linear/branching/merging dependencies, independent tasks, duplicate edge, self-dependency, two-node and multi-node cycles, missing node reference, topological ordering (including deterministic tie-breaking), ready/blocked tasks at various completion states. 20 tests, no DB needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| AI plan structured-output validation  | `validators/__tests__/aiPlan.validators.test.ts` | Well-formed plan accepted with a computed topological order; malformed/non-object input, missing required fields, empty task list, invalid enum value, duplicate tempIds, self-dependency, missing-reference dependency, cyclic dependency, and over-the-task-cap plans all rejected. 12 tests, no DB or AI provider needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| AI plan generation, review & approval | `routes/__tests__/plan.integration.test.ts`      | Against the real database, AI provider mocked (see ADR-012): unauthenticated/cross-project/invalid-requirement rejection; provider-unavailable (503) and timeout (503) with nothing persisted; malformed JSON response (502); structurally invalid (422) and cyclic (422) AI output, both confirmed to persist nothing; successful generation persisted as `needs_review` with a computed order; plan listing; cross-user denial (404) on read/edit/approve/reject; editing `suggestedTasks` while `needs_review` re-validates the graph (a self-cycle edit is rejected); approval materializes real `Task`s with correctly resolved `dependencies` and flips status; an already-reviewed plan can't be approved/rejected/edited again (409); rejection creates no tasks; **project deletion cascades to its plans** (a real bug found during this batch's own review — see `docs/IMPLEMENTATION_LOG.md`). |

Current count (Batch B additions): **52 passed, 1 skipped** (20 + 12 + 20,
plus one `describe.skipIf` placeholder in `plan.integration.test.ts`) across
`apps/api`, bringing the backend total after Batch B to **143 passed, 6 skipped**.

## Backend Coverage (Batch C1 additions — filesystem safety & scanner)

| Area                                                         | File                                               | What's covered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem boundary safety                                   | `lib/__tests__/fsSafety.test.ts`                   | Valid root, relative-path resolution, empty path, nonexistent path, file-given-for-directory, UNC path (both `\\` and `//` forms, rejected without any filesystem call), empty directory as root; `isPathInsideRoot`'s nested/root/similarly-prefixed-sibling (`App` vs `App-Outside`)/`..`-traversal/cross-drive/redundant-separator cases — the exact boundary-check scenarios the batch's spec called out; a real directory junction created on disk and confirmed detected via `lstat().isSymbolicLink()`; `revalidateScanRoot`'s scan-time re-check (unchanged directory accepted, deleted path rejected, file-instead-of-directory rejected, and — the real fix this covers — **a directory replaced by a junction since configuration is rejected, not silently followed**). 21 tests, no DB needed. 1 test (`file symlink pointing outside root`) is conditionally skipped — see "A capability that couldn't be assumed" below.                                                                                                                                                                     |
| Scanner (classification, ignore policy, limits, determinism) | `services/__tests__/scanner.test.ts`               | Deterministic output across repeated runs on the same fixture; forward-slash relative paths; classification by category/language across documentation/configuration/source/test/asset/binary files; `node_modules`/`.git` ignored **and never descended into**; empty directory recorded as scanned; `completed` vs `completed_with_warnings` outcome; a genuinely empty root; **no fixture file modified** (byte-identical content and mtime before/after); **all five configured limits individually enforced and confirmed** — `maxFileSizeBytes` (and confirmed _not_ added to `limitsReached`, since it doesn't stop the scan), `maxFiles`, `maxDepth`, `maxDirectories`, and `maxDurationMs` (using `-1` to trip the cooperative check deterministically on the first loop iteration, not a timing-dependent guess); a **real** failed scan (root directory actually deleted before the read, not mocked); a directory junction pointing outside the fixture root skipped and never descended into. 16 tests, no DB needed. 1 test (file-symlink policy) conditionally skipped, same reason as above. |
| Mid-traversal error handling (deterministic `node:fs` mocks) | `services/__tests__/scanner.errorHandling.test.ts` | Added in a targeted Batch C1 verification pass, per the explicit instruction not to rely only on a whole-root failure test. Mocks `node:fs`'s `promises.lstat`/`readdir` to fail for one specific injected path while every other call goes through the real filesystem: a file's `lstat` failing mid-traversal (siblings still scanned, safe generic error message, no raw path/error text leaked); a nested directory's `readdir` failing (siblings still scanned, **exactly one** item recorded for the failed directory — not a duplicate "scanned" + "error" pair, a real bug this test caught and fixed, see below); confirms a scan containing only such errors is never reported as a clean `"completed"` outcome. 4 tests, no DB needed, none skipped.                                                                                                                                                                                                                                                                                                                                             |
| Source config & scan API                                     | `routes/__tests__/scan.integration.test.ts`        | Against the real database and a real temp-directory fixture: unauthenticated (401) and cross-user (404) rejection on every route; empty/nonexistent/UNC/file-not-directory source paths all rejected (400); a valid source saved and retrieved with **the raw absolute path asserted absent from the response body**; starting a scan with no source configured (400); a full scan run end-to-end returning real inventory items; retrieving the latest scan; cross-user denial on scan retrieval/start; **the configured directory being replaced by a junction after configuration is rejected (400) at scan time, end-to-end through the real API** — the same root-substitution fix verified at the unit level in `fsSafety.test.ts`, proven here through the actual HTTP request path. 17 tests, all passing, none skipped.                                                                                                                                                                                                                                                                            |

Current count (Batch C1 additions, including its targeted verification
pass): **58 passed, 2 skipped** (21 + 16 + 4 + 17) across `apps/api`,
bringing the full backend total to **201 passed, 8 skipped** (verified
via a single consolidated `npm run test` run — see
`docs/IMPLEMENTATION_LOG.md`).

**A capability that couldn't be assumed, so it was probed instead of
faked**: creating a _file_ symlink on Windows requires Administrator
privileges or Developer Mode; creating a directory _junction_ does not
(a genuinely different NTFS feature). Both test files probe this for real
in a `beforeAll` (attempt to create a file symlink, catch the failure) and
use `it.skipIf(!canCreateFileSymlinks)` for the one test that needs it,
rather than assuming the environment can do it or mocking around the
limitation. On this development machine, that one test is skipped; the
junction-based symlink-escape test (which needs no elevated privilege)
always runs and passed. This is a real, stated environment limitation —
not a gap in what the _code_ does, only in what this specific test run
could verify.

## Backend Coverage (Batch C2 additions — import extraction & resolution)

| Area                                           | File                                            | What's covered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import extraction (pure, no DB, no filesystem) | `lib/__tests__/importExtraction.test.ts`        | Default/named/namespace ES imports, export-from, CommonJS `require`, static dynamic `import()`, a non-literal dynamic-import/require argument recorded as a safe truncated snippet (not evaluated, not treated as resolvable), multiple imports in source order, a module imported twice recorded as two separate call sites (no dedup at this layer), JS/JSX/TS/TSX all parsed correctly via their respective `ts.ScriptKind`, a genuinely malformed file reported as `parse_error` with nothing extracted, and correct 1-based line/column for a non-trivial position. 18 tests, none skipped.                                                                                                                                                                                                                                                                                    |
| Module resolution (pure, no DB, no filesystem) | `lib/__tests__/importResolution.test.ts`        | Every case from the batch's own required test list: extensionless/explicit-extension/parent-directory/index-file relative resolution; a genuinely missing target and a directory with no index both reported `unresolved`; **determinism proven directly** — the same ambiguous-looking inventory (both `.ts` and `.js`, or an extensionless file alongside `.ts`) resolves identically on repeat calls, always via the documented priority order; bare and scoped external packages always `external`, never a local edge even when a same-named file exists; `@/`/`~/`/absolute imports always `unsupported`; a path-traversal attempt that climbs above the scan root rejected outright (no `resolvedRelativePath` returned); an explicit non-JS/TS extension (`.svg`, `.json`) always `unsupported`, even when that exact file exists in the inventory. 18 tests, none skipped. |
| Analysis API (real DB + real fixture files)    | `routes/__tests__/analysis.integration.test.ts` | Unauthenticated (401) and cross-user (404) rejection on every route; the new `GET /api/scans/:id` (invalid id → 400); analyzing a scan whose own `outcome` is `"failed"` rejected (400) rather than silently "succeeding" with zero relationships; a full end-to-end run against real fixture files exercising **every** relationship status in one pass (`confirmed` via a real relative import, `external` via `react`, `unsupported` via a `.css` import and an `@/` alias, `unresolved` via a missing target, `parse_error` via a genuinely malformed file) with the raw absolute fixture path asserted absent from the response; retrieving the latest analysis. 11 tests, all passing, none skipped.                                                                                                                                                                          |

Current count (Batch C2 additions): **47 passed** (18 + 18 + 11) across
`apps/api`, bringing the full backend total to **248 passed, 8 skipped**
(verified via a single consolidated `npm run test` run — see
`docs/IMPLEMENTATION_LOG.md`).

**`SourceFile.parseDiagnostics` was verified empirically before being
relied on**, since it isn't part of TypeScript's published public
`.d.ts`: a quick manual check confirmed it returns `0` for valid code and
a positive count for genuinely malformed input, on the exact TypeScript
version this project pins. `lib/importExtraction.ts` accesses it
defensively (a type-safe cast with a documented fail-open fallback if the
field is ever absent or a different shape) rather than assuming it will
always be there across future TypeScript versions.

## Backend Coverage (Batch C3 additions — canonical dependency graph)

| Area                                      | File                                          | What's covered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph engine (pure, no DB, no filesystem) | `lib/__tests__/sourceDependencyGraph.test.ts` | Every case from the batch's own required matrix, verified with exact values (not "an array exists"): empty/isolated/two-node/multi-component/multi-edge/multi-importer basic shapes; missing-importer and missing-target rejected rather than inventing a node; **cross-scan contamination rejected** (a relationship whose paths don't belong to the given inventory); an absolute-Windows-path-looking id handled as an inert opaque string (no fs interpretation); backslash separators normalized; duplicate inventory entries deduped (first wins); non-supported-language files excluded from the node set; confirmed/unresolved/external/unsupported/parse_error relationships each verified to (not) produce a confirmed edge; duplicate `(from,to)` relationships merged into one edge with **all evidence preserved**; distinct targets with the same raw text kept as distinct edges; stable `from::to` edge ids; self-cycle, 2-node, 3-node, 5-node, and multiple-independent cycles all detected, **with no false positive** on an unrelated acyclic component in the same graph, and identical cycle output regardless of shuffled relationship order; topological order verified as dependency-first (leaves before importers) on linear/branching/merging/disconnected graphs, with documented sorted tie-breaking, and `null` returned (not a misleading partial order) for a cyclic graph; root/leaf node identification; direct dependency/dependent lookups; structural readiness/blockedness against an arbitrary caller-supplied "completed" set (unknown ids ignored, the set never mutated, a cyclic pair never marked ready on its own); one full-graph determinism test proving identical `nodes`/`edges`/`cycles`/`validationErrors` regardless of both inventory and relationship input order; and a purity test that mocks `node:fs` to throw on any call and confirms the engine still completes successfully. 46 tests, none skipped. |
| Graph API (real DB + real fixture files)  | `routes/__tests__/graph.integration.test.ts`  | Unauthenticated (401) and cross-user (404) rejection; `404` when a scan exists and is owned but has no analysis yet (a real, deliberately-triggered case — not just asserted in isolation); invalid scan id (400); a full end-to-end run against a real fixture (`a→b→c` chain, an `x↔y` cycle, an external `react` import) confirming the response contains the right nodes, the right edge with its evidence, `react` correctly excluded from `edges`, the cycle detected with `topologicalOrder: null`, `src/c.ts` correctly identified as a leaf, and the raw absolute fixture path absent from the entire response body; a determinism test confirming two consecutive requests return identical `nodes`/`edges`/`cycles`. 6 tests, all passing, none skipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Current count (Batch C3 additions): **52 passed** (46 + 6) across
`apps/api`, bringing the full backend total to **300 passed, 8 skipped**
(verified via a single consolidated `npm run test` run — see
`docs/IMPLEMENTATION_LOG.md`).

**A genuinely clean implementation** — every one of the 52 new tests
passed on its first run; no bug was found by a failing test in this
batch, unlike Batch C1 and its own corrective pass. The design decision
that most likely explains this: reusing Batch B's already-tested cycle
detection/topological sort (`lib/dependencyGraph.ts`) instead of writing
a third implementation of the same algorithms.

## Frontend Coverage (Phase 3)

Vitest + `jsdom` + React Testing Library, configured in
`apps/web/vitest.config.ts`. `authService` is mocked (`vi.mock`) for these
component tests — the real network/DB path is already covered by the
backend integration tests above; these test the React layer in isolation.

| Area              | File                                              | What's covered                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration form | `components/auth/__tests__/RegisterForm.test.tsx` | Empty-submission validation errors (no API call made), malformed-email error, password-too-short error, server-side failure (duplicate email) rendered, successful submission calls the service with the right payload. |
| Login form        | `components/auth/__tests__/LoginForm.test.tsx`    | Empty-submission validation, malformed email, invalid-credentials failure state, successful login state, **loading state** (submit button shows "Logging in…" and is disabled while the request is in flight).          |
| App auth gate     | `__tests__/App.test.tsx`                          | Loading state before the initial session check resolves, unauthenticated → auth page only (protected content absent), authenticated → protected dashboard only (auth forms absent), logout → returns to the auth page.  |

Current count (Phase 3): 14 passed. `App.test.tsx` was substantially
rewritten in Batch A (real `<BrowserRouter>`/`<Routes>` via
`react-router-dom`'s `MemoryRouter` + `QueryClientProvider`, since `App.tsx`
now does real routing) — still covers the same behaviors (loading, gate
redirect, logout) plus route-specific ones: unauthenticated visits to a
protected URL redirect to `/login`, an authenticated visit to `/login`
redirects to the dashboard, and an unknown route renders `NotFoundPage`.

## Frontend Coverage (Batch A additions)

Mocks the relevant `*Service` module per test file — these test the React
layer (forms, lists, filters, dialogs), not the network path, which the
backend integration tests above already cover against the real database.

| Area             | File                                                      | What's covered                                                                                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects list    | `pages/__tests__/ProjectsPage.test.tsx`                   | Loading state, empty state, real API data rendered (name + status badge), error state with the actual error message shown.                                                                                                                                                  |
| Project creation | `pages/__tests__/NewProjectPage.test.tsx`                 | Validation (empty name blocks submit, no API call), successful creation navigates to the new project's detail route, a server-side failure shows the error and does **not** navigate.                                                                                       |
| Requirements tab | `pages/project/__tests__/ProjectRequirementsTab.test.tsx` | Empty state, list rendering (status/priority badges, acceptance-criteria count), create-form validation, successful creation. Rendered inside the real nested route (`ProjectDetailLayout`'s `Outlet` context), not a mocked context — exercises the actual routing wiring. |
| Tasks tab        | `pages/project/__tests__/ProjectTasksTab.test.tsx`        | Empty state, a top-level task rendered with its subtask nested under it, **inline status-control quick-change** (calls the update mutation with just the changed field), create-form validation and successful creation.                                                    |

Current count (Batch A additions): **18 passed** (7 in `App.test.tsx` +
11 across the four files above) — **32 passed** total for `apps/web`.

**A real bug in the frontend, found while writing these tests**: two tests
initially failed with "found multiple elements with role button" for "New
Requirement"/"New Task" — not a test-setup mistake, but two buttons with
the _same accessible name_ genuinely on screen at once (the page header's
persistent action button, and the empty state's own call-to-action button
with identical text). This is legitimate, common UI (not a bug to fix in
the component), so the tests were adjusted to disambiguate
(`getAllByRole(...)[0]`) rather than changing the UI to avoid the
collision.

## Frontend Coverage (Batch B additions)

Mocks `planService` (and reuses mocked `projectService`/`requirementService`).

| Area                 | File                                               | What's covered                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI planning workflow | `pages/project/__tests__/ProjectPlansTab.test.tsx` | **Provider-unavailable state** (warning banner shown, "Generate Plan" disabled); empty state with no plans; a generation failure surfaces the API's error message; listing an existing plan, opening its review dialog, and **approving** it (calls the approve endpoint with the right id); **rejecting** a plan under review. 5 tests. |

Current count (Batch B additions): **5 passed**, bringing the frontend
total after Batch B to **37 passed**.

## Frontend Coverage (Batch C1 additions)

Mocks `scanService` (and reuses mocked `projectService`).

| Area                      | File                                              | What's covered                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project scanning workflow | `pages/project/__tests__/ProjectScanTab.test.tsx` | Not-configured state (raw path never rendered); configured state shows only the safe `label`; saving a new source directory calls the API with the typed path; running a scan and rendering the `completed` outcome with real inventory rows; `completed_with_warnings` outcome with its limits-reached list shown; `failed` outcome with its safe error message shown; empty-inventory message when a scan recorded zero items. 7 tests, all passing. |

Current count (Batch C1 additions): **7 passed**, bringing the frontend
total after Batch C1 to **44 passed**.

## Frontend Coverage (Batch C4 additions — dependency graph visualization)

Mocks `scanService`/`graphService` (and reuses mocked `projectService`).

| Area                           | File                                               | What's covered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency graph visualization | `pages/project/__tests__/ProjectGraphTab.test.tsx` | Loading state before scan/graph data resolves; "no scan yet" state; missing-analysis (404) state that offers a "Run Analysis" button **and asserts analysis was never called automatically**; clicking that button actually calls the API; a safe generic message on a non-404 failure (not exposed as the missing-analysis state); empty-graph state when analysis found no confirmed dependencies; nodes/edges rendered with **verified importer→imported direction** via the SVG's own accessible label (`"src/a.ts imports src/b.ts"`), with the full response body asserted to contain no Windows/POSIX absolute path; selecting a node shows its exact dependency/dependent counts in the details panel; selecting a merged edge shows **both** underlying evidence records, not just a count; a cycle's summary count and its exact ordered path text; a validation-error warning banner stating the graph "may be incomplete"; all four diagnostic categories (unresolved/external/unsupported/parse-error) expandable with their real content; a confirmed-edges assertion that `react` (external) never appears as a graph edge; identical rendered node set when the backend's arrays are reversed; the SVG's own `role="img"` accessible summary containing the real file/edge counts. 15 tests, all passing, none skipped. |

Current count (Batch C4 additions): **15 passed**, bringing the full
frontend total to **59 passed** (verified via a single consolidated
`npm run test --workspace apps/web` run — see
`docs/IMPLEMENTATION_LOG.md`). Backend was not touched this batch, so its
suite was not re-run (still 300 passed/8 skipped from Batch C3).

**A real test-fixture ambiguity, found and fixed while writing these
tests, not a component bug**: `screen.getByText("src/a.ts")` initially
matched **two** elements — a per-node `<title>` element inside the SVG
(redundant with that node's own `aria-label`, which already stated the
full path) and the accessible Files table row. Fixed by removing the
redundant `<title>` (the `aria-label` alone is sufficient for
accessibility — see ADR-017). Separately, a regex assertion
`/depends on/i` matched **both** the intended "Depends on (1)" details-
panel heading and an unrelated caption sentence ("files nothing depends
on are placed first") — fixed by tightening the test's own regex, not by
changing the caption text (the caption's wording was correct and
worth keeping).

## A Real Bug Caught By Actually Running The Tests

Two routing/build bugs were found and fixed during Phase 2/3 verification
specifically _because_ the full check sequence (typecheck → lint → test →
build → manual verification) was run for real rather than assumed:

- Phase 2: production build compiling test files into `dist/`, doubling
  every test count (`docs/IMPLEMENTATION_LOG.md`).
- Phase 3: an unscoped `projectRouter.use(requireAuth)` intercepting
  _every_ request reaching the API router, including unmatched routes —
  caught because `health.test.ts`'s existing 404 test started failing with
  401 instead once the project router was added. Fixed by mounting each
  router at an explicit path prefix. See `docs/IMPLEMENTATION_LOG.md`
  Phase 3 entry and `docs/DECISIONS.md`.
- Batch B: `approvePlanForOwner`'s returned `createdTasks` held the
  in-memory `Task` documents from _before_ the second pass wrote
  `dependencies` to the database — so the API response silently showed
  `dependencies: []` even though the correct value was persisted
  correctly. Caught by a test asserting the actual response shape, not
  just the database state. Fixed by re-fetching the created tasks after
  both passes complete. See `docs/IMPLEMENTATION_LOG.md`.
- Batch B: `deleteProjectForOwner`'s cascade delete covered `Requirement`
  and `Task` but not `Plan` — deleting a project would have left orphaned
  `Plan` documents referencing a nonexistent project. Caught during this
  batch's own consolidated review (not by an initially-failing test — the
  gap was noticed by inspection, then a test was added to guard it). Fixed
  in `project.service.ts`; see `docs/DATABASE_DESIGN.md`.

Also caught: two of this phase's own frontend tests initially failed
because the test assertions were wrong (expected Zod's `.email()` message
on an empty string, when `.min(1)` fires first in the chain) — fixed by
correcting the test, not the (correct) implementation. Recorded here as an
example of verifying a failure's actual cause before "fixing" anything.

## Manual Verification — Phase 3

Beyond the automated suite, the full flow was exercised directly against a
running dev server with `curl` (see `docs/IMPLEMENTATION_LOG.md` for the
full transcript): register two real users, confirm password hash storage
and the httpOnly/SameSite/Max-Age cookie attributes, confirm cross-user
project access denial and that a rejected write didn't modify data, confirm
login failure/success and logout, confirm the exact CORS-preflight +
credentialed-request cycle a browser would perform, and grepped the server
logs to confirm no cookie/token/password value ever appears unredacted.

## Manual Verification — Batch A

Against the real running system (`npm run db:up` + both dev servers), via
`curl`: registered a user, created a project, a requirement, a top-level
task linked to that requirement, and a subtask; confirmed `?parentTaskId=none`
and `?parentTaskId=<id>` filtering return the correct sets; registered a
second user and confirmed 404 on reading the first user's requirement/task
and on creating a task under the first user's project; created a second
project and confirmed linking its task to the first project's requirement
is rejected (400, cross-project); deleted the project and confirmed both
the requirement and the task were actually gone (cascade delete, not just
a 204 response); grepped logs for leaked secrets (none found); attempted
the Claude-in-Chrome browser check (not connected — same as every prior
phase) and fell back to the same proxy verification used before: confirmed
the Vite dev server serves the new routed pages' source, and simulated the
exact CORS-preflight + credentialed-request cycle a browser would perform
for a protected route. All test data was deleted afterward and both dev
servers stopped. **Not verified**: actual on-screen rendering of the new
UI (forms, dialogs, the task tree, responsive layout) in a real browser —
covered instead by the React Testing Library suite above plus this
curl-based verification of the underlying HTTP contract.

## Manual Verification — Batch B

Consolidated verification pass run once at the end of the batch (not
repeatedly during implementation), against the real running system:
`npm run typecheck` (both workspaces, clean), `npm run lint` (0 errors, 1
pre-existing unrelated warning in a test helper), `npm run format:check`
(13 newly-added Batch B files were unformatted — fixed with
`prettier --write` and re-verified clean), `npm run test` (one combined
run: 143 passed/6 skipped backend, 37 passed frontend), `npm run build`
(both apps, clean). Confirmed MongoDB (`devflow-mongo`) was healthy before
running. Confirmed all pre-existing functionality (auth, project/
requirement/task/subtask CRUD, `parentTask` cycle protection, ownership
checks) is still covered and passing within that same combined test run —
no regressions. Reviewed the full staged `git diff` for hardcoded secrets
(none found; test fixture passwords/emails are the only "password"-shaped
matches). Found and removed one real issue during this pass: `AI_MAX_RETRIES`
was declared in `env.ts`'s schema and `.env.example`/`.env` but never
actually read anywhere — no retry logic exists in `OllamaProvider`. Removed
the dead config rather than adding unrequested retry behavior, since retries
weren't part of this batch's scope; re-verified typecheck and the full test
suite afterward with identical pass counts. Confirmed `.env` is gitignored
and was never staged. Confirmed the frontend never imports or references
Ollama/the AI provider directly (only the AI status API response, which
returns provider/model names, not connection details).

## Known Untested Areas

- No E2E browser test (Playwright is Phase 10 per the roadmap).
- The Phase 3 UI's actual on-screen rendering wasn't visually confirmed in
  a real browser — the Claude-in-Chrome extension wasn't connected in this
  environment (same caveat as Phases 1–2). Verified instead via RTL
  component tests plus the manual curl-based CORS/cookie simulation.
- No load/concurrency testing of the registration race-condition handling
  (the unique-index approach is architecturally race-safe, but no test
  fires concurrent duplicate registrations to prove it under real
  contention).
- Same visual-rendering caveat applies to the Batch A UI (dashboard,
  project list/detail, requirement/task forms and dialogs) — not visually
  confirmed in a real browser for the same reason.
- Responsive/mobile layout (the collapsible sidebar nav, the dialog on
  small viewports) has no automated test and wasn't manually verified at
  a real mobile viewport width — jsdom-based component tests don't exercise
  CSS media queries.
- Real OS-level `SIGTERM` graceful shutdown, per the Phase 1/2 caveat.
- Same visual-rendering caveat applies to Batch B's AI planning tab (the
  requirement picker, provider-unavailable banner, plan review dialog) —
  not visually confirmed in a real browser; covered instead by the RTL
  suite above.
- No real Ollama call is exercised by the automated suite (the AI provider
  is always mocked — see ADR-012); `OllamaProvider`'s actual HTTP behavior
  against a live Ollama instance is exercised only manually/ad hoc, not by
  an automated test.
- No dedicated test for `AI_REQUEST_TIMEOUT_MS`/Ollama-unreachable behavior
  under real network conditions (only the mocked `AIProviderError` paths
  are tested).
- File-symlink-escape detection is conditionally tested — this
  environment can create directory junctions but not file symlinks
  without elevated privileges, so that one case is skipped rather than
  faked (see the Batch C1 backend coverage section above for what was
  actually probed and why).
- No real UNC/network-share path was tested end-to-end (the rejection
  path is tested purely via string-pattern matching before any
  filesystem call is made — there's no real network share available in
  this environment to attempt a full round-trip against).
- Per-item read/permission errors mid-traversal ARE now tested (Batch
  C1 targeted verification pass) via deterministic `node:fs` mocking —
  `services/__tests__/scanner.errorHandling.test.ts` injects a real
  rejection for one specific path's `lstat`/`readdir` call while every
  other call goes through the real filesystem, and confirms traversal
  continues past the failure, records a safe diagnostic, and never
  reports a clean `"completed"` outcome. This is deliberately a mock of
  `node:fs` itself, not of the scanner's own logic — chosen over trying
  to induce a real race (unreliable) or leaving it untested (dishonest
  about a real code path). A genuine OS-level permission-denied error
  under real elevated-privilege conditions is still not covered — that
  would require an environment this one doesn't have.
- Reparse-point coverage is Windows-junction-specific, not exhaustive
  across every OS-specific reparse-point type (e.g. cloud-sync
  placeholder files) — see `docs/SECURITY.md`.
- The scan cooperative time limit (`SCAN_MAX_DURATION_MS`) is not tested
  against a genuinely slow filesystem — its check-between-entries logic
  is straightforward enough that this wasn't judged worth constructing an
  artificially slow fixture for.
- Same visual-rendering caveat applies to Batch C1's Scan tab — not
  visually confirmed in a real browser; covered instead by the RTL suite
  above.
- Python (or any language outside JS/JSX/TS/TSX) import extraction is not
  implemented, so there is nothing to test — see `docs/DECISIONS.md`
  ADR-015.
- Alias resolution (`@/`, `~/`, tsconfig `paths`) is not implemented;
  tests only confirm these are correctly classified `unsupported`, not
  that they resolve to anything.
- `node_modules` inspection is not implemented — external packages are
  always classified `external` without checking whether they're actually
  installed or what version.
- No test exercises the per-file `SCAN_MAX_FILE_SIZE_BYTES` re-check in
  `analysis.service.ts` against a file that grew between scanning and
  analysis (the guard exists and is straightforward — a `fs.stat` size
  comparison — but constructing that exact timing window wasn't judged
  worth a dedicated fixture).
- The canonical dependency graph (Batch C3) now exists and is
  cycle-detected/topologically-ordered, but there is no visualization —
  the graph is only ever consumed via `GET /api/scans/:id/graph`'s JSON.
- No test exercises the graph engine against a genuinely large graph
  (hundreds/thousands of nodes) for performance characteristics — the
  reused Batch B algorithms (DFS cycle detection, Kahn's-algorithm topo
  sort) are already known-good at that scale from the task-graph use
  case, so a dedicated large-fixture test wasn't judged necessary here.
- `getStructurallyReadyNodes`/`getStructurallyBlockedNodes` are tested
  directly at the library level but not exposed through the graph API in
  this batch — there's no task-execution/build state yet for a client to
  supply as the "completed" set.
- The graph visualization (Batch C4) **was** confirmed in a real browser
  via Playwright (a dedicated verification pass, not part of the RTL
  suite) against two real directories from this repository — see
  `docs/IMPLEMENTATION_LOG.md`'s "Batch C4 Real-Browser Verification"
  entry for what was exercised and the one real defect that pass found
  and fixed (edge-click hit-testing occluded by nodes in a dense grid).
  Not exercised even in that pass: a real cycle (neither scanned
  directory happened to contain one) — cycle rendering remains verified
  only via the RTL suite's fixture data.
- In a very dense graph (dozens of nodes, hundreds of edges with many
  crossing lines), the SVG's longest/most-central edges can still land on
  a contested pixel where multiple edges' click hit-areas overlap — a
  real, documented layout-density limitation (see ADR-017), not fixable
  without a proper edge-routing layout algorithm. The Confirmed
  Dependencies table remains a fully reliable alternative regardless of
  density, confirmed in the same browser pass.
- No test exercises the SVG canvas layout against a large (dozens+ of
  nodes) graph — the grid-wrapping layout math is simple enough
  (arithmetic only, no algorithm) that a dedicated large-fixture test
  wasn't judged necessary, but a genuinely large graph will still be
  visually dense (see known limitations).
