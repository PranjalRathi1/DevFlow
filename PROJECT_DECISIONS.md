# DevFlow AI — Project Decisions & Status

Living document. Updated at every meaningful checkpoint. This is the single
place to check "what's actually true right now" before assuming anything
about the codebase. Detailed ADR-style entries live in `docs/DECISIONS.md`;
this file is the quick-scan summary.

## Current Status (as of 2026-09-23)

**Product direction: local-first, single-user planning assistant** — see
`docs/PRODUCT_SCOPE_LOCAL.md` (canonical scope) and `docs/DECISIONS.md`
ADR-013 (what changed/stayed and why). This superseded the prior implicit
multi-user-SaaS framing; **no code behavior changed** in that pivot — see
the "Local-First Product Alignment" entry below.

**Batch B: AI planning + dependency graph foundation (complete)**

- Phases 0–3 (scaffolding, foundation, database, auth) and Batch A
  (Phases 4–6: frontend shell, workspace, requirements & tasks) done.
- Batch B done: a server-side `AIProvider` abstraction (Ollama today,
  never called from the frontend), a deterministic dependency graph engine
  (`apps/api/src/lib/dependencyGraph.ts` — validate, topological sort,
  ready/blocked lookups), a structured AI plan schema with full
  Zod + graph validation (an invalid plan is never persisted), a `Plan`
  model with a `needs_review → approved | rejected` lifecycle (no
  auto-approval, ever), and a frontend planning tab (requirement picker,
  provider-unavailable state, plan review dialog, approve/reject).
  `Task.dependencies` added and populated on approval, resolved from the
  AI's temporary task ids to real ObjectIds.
- Verified for real (mocked AI provider, real database — see ADR-012):
  every provider failure mode (unavailable/timeout/malformed/invalid
  schema/cyclic) rejected with nothing persisted; successful generation
  → review → approve materializes real tasks with correct dependencies;
  cross-user and cross-project checks intact on every new endpoint;
  project deletion cascades to plans too.
- Two real bugs found and fixed this batch: `approvePlanForOwner`
  returned stale pre-update `Task` documents (dependencies were persisted
  correctly but omitted from the API response) — fixed by re-fetching
  after both write passes; `deleteProjectForOwner`'s cascade covered
  `Requirement`/`Task` but not `Plan`, which would have orphaned plan rows
  — caught during this batch's own review, not by an initially-failing
  test, and fixed with a guarding test added.
- See `docs/IMPLEMENTATION_LOG.md` for the exact final test counts from
  this batch's consolidated verification pass.

**Local-First Product Alignment (complete)**

- Product direction redefined: local-first, single-user, import-and-
  analyze-a-real-codebase planning assistant — not a multi-user SaaS
  tracker. See `docs/PRODUCT_SCOPE_LOCAL.md` and ADR-013.
- Inspected auth/ownership, MongoDB, Batch B's AI/plan/graph code, and
  frontend routing against this direction. **Nothing was removed.**
  Authentication and ownership are retained (load-bearing, revisit later
  if ever proven to be pure friction); MongoDB is retained (already
  loopback-only, no cloud dependency to begin with).
- Reviewed the `Plan` schema for evidence-backed-planning readiness and
  documented the real gaps (no source-file references, no evidence/
  confidence fields, no confirmed/inferred/proposed distinction) — **no
  schema fields were added**, since none has a consumer yet; adding
  unconsumed fields would repeat the exact dead-config mistake
  (`AI_MAX_RETRIES`) just caught and fixed in Batch B's own verification.
