# DevFlow AI — Project Overview

**Product direction (current)**: a local-first, single-user engineering
planning assistant — see `docs/PRODUCT_SCOPE_LOCAL.md` for the canonical
product scope and `docs/DECISIONS.md` ADR-013 for the architectural
decisions behind this direction. The sections below describe today's
implemented capability; PRODUCT_SCOPE_LOCAL.md is authoritative on what's
implemented versus deferred where the two might seem to overlap.

## Problem Statement

Engineering requirements are usually written vaguely ("implement auth",
"add payments", "improve API performance"). This leads to poorly scoped
work, missed dependencies between tasks, unclear execution order, and
risks discovered too late. DevFlow AI turns a high-level engineering
requirement into a structured, dependency-aware, reviewable implementation
plan — with the dependency logic and validation done by real code, not
just AI prose. The revised direction extends this: the plan should
eventually be grounded in a real, imported codebase (evidence-backed), not
only in the requirement text — see "Known Limitations" below for what
that requires that doesn't exist yet.

## Target Users

An individual developer working locally who wants to go from "I need to
build X" to an ordered, risk-aware task breakdown grounded in their actual
codebase — without hand-writing a project plan, trusting an unvalidated AI
wall of text, or running a hosted multi-user service. Not a team
collaboration tool.

## Core Differentiator

**Evidence-backed, dependency-aware AI engineering planning for an actual
codebase** is the target (see `docs/PRODUCT_SCOPE_LOCAL.md`). What's
implemented today is the dependency-aware half: the AI proposes tasks and
dependency edges from a natural-language requirement; a real graph engine
(not the LLM) validates those edges, detects cycles/self-dependencies, and
computes a topological order. The user reviews and explicitly approves
before anything is persisted as real project data — see
`docs/DEPENDENCY_ENGINE.md` and `docs/AI_SYSTEM.md`. The evidence-backed
half — grounding those proposals in a real, imported codebase rather than
requirement text alone — now has its foundation (Batch C1's secure,
read-only project scan produces a classified file inventory), but nothing
reads scanned files' contents, extracts imports, or feeds any of that into
plan generation yet; see ADR-013's schema-gap
list in `docs/DECISIONS.md`.

## AI's Role

AI (via Ollama, model `qwen2.5:7b`, locally hosted) analyzes a requirement
and proposes: title, summary, assumptions, risks, and a structured task
breakdown with dependencies. Output is validated (Zod schema + the
dependency graph engine) before it ever reaches the database — an invalid
plan is rejected and never saved. A saved plan is never auto-approved: it
starts `needs_review` and only becomes real `Task` data through an
explicit human approval. See `docs/AI_SYSTEM.md`.

## Technical Architecture

- **Frontend**: React + TypeScript + Vite + React Router + Tailwind (hand-built UI primitives + one Radix dialog) + TanStack Query + React Hook Form + Zod.
- **Backend**: Node.js + Express + TypeScript + Mongoose + Zod + JWT auth + Helmet + rate limiting.
- **Database**: MongoDB (via Docker Compose locally).
- **AI provider**: Ollama (local), behind an `AIProvider` interface so other providers can be added later without touching call sites.
- **Dependency graph engine**: hand-built, framework-agnostic, in `apps/api/src/lib/` (not `packages/shared` — see ADR-010). `packages/shared` stays reserved for when a real cross-package consumer exists.

Full detail in `docs/ARCHITECTURE.md`, `docs/DATABASE_DESIGN.md`,
`docs/AI_SYSTEM.md`, and `docs/DEPENDENCY_ENGINE.md`, kept in sync with
real code as phases land.

## Current Implementation Status

