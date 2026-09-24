# AI System

## Use Case

One use case in this batch: turning a `Requirement` into a structured,
human-reviewable task plan. Nothing else in the app calls the AI provider.

## Provider Abstraction

`apps/api/src/services/ai/`:

- `aiProvider.ts` — the `AIProvider` interface (`complete(prompt): Promise<string>`,
  `checkAvailability(): Promise<boolean>`) and `AIProviderError` (codes:
  `unavailable`, `timeout`, `invalid_response`).
- `ollamaProvider.ts` — the only implementation today. Calls Ollama's
  `/api/generate` with `format: "json"` (constrains output to valid JSON at
  the provider level, in addition to full re-validation on the way back —
  belt and suspenders, not a substitute for validation) and `/api/version`
  for the availability check.
- `index.ts` — `getAIProvider()`, a lazily-constructed singleton. The only
  seam `plan.service.ts` depends on, and the only thing tests replace via
  `vi.mock` — swapping in a second provider later means adding a class and
  a branch here, no call-site changes.

**Never imported from frontend code.** The frontend only ever sees
`GET /api/ai/status` → `{ available: boolean, provider: string, model: string }`
— never a base URL, timeout value, or any other server-side config.

## Configuration

Reuses env vars scaffolded in Phase 1 (no duplicates added this batch):
`AI_PROVIDER` (Zod enum, currently `["ollama"]` only), `OLLAMA_BASE_URL`,
`OLLAMA_MODEL`, `AI_REQUEST_TIMEOUT_MS`. No API key — Ollama is local, so
there's no provider credential to manage or leak.

## Prompt

`services/ai/promptBuilder.ts`'s `buildPlanningPrompt` — a plain template
string embedding the project name and requirement title/description,
instructing the model to return only a JSON object matching the plan
schema (see below), with the dependency rules (no self-deps, no cycles,
every `dependsOn` must reference a `tempId` in the same response) spelled
out in the prompt itself. This shapes the request; it does not replace
validating the response — the prompt is not trusted, only checked.

## Structured Output & Validation

`apps/api/src/validators/aiPlan.validators.ts`:

1. **Zod structural validation** (`aiPlanSchema`) — required fields, types,
   max lengths, enum values (`priority`), max task count (30), max list
   sizes. A raw response over 100,000 characters is rejected before this
   even runs (`MAX_RAW_RESPONSE_CHARS`, checked in `plan.service.ts` right
   after receiving the provider's response, before `JSON.parse`).
2. **Semantic validation** (`validateSuggestedTasksGraph`) — checks Zod
   can't express: duplicate `tempId`s, and the `dependsOn` graph itself
   (self-dependencies, duplicate edges, references to a `tempId` that
   doesn't exist, cycles of any length). This step **reuses the same
   dependency-graph engine** (`lib/dependencyGraph.ts`) that validates real
   `Task.dependencies` — see `docs/DEPENDENCY_ENGINE.md`. A `tempId` is
   never trusted as, or confused with, a real MongoDB `_id`.

Any issue at either stage means the whole plan is invalid. **An invalid
plan is never persisted** — `generatePlan` throws a `422` with the
validation issues before any `Plan.create()` call; there is no "generated
but invalid" row in the database.

## Failure Handling

| Condition                                          | Response | Notes                                                                        |
| -------------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| Provider unreachable / non-OK status               | `503`    | `checkAvailability()` also surfaces this proactively via `/api/ai/status`    |
| Provider request timeout (`AI_REQUEST_TIMEOUT_MS`) | `503`    | `AbortController`-based; the frontend shows the same "unavailable" messaging |
| Provider response isn't valid JSON                 | `502`    | Caught before Zod ever sees it                                               |
| Response exceeds `MAX_RAW_RESPONSE_CHARS`          | `502`    | Rejected before `JSON.parse`                                                 |
| Structurally/semantically invalid plan             | `422`    | Issues listed in the error message; nothing saved                            |

No raw database or provider internals (stack traces, Ollama's exact error
body) are ever included in these responses — see `docs/SECURITY.md`.

## Human Approval Lifecycle

A generated plan is never auto-approved. Status: `needs_review` (set at
creation) → `approved` | `rejected` (via `POST /api/plans/:id/approve` /
`/reject`). While `needs_review`, `title`/`summary`/`assumptions`/`risks`/
`suggestedTasks` can be edited (`PATCH /api/plans/:id`) — editing
`suggestedTasks` re-runs the same graph validation. Once approved or
rejected, a plan is immutable (further `PATCH`/`approve`/`reject` calls
return `409`).

**Approval** materializes `suggestedTasks` into real `Task` documents
(two passes: create all tasks to learn their real ids, then resolve each
task's `dependsOn` tempIds to real `Task._id`s — see
`plan.service.ts#approvePlanForOwner` for why this doesn't need a MongoDB
transaction). **Rejection** just marks the plan `rejected`; no tasks are
created.

## Privacy

The requirement's title and description (already stored, already visible
to the project owner) are sent to Ollama running on `localhost` — nothing
leaves the machine in the current configuration. If a hosted provider is
ever added, this section must be revisited: sending project-internal
requirement text to a third-party API is a real disclosure decision that
needs explicit documentation and, likely, an opt-in.

## Known Limitations

- Local `qwen2.5:7b` is a small model — plan quality is noticeably weaker
  than a frontier hosted model. Never overstate this in resume/portfolio
  claims (see `docs/RESUME_EVIDENCE.md` once written).
- No retry-with-backoff on transient provider failures — a failed
  generation just fails; the user re-clicks "Generate Plan."
- No cost/latency tracking beyond `aiMeta.durationMs` stored per plan.
- The prompt does not currently ask for `priority` reasoning per task —
  the model can pick any valid enum value without justification.
- Manual requirement/task workflows are unaffected either way: if the
  provider is unavailable, `/api/ai/status` reports it and the frontend
  disables the "Generate Plan" button while leaving the rest of the app
  fully usable — verified directly, not assumed (see
  `docs/IMPLEMENTATION_LOG.md`).