- This pass changed documentation and product boundaries only — zero
  application code, schema, or test changes. Full suite re-run once to
  confirm (143 backend passed/6 skipped, 37 frontend passed — identical
  to Batch B's final numbers).
- Revised Batch C (project ingestion, read-only scanning, evidence-backed
  plans) is **not started** — explicitly out of scope for this pass.

**Batch C1: Secure filesystem boundary + read-only scanner (complete)**

- A project can now be associated with a real local directory
  (`PUT /api/projects/:projectId/source`) and scanned read-only
  (`POST /api/projects/:projectId/scans`), producing a deterministic,
  classified file inventory. See `docs/DECISIONS.md` ADR-014 and
  `docs/PRODUCT_SCOPE_LOCAL.md`.
- Filesystem safety (`lib/fsSafety.ts`): a real `path.relative`-based
  boundary check (not `startsWith`), UNC/device paths rejected, symlinks
  and directory junctions detected via `lstat` and never followed
  (verified empirically on this Windows environment that junctions are
  caught this way too).
- The scanner (`services/scanner.service.ts`) is read-only by omission —
  no write/delete/rename/exec call exists in that code path, verified by
  a test asserting fixture files are byte-identical before and after a
  scan. Bounded by configurable limits (`SCAN_MAX_FILES`, `SCAN_MAX_DEPTH`,
  `SCAN_MAX_DIRECTORIES`, `SCAN_MAX_DURATION_MS`, `SCAN_MAX_FILE_SIZE_BYTES`),
  checked cooperatively, not preemptively. Synchronous within one request
  — no background job system in this batch.
- `Project.sourceConfig.canonicalPath` is `select: false` plus stripped
  again by a `toJSON` transform (same double-guard as `User.passwordHash`)
  — every API response only ever carries the safe `label` (basename),
  verified by an integration test that greps the full response for the
  raw fixture path.
- New `Scan` model (persisted snapshot, same pattern as `Plan`), added to
  `deleteProjectForOwner`'s cascade from the start (learned from Batch B's
  `Plan`-cascade miss).
- New frontend tab (`ProjectScanTab.tsx`): source-directory form, "Run
  Scan" action, outcome badge, summary counts, limits-reached warning,
  bounded inventory table.
- Verified for real: 47 new backend tests (17 fsSafety + 14 scanner + 16
  API integration, real filesystem fixtures, real database) + 7 new
  frontend tests, bringing the full suite to **190 passed/8 skipped
  backend, 44 passed frontend**. One capability (file-symlink creation)
  is genuinely unavailable without elevated privileges on this machine —
  probed for real and conditionally skipped, not faked; the equivalent
  junction-based test always runs and passed.
- One real cleanup during this batch's own review: an env var
  (`AI_MAX_RETRIES`, unused since Batch B) was **not** touched here — that
  was already fixed in Batch B's verification; no new dead config was
  introduced this batch (`SCAN_MAX_*` vars are all actually read by
  `scan.service.ts`).
- Import extraction, dependency resolution from scanned files, and
  evidence-backed AI plan generation are **not implemented** — the
  scanner produces a file inventory only. See
  `docs/PRODUCT_SCOPE_LOCAL.md`.

**Batch C1 Targeted Security Verification and Corrections (complete)**

- A focused re-inspection of the shipped Batch C1 scanner found and fixed
  two real defects: (1) scan-time root re-validation called
  `resolveScanRoot` (which uses `fs.realpath`, always resolving symlinks)
  instead of a dedicated `lstat`-based check — meaning a directory
  replaced by a symlink after configuration would have been silently
  followed rather than rejected; fixed with a new `revalidateScanRoot`
  (`lib/fsSafety.ts`), verified with a real on-disk junction substitution
  both at the unit level and end-to-end through the live scan API. (2) A
  directory could be recorded twice in one scan (once `"scanned"`, then
  again `"error"` if `readdir` on it subsequently failed) — violating the
  scanner's own "no duplicate records" guarantee; caught by a new
  deterministically-mocked `readdir`-failure test, fixed by computing
  `readdir`/`sortEntries` before recording the directory's single item.
- Also hardened (found by re-reading the code, not a failing test): an
  uncaught `FsSafetyError` from `resolveSafeChild` inside the traversal
  loop could have crashed an entire scan with an unhandled exception
  (500) instead of being handled per the scanner's own stated policy —
  both call sites are now wrapped, folding into the existing
  failed-scan/per-directory-error outcomes.
- All 5 configured resource limits are now individually tested (`maxFiles`
  and `maxDepth` already were; `maxDirectories` and `maxDurationMs` were
  not — both now have dedicated deterministic tests).
- Verified clean, no correction needed: env var names/usage (all 5
  `SCAN_MAX_*` vars consistent across `env.ts`/`.env.example`/`.env`/
  `scan.service.ts`, none orphaned in either direction); traversal
  boundary (no naive `startsWith` path check anywhere, every child path
  goes through `resolveSafeChild`); read-only guarantee (grepped for any
  write/delete/rename/exec-shaped call across every scanner-related file
  — zero matches); `.env` still gitignored, no secrets in the diff.
