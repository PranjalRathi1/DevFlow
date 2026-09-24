# Product Scope — Local-First Engineering Planning Assistant

This document defines DevFlow's revised product direction, superseding the
implicit "multi-user SaaS project tracker" framing of Phases 0–3/Batch A.
It does not describe a rewrite — see `docs/DECISIONS.md` ADR-013 and
`docs/IMPLEMENTATION_LOG.md`'s "Local-First Product Alignment" entry for
what actually changed in code versus what is purely a documented direction
change.

## Product purpose

DevFlow helps a developer understand an existing codebase and plan changes
safely. It is a **local-first, single-user engineering planning
assistant**: import an existing project, describe a desired change, get an
evidence-backed implementation plan — without DevFlow ever touching the
source project's files.

## Core workflow

1. Create or open a local DevFlow workspace.
2. Import or register an existing project directory. _(Implemented —
   Batch C1: `PUT /api/projects/:projectId/source` validates and stores a
   local directory path against a project. See `docs/DECISIONS.md`
   ADR-014.)_
3. Scan the project in read-only mode. _(Implemented — Batch C1:
   `POST /api/projects/:projectId/scans` runs a deterministic, read-only
   scan and persists a classified file inventory. Never writes, deletes,
   renames, or executes anything in the source directory — see
   `docs/SECURITY.md`.)_
4. Extract relevant project structure and metadata. _(Partially
   implemented — the scan produces a file inventory with category/
   language classification and skip/error diagnostics, but this is
   structural metadata only: no file contents are read or parsed.)_
5. Analyze supported import/dependency relationships where available.
   _(Not yet implemented — the dependency graph engine that exists today
   operates on AI-proposed task dependencies, not on real code import
   graphs. See "Batch B compatibility" in ADR-013. The scanner does not
   parse imports/requires.)_
6. Allow the user to describe a desired change. _(Implemented today as
   "create a Requirement.")_
7. Identify potentially relevant files and dependencies. _(Not yet
   implemented — nothing connects a requirement to the scanned inventory
   yet.)_
8. Generate an evidence-backed AI plan through Ollama. _(Partially
   implemented: AI plan generation through Ollama exists and is
   validated/human-reviewed — Batch B — but the plan is not yet
   evidence-backed by real source-file analysis, since steps 5 and 7 don't
   exist yet. Today's plans are grounded only in the requirement text the
   user typed, not in the scanned codebase.)_
9. Review confirmed facts, inferences, and proposals separately. _(Not yet
   implemented — today's `Plan.suggestedTasks` has no fact/inference/
   proposal distinction. See ADR-013's schema-gap list.)_
10. Approve or reject the plan. _(Implemented — Batch B's approve/reject
    workflow.)_
11. Track implementation progress without modifying the source project
    automatically. _(Task status tracking is implemented; the scanner
    (Batch C1) only ever reads — see `docs/SECURITY.md`'s filesystem
    access boundary section for exactly what's enforced and its real
    limits.)_

This numbered list is intentionally honest about what's real today (steps
2, 3, 6, 8 partially, 10, 11, and 4 partially) versus what is scoped for
future batches (steps 5, 7, 9, and completing 4/8). Nothing in this
document should be read as a claim that import extraction or
evidence-backed analysis exists yet — the scanner is an inventory, not an
analyzer.

## Explicit non-goals for the current stage

- Automatic source-code modification.
- Automatic commits or pull requests.
- Full IDE replacement.
- Multi-user collaboration (the existing account/ownership system exists
  for security-boundary and future-flexibility reasons, not to support
  teams — see ADR-013).
- Complex SaaS billing.
- Cloud deployment as a priority.
- Unrestricted autonomous coding agents.
- Treating AI-generated assumptions as confirmed facts.

## Initial success criteria

A developer can import a small existing project, request a realistic
change, and receive a plan that:

- Identifies relevant files.
- Explains dependency or impact relationships.
- Separates facts from assumptions.
- Lists prerequisites and implementation steps.
- Identifies uncertainty.
- Can be reviewed before approval.
- Does not modify the imported project.

"Can be reviewed before approval" (Batch B) and "does not modify the
imported project" are met — the latter is now actually enforced (Batch
C1's read-only scanner), not merely vacuous. "Identifies relevant files"
is partially met (a scan produces a classified inventory, but nothing yet
judges relevance to a specific requested change). The rest — explaining
dependency/impact relationships, separating facts from assumptions, and
identifying uncertainty in a plan — remain unimplemented; that's the next
batch's actual scope.

## Read-only boundary (binding constraint for all future work)

DevFlow's backend may only ever **read** from an imported project's
directory (open/stat/read a file's contents). It must never write,
delete, rename, or otherwise modify anything inside that directory, and
must never execute code found inside it. **Implemented as of Batch C1**
(`services/scanner.service.ts` only calls `fs.readdir`/`fs.lstat`; no
write/delete/rename/exec call exists anywhere in that code path) and
verified by a test asserting fixture files are byte-identical before and
after a scan — see `docs/SECURITY.md`'s "Filesystem Access Boundary"
section and `docs/DECISIONS.md` ADR-014 for exactly what's enforced and
its real limits (an application-level boundary, not OS-level
sandboxing). This constraint remains binding on any future code that
reads deeper into scanned files (e.g. parsing file contents for import
extraction) — not just the scanner itself.
