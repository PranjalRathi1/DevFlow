# DevFlow AI

A local-first, single-user engineering planning assistant. The goal:
import an existing project, describe a desired change, and get a
structured, dependency-aware, evidence-backed implementation plan —
reviewed and approved by you before anything is persisted, and without
DevFlow ever modifying your source project. See
`docs/PRODUCT_SCOPE_LOCAL.md` for the full product scope.

**Status**: Phases 0–3, Batch A (Phases 4–6), Batch B (AI planning +
dependency graph), Batch C1 (secure filesystem boundary + read-only
project scanner), Batch C2 (deterministic import extraction + module
resolution), Batch C3 (canonical dependency graph engine), and Batch C4
(dependency graph visualization) complete — foundation, database,
authentication, a full engineering workspace (projects, requirements,
tasks/subtasks), AI-assisted plan generation (Ollama-backed) with a
deterministic dependency graph engine and human review before anything
is approved, a project can be pointed at a real local directory and
scanned read-only into a classified file inventory, its JS/JSX/TS/TSX
files' real imports extracted and resolved into confirmed/unresolved/
external/unsupported relationships with evidence, those relationships
turned into an actual cycle-detected, topologically-ordered dependency
graph, and now that graph has its own frontend tab — a visual diagram
plus an always-present accessible table view, evidence inspection, and
diagnostics. Evidence-backed AI planning grounded in that graph is
**not yet implemented** — today's AI plans are still grounded only in
typed requirement text.
See `PROJECT_DECISIONS.md` for current status and
`docs/PROJECT_OVERVIEW.md` for the full roadmap.

## Prerequisites

- Node.js ≥ 20 (developed against v24.19.0)
- npm ≥ 11 (workspaces)
- Docker Desktop (for local MongoDB) — **must be running** before
  `docker compose up` / `npm run db:up`
- [Ollama](https://ollama.com) running locally with a model pulled
  (developed against `qwen2.5:7b`: `ollama pull qwen2.5:7b`) — only needed
  for actually generating AI plans through the running app; the automated
  test suite mocks the AI provider and does not require Ollama.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env: set MONGO_ROOT_USERNAME/MONGO_ROOT_PASSWORD and a matching
# MONGODB_URI. Do NOT set NODE_ENV here — see docs/DECISIONS.md ADR-006.

npm run db:up        # starts MongoDB in Docker (needs Docker Desktop running)
npm run dev:api       # http://localhost:4000
npm run dev:web       # http://localhost:5173
```

Check the API is actually talking to the database:

```bash
curl http://localhost:4000/api/health      # liveness — always 200 if the process is up
curl http://localhost:4000/api/health/db   # readiness — 200 if MongoDB is connected, 503 otherwise
```

## Database lifecycle

```bash
npm run db:up      # start MongoDB (detached)
npm run db:down     # stop MongoDB (data persists in the named volume)
npm run db:logs      # tail MongoDB logs
npm run db:reset     # stop MongoDB AND delete its data volume — destructive
```

## Monorepo layout

```
apps/web/       React + TypeScript + Vite frontend
apps/api/       Express + TypeScript backend (incl. AI provider abstraction,
                 the dependency graph engine, and the read-only project scanner)
packages/shared/ still empty — no cross-package consumer yet (see ADR-010)
docs/           Architecture, API, security, testing, and decision docs
```

## Documentation

- `PROJECT_DECISIONS.md` — current status + key decisions (start here)
- `docs/PRODUCT_SCOPE_LOCAL.md` — the local-first product scope (canonical)
- `docs/PROJECT_OVERVIEW.md` — product vision, architecture, roadmap
- `docs/DECISIONS.md` — ADR log
- `docs/ARCHITECTURE.md` — system architecture, request lifecycle, routing
- `docs/DATABASE_DESIGN.md` — collections, indexes, validation, lifecycle
- `docs/SECURITY.md` — auth, authorization, and known limitations
- `docs/API_DOCUMENTATION.md` — every endpoint, request/response shapes
- `docs/AI_SYSTEM.md` — AI provider abstraction, Ollama config, plan
  generation/validation/approval workflow
- `docs/DEPENDENCY_ENGINE.md` — the dependency graph engine's rules,
  direction convention, and API
- `docs/TESTING.md` — test strategy and current coverage
- `docs/IMPLEMENTATION_LOG.md` — chronological build log