- 11 new tests added (4 `revalidateScanRoot` + 2 resource-limit + 4
  mid-traversal-error + 1 end-to-end root-substitution), bringing the
  suite to **201 passed/8 skipped backend, 44 passed frontend** — see
  `docs/IMPLEMENTATION_LOG.md` for the full breakdown.
- Batch C2 (import extraction, dependency resolution, graph
  construction/visualization, AI integration) remains **not started** —
  out of scope for this pass, as instructed.

**Batch C2: Deterministic Import Extraction + Module Resolution (complete)**

- New pure modules: `lib/importExtraction.ts` (extracts imports/requires/
  export-from/dynamic-imports from JS/JSX/TS/TSX source text using
  TypeScript's own parser — `ts.createSourceFile`, no regex, no code
  execution) and `lib/importResolution.ts` (resolves relative imports
  against a scan's own recorded inventory — zero filesystem calls; bare
  packages always `external`, aliases always `unsupported`, path
  traversal always rejected). `typescript` moved from `devDependencies`
  to `dependencies` in `apps/api/package.json` since it's now used at
  runtime — no new dependency was added.
- New `Analysis` model + `analysis.service.ts` orchestrating both against
  a specific scan: reads each supported-language file's current content
  (through the same `resolveSafeChild`/`revalidateScanRoot` boundary
  scanning uses — no new filesystem access path), extracts, resolves
  against that scan's inventory, and persists a flat list of typed
  relationships (`confirmed`/`unresolved`/`external`/`unsupported`/
  `parse_error`), each with evidence (importer, raw import text, line/
  column, resolution method where applicable). No graph is built — this
  is raw evidence only, per the explicit scope boundary.
- New API: `GET /api/scans/:id` (a real gap-fill, needed as the mounting
  point — same dual-router pattern `plans` already uses),
  `POST`/`GET /api/scans/:id/analysis`. All ownership-enforced via
  `Scan`'s own denormalized `owner` field; analyzing a scan that itself
  failed is rejected (400); no client-supplied path is ever accepted.
- Verified for real: 47 new tests (18 extraction + 18 resolution, both
  pure/no DB/no filesystem + 11 real-database/real-fixture-file API
  integration tests exercising **every** relationship status in one
  end-to-end run), all passing on the first run, bringing the suite to
  **248 passed/8 skipped backend, 44 passed frontend**.
- Security review: zero write/delete/rename/exec-shaped calls anywhere
  in the new code (grepped); no new env var needed (`SCAN_MAX_FILE_SIZE_BYTES`
  reused for the per-file read-size guard); `.env` still gitignored, no
  secrets in the diff.
- Explicitly not implemented, per scope: Python (or any non-JS/TS)
  extraction, alias/tsconfig-paths resolution, `node_modules` inspection,
  a canonical dependency graph, graph visualization, any AI integration.

**Batch C3: Canonical Dependency Graph Engine (complete)**

- New pure module `lib/sourceDependencyGraph.ts` — deliberately not
  `lib/dependencyGraph.ts` (that name is Batch B's task-dependency graph
  engine). Inspection found that module's algorithms already fully
  generic over plain `string` node ids, so `sourceDependencyGraph.ts`
  **reuses its cycle detection, topological sort, and dependency/
  dependent lookups directly** rather than reimplementing them —
  converting to/from the shared `{nodes, edges}` shape at the boundary.
  Same edge-direction convention as Batch B, confirmed compatible during
  inspection: `{from: A, to: B}` = "A imports B" = "A depends on B."
- `buildDependencyGraph(inventoryFiles, relationships)`: a node's id IS
  its scan-relative path (never synthetic, never an absolute path, never
  array-index-derived); every confirmed relationship's importer and
  target are independently re-validated against the given inventory
  (never trusted from the relationship's own "confirmed" status) —
  rejecting cross-scan contamination outright rather than inventing a
  phantom node; duplicate `(importer, target)` pairs merge into one edge
  with every contributing relationship's evidence preserved (never
  dropped); unresolved/external/unsupported/parse-error relationships
  are kept in full, separate arrays, never merged into confirmed edges.
