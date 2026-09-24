# Dependency Graph Engine

`apps/api/src/lib/dependencyGraph.ts`. Pure functions over a plain
`{ nodes: string[], edges: DependencyEdge[] }` structure — no MongoDB, no
Express, no knowledge of what a "task" is. This is deliberate: the same
code validates AI-suggested plans (nodes = temporary string ids) and real
`Task.dependencies` (nodes = MongoDB ObjectId strings) without caring which.

## Location Decision

Originally planned for `packages/shared` (see ADR-009, Batch A), on the
assumption a future frontend graph visualization would need the same
algorithms. Batch B's actual scope explicitly rules that out ("a
list-based dependency review is sufficient... do not build a complex
graph editor"), so there is no genuine cross-package (frontend + backend)
consumer yet — only `apps/api` uses this code. Setting up a real build
pipeline for `packages/shared` (a `package.json`, an `exports` field
resolving correctly under both `tsc` typecheck _and_ the actual
`node dist/server.js` production runtime, which a bare `.ts` source
re-export does not handle — see the trade-off notes below) is real
infrastructure work with no current payoff. Implemented in
`apps/api/src/lib/` instead; `packages/shared` remains reserved for when a
frontend consumer of this exact code actually exists (e.g. a future graph
visualization phase), at which point the module can move with its tests,
unchanged, and the build tooling gets set up because something concretely
needs it.

## Dependency Direction

**An edge `{ from: "A", to: "B" }` means "task A depends on task B" — B
must be completed before A can become ready.** This is the single
convention used everywhere: the AI plan schema's `dependsOn` (a task's
`dependsOn` array lists the tasks it depends on), `Task.dependencies`
(same meaning, real ObjectIds), and every graph engine function.

## API

| Function                                                  | Purpose                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `validateGraph(graph)`                                    | Runs every structural check and returns **all** errors found (not just the first): self-dependency, duplicate edge, missing node reference, cycle (any length).                                                                      |
| `topologicalSort(graph)`                                  | Kahn's algorithm. Returns a dependency-respecting order (dependencies before dependents), or `null` if the graph has a cycle. Ties broken by sorted id for **deterministic** output — the same graph always produces the same order. |
| `getDependencies(graph, id)` / `getDependents(graph, id)` | Direct (one-hop) lookups, sorted.                                                                                                                                                                                                    |
| `getReadyTasks(graph, completed)`                         | Not-yet-completed nodes whose every dependency is in `completed`.                                                                                                                                                                    |
| `getBlockedTasks(graph, completed)`                       | Not-yet-completed nodes with at least one incomplete dependency. `ready ∪ blocked ∪ completed` always partitions every node.                                                                                                         |

## Validation Is Never Delegated to the AI

Both the AI plan validator (`aiPlan.validators.ts`) and (when task
dependencies are ever settable outside plan approval — not yet
implemented, see `docs/DECISIONS.md`) any future manual-edit path are
required to run their edge set through `validateGraph` before anything is
persisted. The AI is never trusted to have produced a valid graph on its
own — it's checked exactly the same way a human-submitted graph would be.

## Complexity

- `validateGraph`: O(V + E) for missing-node/self/duplicate checks, plus
  O(V + E) for cycle detection (DFS) — O(V + E) overall.
- `topologicalSort`: O(V + E) for the Kahn's-algorithm pass, plus an
  O(V log V) sort per queue-pop in the worst case for determinism
  (acceptable given plans are capped at 30 tasks — see
  `docs/AI_SYSTEM.md`; would need a priority-queue instead of repeated
  `Array.sort()` if graphs were ever expected to be large).
- `getReadyTasks` / `getBlockedTasks`: O(V + E).

## Tests

`apps/api/src/lib/__tests__/dependencyGraph.test.ts` — empty graph, single
task, linear chain, branching, merging, independent tasks, duplicate edge,
self-dependency, two-node cycle, multi-node cycle, missing node reference,
topological ordering (including determinism for ties), ready/blocked
tasks with dependencies completed/incomplete. 20 tests, all passing
against no external dependency (pure functions, no DB needed).

Real end-to-end exercise of this engine (not just its own unit tests) also
happens via `apps/api/src/routes/__tests__/plan.integration.test.ts` (a
cyclic AI-suggested plan is rejected with `422`) and the Phase 3 focused
corrective pass's `parentTask` cycle tests (a related but conceptually
separate hierarchy check — see ADR-008 — that predates this shared engine
and still uses its own ancestor-walk rather than this module, since
`parentTask` is a tree, not a general dependency graph).

## Known Limitations

- No weighted edges, no edge metadata (e.g. "why" a dependency exists) —
  not needed by anything in this batch.
- `topologicalSort`'s per-pop sort is O(V log V) in the worst case; fine
  at the current 30-task cap, would need revisiting only if that cap ever
  changes substantially.
- No incremental/streaming validation for very large graphs — the whole
  graph is validated at once, which is appropriate at this scale.