See `PROJECT_DECISIONS.md` at the repo root for the up-to-date status. As
of this writing: Phases 0–3, Batch A (Phases 4–6), Batch B (AI planning +
dependency graph foundation), a local-first product-alignment pass
(ADR-013), Batch C1 (secure filesystem boundary + read-only scanner,
ADR-014), Batch C2 (deterministic import extraction + module resolution,
ADR-015), Batch C3 (canonical dependency graph engine, ADR-016), and
Batch C4 (dependency graph visualization, ADR-017) are complete. The app
is a single-user (account-gated) engineering workspace — projects,
requirements, tasks with subtasks, AI-assisted plan generation with
human review, a project can be pointed at a real local directory and
scanned read-only into a classified file inventory, that inventory's
supported source files (JS/JSX/TS/TSX) analyzed for real import/require/
export-from/dynamic-import statements resolved against the scan's own
inventory, those resolved relationships turned into an actual,
cycle-detected, topologically-ordered dependency graph, and now that
graph has a dedicated frontend tab — a visual diagram plus an always-
present accessible table/list view, evidence inspection for every
confirmed dependency, and a diagnostics panel for everything that didn't
become one — all enforced end-to-end through a real, locally-hosted
MongoDB-backed API with ownership checks at every level. Nothing
AI-generated is ever auto-approved or auto-persisted without passing
independent, deterministic validation; nothing the scanner, analyzer, or
graph engine reads is ever written to, modified, or executed; no import
is ever "confirmed" without an explicit, tested resolution rule proving
it; and the frontend never re-derives graph semantics — it only renders
what the backend already computed. **Evidence-backed AI planning
grounded in the graph does not exist yet** — today's AI plans are still
grounded only in typed requirement text, not in any scanned/analyzed/
graphed source content. That is a future batch's scope; see
`docs/PRODUCT_SCOPE_LOCAL.md`.

## Known Limitations (current)

- Project import, read-only scanning, and deterministic import extraction
  - resolution now exist (Batch C1/C2), but there is still no dependency
    graph, no graph visualization, and no connection from any of this to
    AI plan generation. See `docs/PRODUCT_SCOPE_LOCAL.md`'s numbered
    workflow for exactly which steps are real versus deferred, and
    ADR-013/014/015 for the schema gaps this will require closing.
- Import extraction only supports JavaScript, JSX, TypeScript, and TSX —
  no Python or any other language. Resolution supports relative imports,
  tsconfig/jsconfig `paths`/`baseUrl` (with relative `extends`), package
  `#imports`, and local workspace packages (`exports` subset), all against
  the scan's own inventory. Other bare packages are external (never checked
  against `node_modules`); anything ambiguous or unsupported is labelled,
  not guessed. See `docs/DECISIONS.md` ADR-015 and ADR-028.
- The Batch C3 dependency graph is built entirely from Batch C2's
  confirmed relationships — it inherits every one of the limitations
  above (JS/TS/JSX/TSX only, no `node_modules`) rather than
  working around them. The graph itself is computed fresh on every
  request from the latest analysis, not persisted, so there's no
  separate "graph" data to go stale — but that also means there's no
  history of how the graph changed over time. See `docs/DECISIONS.md`
  ADR-016.
- The Batch C4 visualization renders exactly what the graph API returns,
  with no independent parsing/resolution/cycle-detection of its own — so
  it inherits every graph limitation above. Layout is a simple
  topological-order-driven grid (see `docs/DECISIONS.md` ADR-017), not an
  aesthetically optimized diagram — edges can visually cross for larger
  graphs. No graph-visualization library was added; pan is a scrollable
  container and zoom is button-driven (no drag/wheel gestures).
- The dependency graph tab requires the user to click "Run Analysis"
  manually if a scan exists but hasn't been analyzed yet — this is
  intentional (never triggered automatically), but means the graph isn't
  usable immediately after a scan without that one extra step.
- The scanner's boundary enforcement is application-level (path-boundary
  checks, symlink/junction rejection), not OS-level sandboxing — no
  chroot, container, or restricted OS user. See `docs/SECURITY.md`.