- New API: `GET /api/scans/:id/graph` — computed on demand from the
  scan's own inventory and its latest analysis, **no new persistence
  model** (the graph is a pure function of already-stored data, so a
  persisted copy would only risk staleness). 404 if no analysis has been
  run yet for that scan.
- Verified for real: 52 new tests (46 pure library tests covering every
  required case — basic shapes, node validation, edge construction,
  cycle detection including a determinism-under-shuffling proof,
  topological order semantics, structural analysis, and a purity test
  that mocks `node:fs` to throw and confirms the engine never touches it
  — + 6 real-database/real-fixture-file API tests including a genuine
  `a→b→c` chain and a genuine `x↔y` cycle), **all 52 passing on the first
  run** — no bug found by a failing test this batch, unlike Batch C1 and
  its own corrective pass. Suite now at **300 passed/8 skipped backend,
  44 passed frontend**.
- Security review: zero filesystem/exec calls anywhere in the new files
  (grepped); no new env var; `.env` still gitignored, no secrets in the
  diff.
- Explicitly not implemented, per scope: graph visualization, any AI
  integration, alias/`node_modules`/Python support (inherited limitations
  from Batch C2, not reintroduced or worked around).

**Batch C4: Dependency Graph Visualization (complete)**

- New frontend "Graph" tab (`ProjectGraphTab.tsx`, fifth project tab) —
  fetches `GET /api/scans/:id/graph` and renders it two ways at once: an
  always-present accessible structure (stat cards, a sortable Files
  table, a Confirmed Dependencies table with evidence counts, a Cycles
  list, a four-section collapsible Diagnostics panel) and a complementary
  SVG canvas (`DependencyGraphCanvas.tsx`) with click-to-select nodes/
  edges sharing one selection state with a Details panel.
- **No new frontend dependency** — `apps/web/package.json` unchanged.
  Considered `@xyflow/react`/Cytoscape/vis-network, rejected: they need a
  companion layout library anyway (the backend already provides
  `topologicalOrder`, which is layout input, not just useful data), and a
  canvas/graph library is typically hard to exercise meaningfully in
  `jsdom`. Layout is plain arithmetic (grid position from
  `topologicalOrder` index) — not a graph algorithm, verified by ADR-017.
- The frontend never re-derives graph semantics: cycle-edge highlighting
  reads consecutive pairs out of the backend's own `cycles` arrays;
  dependency/dependent lists in the Details panel filter the backend's
  own `edges` array. No parsing, resolution, or cycle detection happens
  in the browser.
- `POST /api/scans/:id/analysis` is only ever called from an explicit
  "Run Analysis" button click (missing-analysis state) — never
  automatically on page load, verified by a test asserting the mock was
  not called before the click.
- Non-confirmed relationships (`unresolved`/`external`/`unsupported`/
  `parse_error`) render only in the Diagnostics panel with their own
  status badges — never as a graph edge or a Confirmed Dependencies row;
  a validation-errors banner states the graph "may be incomplete" rather
  than implying full accuracy.
- Verified for real: 15 new tests, all passing after fixing two real
  test-fixture/component ambiguities found while writing them (a
  redundant SVG `<title>` duplicating a node's own `aria-label`, removed;
  an overly broad test regex that also matched an unrelated caption
  sentence, tightened) — see `docs/TESTING.md`. Frontend suite now at
  **59 passed** (backend untouched this batch, still 300 passed/8
  skipped).
- Security review: no `process.env`/secret/token references anywhere in
  the new frontend files (grepped); `.env` still gitignored, no secrets
  in the diff; the frontend never sees or requests a raw filesystem path
  — only the backend's already-sanitized relative-path JSON.
- Explicitly not implemented, per scope: any new backend contract change
  (the existing graph API already had everything needed), a graph
  algorithm of any kind in the frontend, AI integration, source-code
  navigation/editing.

## Environment Inspection Results