- File classification is extension/path-based only, with no file-content
  inspection — a renamed file (e.g. a binary given a `.txt` extension)
  will be misclassified. See `docs/DECISIONS.md` ADR-014.
- Scanning is synchronous within a single API request — no background
  job system, progress polling, or cancellation. Bounded by configurable
  limits (`SCAN_MAX_FILES`, `SCAN_MAX_DURATION_MS`, etc.), which are
  checked cooperatively between directory entries, not preemptively.
- No refresh-token rotation or server-side token revocation (documented,
  deliberate trade-offs — see `docs/DECISIONS.md` ADR-007 and
  `docs/SECURITY.md`).
- `Task.dependencies` is populated only via AI plan approval — not yet
  settable through the general task-update endpoint (manual dependency
  editing is a documented near-term enhancement, not implemented).
- Multi-hop cycle detection exists for both `parentTask` (Phase 3
  corrective pass) and AI-suggested/approved dependency edges (Batch B,
  via the shared graph engine) — but the two use separate algorithms
  (an ancestor-walk vs. the general graph engine) since they predate each
  other; not unified into one code path, since `parentTask` (a tree) and
  `dependencies` (a general DAG) are conceptually different structures.
- No dashboard task-count aggregation across projects, no pagination on
  the task list, no AI-specific rate limiting — see `docs/SECURITY.md`
  and `docs/ARCHITECTURE.md` for the reasoning behind each.
- No dedicated dependency-graph visualization endpoint or UI — the graph
  engine's ready/blocked/order functions are exercised during plan
  generation and unit-tested directly, but not yet exposed as their own
  view. A list-based plan review was the explicit scope for this batch.
- The UI (auth forms, the full Batch A workspace UI, and Batch B's AI
  planning tab) was verified via React Testing Library component tests
  and manual curl-based simulation of the exact browser request cycle,
  but its actual on-screen rendering was never visually confirmed in a
  real browser — the Claude-in-Chrome extension has not been connected in
  this environment in any phase so far. See `docs/IMPLEMENTATION_LOG.md`.
- Graceful shutdown's `disconnectDB()` call is covered by an automated
  test but real OS-level `SIGTERM` delivery to a running process wasn't
  verified — Windows has no true POSIX signal equivalent and this
  environment's shell tooling couldn't reliably simulate it.

## Roadmap (phased — see the master spec for full detail per phase)

0. Inspection & planning — **done**
1. Foundation & config (TS, lint, health check, env validation) — **done**
2. Backend & database (schemas, indexes, base routes) — **done**
3. Authentication & authorization — **done**
4. Frontend foundation (routing, design tokens, shell) — **done** (Batch A)
5. Project & engineering workspace (dashboard, project CRUD) — **done** (Batch A)
6. Requirements & task management (incl. subtasks) — **done** (Batch A)
7. AI planning system (provider abstraction, structured validation, human review) — **done** (Batch B)
8. Dependency graph engine (validation, topological sort, ready/blocked) — **done** (Batch B)
9. Local-first product alignment (product scope redefinition, ADR-013, no code behavior change) — **done**
10. Secure filesystem boundary + read-only project scanner (Batch C1, ADR-014) — **done**
11. Deterministic import extraction + module resolution against a scan's inventory (Batch C2, ADR-015) — **done**
12. Canonical dependency graph engine — nodes, confirmed edges with evidence, cycle detection, topological order, structural analysis (Batch C3, ADR-016) — **done**
13. Dependency graph visualization — frontend graph tab, accessible node/edge/diagnostics inspection (Batch C4, ADR-017) — **done**
14. Evidence-backed AI plan generation grounded in the graph (see `docs/PRODUCT_SCOPE_LOCAL.md`) — **not started**
15. Dashboard & analytics enhancements (deferred aggregation metrics)
16. Real-time updates (only if it doesn't compromise core quality)
17. Testing, security, performance audit
18. Deployment readiness
19. Final audit