| Tool           | Status                                                | Notes                                                                                                                                                      |
| -------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js        | v24.19.0                                              | Available, modern                                                                                                                                          |
| npm            | 11.17.0                                               | Using npm workspaces (no pnpm installed; corepack is available if we want to switch later)                                                                 |
| Git            | 2.51.0                                                | Available, user identity already configured globally                                                                                                       |
| Docker Desktop | **Running** (verified via `docker info`, not assumed) | CLI + Compose v5.4.0. `docker-compose.yml` defines the `mongo` service.                                                                                    |
| MongoDB        | **Running in Docker**, `mongo:7`                      | `npm run db:up` / `db:down` / `db:logs` / `db:reset`. Bound to `127.0.0.1:27017` only. Healthy, authenticated connection verified directly with `mongosh`. |
| Ollama         | **Running**, v0.34.2                                  | Already serving on `localhost:11434` with model `qwen2.5:7b` pulled (4.7GB). This is a real, working local AI provider — not a stub.                       |

## Key Architecture Decisions (summary — see `docs/DECISIONS.md` for full ADRs)

1. **Package manager: npm workspaces**, not pnpm/yarn. pnpm isn't installed and
   corepack setup adds a step with no real benefit at this project's scale.
   npm 11 workspaces are sufficient for a 2-app + 1-package monorepo.
2. **Database: MongoDB via Docker Compose**, not a native local install.
   No mongod/mongosh present locally; Docker Desktop is already installed.
   User must start Docker Desktop before `docker compose up -d mongo`.
   `MONGODB_URI` is env-driven so swapping to Atlas later is a config change, not a code change.
3. **AI provider: Ollama with `qwen2.5:7b`**, accessed through an `AIProvider`
   interface so a hosted provider (Anthropic/OpenAI) can be added later without
   touching call sites. This is genuinely functional today — no mocked AI responses
   in production; only test suites mock it (ADR-012).
4. **Monorepo layout**: `apps/web` (React/Vite/TS), `apps/api` (Express/TS),
   `packages/shared` (still empty — the dependency graph engine lives in
   `apps/api/src/lib/` instead, per ADR-010, since there is no cross-package
   consumer yet).
5. **Testing: Vitest** across both apps (one test runner instead of
   Jest+Vitest split) + Supertest for API integration tests + React Testing
   Library for components. Playwright E2E deferred to Phase 10 per the phased plan.
6. **Do not implement Phase 9 (real-time/Socket.IO)** until the REST API and
   task system are stable, per the master spec's explicit fallback guidance.
7. **No repository abstraction layer over Mongoose models** — `models/`
   exports models directly; route/service handlers call them. Revisit only
   if query logic grows complex enough to justify it (ADR discussion
   criteria in `docs/DECISIONS.md`).
8. **`NODE_ENV` is never set in the shared root `.env`** (ADR-006) — it
   leaks into Vite's build and forces React into development mode, roughly
   doubling bundle size. Set it at the platform/process level instead.
9. **Auth token: single JWT in an httpOnly, SameSite=Lax cookie** (ADR-007)
   — not `localStorage`, not a full session store, no refresh token yet.
   Documented and decided _before_ implementation, as the phase required.
10. **Ownership checks return 404, never 403**, for a resource that exists
    but belongs to someone else — indistinguishable from nonexistent, to
    prevent ID enumeration by non-owners. Extended to `Requirement`/`Task`
    in Batch A via a denormalized `owner` field on each.
11. **Subtasks are separate `Task` documents with a `parentTask` reference**
    (ADR-008), not embedded subdocuments — chosen specifically for
    compatibility with Batch B's dependency-graph engine (every task,
    subtask or not, needs to be a uniform graph node).
12. **`react-router-dom` + `@tanstack/react-query` + one Radix primitive**
    (`Dialog`) added in Batch A (ADR-009) — no shadcn/ui, no Redux/Zustand,
    no shared enum package (`packages/shared` stays empty; enums are
    defined once per backend model file and re-declared as frontend TS
    types — a documented, deliberate trade-off, not an oversight).
13. **Dependency graph engine lives in `apps/api/src/lib/dependencyGraph.ts`**
    (ADR-010), not `packages/shared` — pure, framework-agnostic functions
    over `{nodes, edges}`, but the only current consumer is the API. Edge
    direction convention: `{from: "A", to: "B"}` means "A depends on B; B
    must complete before A is ready" — used identically by the AI plan
    schema's `dependsOn`, `Task.dependencies`, and every graph function.
14. **AI-generated plans are never auto-approved** (ADR-011) — a `Plan`
    document always starts `needs_review`; only an explicit human
    approve/reject transitions it, and approval is what materializes real
    `Task` documents (with `dependencies` resolved from the AI's temporary
    task ids to real ObjectIds). An already-reviewed plan is immutable.
15. **The AI provider is mocked in tests, unlike every other dependency**
    (ADR-012) — MongoDB is tested for real everywhere else, but a
    third-party LLM server isn't a dependency this project controls the
    way MongoDB is, so `plan.integration.test.ts` mocks `getAIProvider()`
    while still running against the real database.
16. **Authentication and ownership are retained, not removed, for the
    local-first pivot** (ADR-013) — "single-user" means one person per
    instance, not "no login"; every service/route queries via
    `{_id, owner}`, so removing auth would touch the entire codebase for
    no product benefit. MongoDB is also retained — it was already
    loopback-only, so nothing about "local-first" required a different
    database.
17. **No `Plan`/`Project` schema fields added for evidence-backed
    planning yet** (ADR-013) — the real gaps (source-file references,
    evidence/confidence, confirmed/inferred/proposed) are documented but
    deliberately not implemented until a real consumer (the revised
    Batch C's ingestion/scanning work) exists, to avoid unconsumed "dead"
    fields.
18. **Filesystem boundary is application-level, not OS sandboxing**
    (ADR-014) — a real `path.relative`-based boundary check plus
    never-follow-a-symlink-during-traversal, but no chroot/container/
    restricted OS user. Scanning is synchronous (one request, no job
    queue) since the configured limits already bound worst-case request
    time and a job system has no demonstrated need yet.

## What Exists Right Now

```
DevFlow/
├── apps/web/            React + TS + Vite + Tailwind, React Router, TanStack Query,
│                         AuthContext, full workspace UI: dashboard, projects, requirements,
│                         tasks, AI planning tab (ProjectPlansTab), and now the project
│                         scanning tab (ProjectScanTab)
├── apps/api/             Express + TS: health, auth, projects, requirements, tasks, AI
│                         status, plans, and now source-config/scans — all owner-scoped,
│                         cross-project-reference-checked, cascade-deleting (incl. plans
│                         and scans). services/ai/ (AIProvider + Ollama impl),
│                         lib/dependencyGraph.ts (graph engine), lib/fsSafety.ts
│                         (path-boundary checks), lib/fileClassification.ts,
│                         services/scanner.service.ts (read-only traversal engine)
├── packages/shared/     still empty — no cross-package consumer yet (see ADR-010)
├── docker-compose.yml     MongoDB (mongo:7), named volume, loopback-only port
├── docs/                  PROJECT_OVERVIEW, DECISIONS (14 ADRs), ARCHITECTURE, DATABASE_DESIGN,
│                          SECURITY, API_DOCUMENTATION, TESTING, IMPLEMENTATION_LOG,
│                          AI_SYSTEM, DEPENDENCY_ENGINE, PRODUCT_SCOPE_LOCAL
├── package.json           npm workspaces root, lint/format/typecheck/build/test/db:* scripts
├── eslint.config.js, .prettierrc.json
├── .gitignore, .env, .env.example
└── PROJECT_DECISIONS.md  (this file)
```

Runnable: `npm run dev:api` and `npm run dev:web` both work; `npm run db:up`
starts MongoDB; `npm run build`, `npm run typecheck`, `npm run lint`,
`npm run test` all pass — 234 tests passing, 8 skipped (190 backend + 44
frontend), verified via one consolidated run — see
`docs/IMPLEMENTATION_LOG.md`. AI planning, the dependency graph engine,
and the read-only project scanner are all implemented and tested (AI
provider mocked in tests but genuinely functional against a local Ollama
instance for manual use; the scanner has no external dependency to mock —
it runs against real temp-directory fixtures in tests).

## Next Steps (in order)

1. Import extraction / dependency resolution from scanned source files,
   and evidence-backed AI plan generation that actually consumes the scan
   inventory — not started. See `docs/PRODUCT_SCOPE_LOCAL.md` for the
   full workflow and `docs/DECISIONS.md` ADR-013/ADR-014 for the
   schema-gap list this will need to close.
2. Continue per the phased plan in `docs/PROJECT_OVERVIEW.md`.
