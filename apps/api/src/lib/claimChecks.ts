import type { DependencyGraphResult } from "./sourceDependencyGraph.js";

/**
 * Task 3 (ADR-030): checks the file paths and import relationships the AI
 * STATES in its free text (an affected file's reason, a task's description)
 * against the scan. Nothing here marks a claim true or false: a claim is
 * "supported" only by a confirmed import edge in the stated direction, and
 * "not_found" only means the scan's confirmed imports don't show it — the
 * claim may still hold through unresolved imports or runtime wiring.
 * Deterministic, pure, bounded.
 */

export const CLAIM_CHECK_LIMITS = { perFile: 5, perTask: 10 } as const;

export const CLAIM_KINDS = ["imports", "imported_by", "mentions"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CLAIM_STATUSES = ["supported", "not_found", "in_scan", "not_in_scan", "unverifiable"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export interface ClaimCheck {
  kind: ClaimKind;
  /** Set when the text itself names the importer/imported file ("a.ts imports b.ts"); otherwise the claim is about the file the text belongs to. */
  subject?: string | undefined;
  /** The path exactly as the AI wrote it. */
  target: string;
  status: ClaimStatus;
  note?: string | undefined;
}

export interface ClaimSource {
  inventory: ReadonlySet<string>;
  graph: Pick<DependencyGraphResult, "nodes" | "edges">;
  /** Why a path absent from the inventory might still exist (unread directory, early stop); undefined = provably absent. */
  absenceNote: (path: string) => string | undefined;
}

// A path-like token with a file extension. Bare words ("the auth service")
// are never treated as paths — no guessing from prose.
const PATH_TOKEN =
  /(?<![\w@~./-])(?:\.{1,2}\/)*(?:[\w@~-][\w@~.-]*\/)*[\w@~-][\w@~.-]*\.(?:[cm]?[jt]sx?|json|css|scss|md|html|ya?ml)(?![\w/-])/g;
// Present-tense statements about the code as it is. Bare verbs ("import",
// "use") are usually instructions, not claims, so they don't count.
const IMPORTED_BY = /\b(?:imported|used|required|consumed|re-?exported) by\b|\bimporters?\b|\bdependents?\b/g;
const IMPORTS = /\bimports\b|\bdepends on\b|\brequires\b|\bre-?exports\b|\buses\b/g;
// Intent ("will import", "should be used by", "to use"): the plan's
// future, not a claim about the scanned code — recorded as a mention only.
const INTENT_BEFORE_VERB =
  /\b(?:will|would|should|shall|must|can|could|may|might|to|needs? to|going to)\s+(?:not\s+)?(?:\w+\s+){0,2}$/;
// A new clause starts after ";", "!", "?", a newline, or ". " — so a verb
// in one sentence never attaches to a path in the next.
const CLAUSE_BREAK = /[;!?\n]|\.\s/g;

function lastMatch(re: RegExp, text: string): { start: number; end: number } | undefined {
  let found: { start: number; end: number } | undefined;
  for (const m of text.matchAll(re)) found = { start: m.index, end: m.index + m[0].length };
  return found;
}

/** The relationship the words right before a path claim, if any, and whether a clause break precedes it. */
function claimKindBefore(prefix: string): { kind: ClaimKind; broken: boolean } {
  let clauseStart = 0;
  for (const m of prefix.matchAll(CLAUSE_BREAK)) clauseStart = m.index + m[0].length;
  const clause = prefix.slice(clauseStart).toLowerCase();
  const importedBy = lastMatch(IMPORTED_BY, clause);
  const imports = lastMatch(IMPORTS, clause);
  const verb = !importedBy
    ? imports
    : !imports
      ? importedBy
      : importedBy.end > imports.end
        ? importedBy
        : imports;
  const broken = clauseStart > 0;
  if (!verb || INTENT_BEFORE_VERB.test(clause.slice(0, verb.start))) return { kind: "mentions", broken };
  return { kind: verb === importedBy ? "imported_by" : "imports", broken };
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

type Located = { status: ClaimStatus; note?: string } | "in_scan" | "not_a_path";

function locate(target: string, source: ClaimSource): Located {
  if (source.inventory.has(target)) return "in_scan";
  const candidates = [...source.inventory].filter((f) => basename(f) === basename(target)).sort();
  const sameName = candidates.length;
  // "Node.js", "Next.js": without a "/", a token only counts as a path if
  // some scanned file has that name — prose is never flagged as missing.
  if (!target.includes("/") && sameName === 0) return "not_a_path";
  if (target.startsWith("./") || target.startsWith("../")) {
    return {
      status: "unverifiable",
      note: "A relative path; which file it means depends on context, so it was not checked.",
    };
  }
  const why = source.absenceNote(target);
  if (why) return { status: "unverifiable", note: why };
  if (!target.includes("/")) {
    return {
      status: "unverifiable",
      // Candidates are listed for the reviewer; none is picked.
      note: `Not a full scan path; ${sameName} scanned file(s) have this name (${candidates.slice(0, 3).join(", ")}${sameName > 3 ? ", …" : ""}), so DevFlow did not pick one.`,
    };
  }
  return { status: "not_in_scan", note: "The scan looked for this path and did not find it." };
}

export interface ExtractedClaim {
  kind: ClaimKind;
  target: string;
  /** A path named earlier in the same clause as the claim's subject ("a.ts imports b.ts"). */
  subject?: string;
}

/** Every path the text mentions, with the relationship claimed right before it. In text order; deduplicated. */
export function extractClaims(text: string): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  let clauseFrom = 0;
  let previous: { target: string; end: number } | undefined;
  for (const m of text.matchAll(PATH_TOKEN)) {
    const target = m[0];
    const { kind, broken } = claimKindBefore(text.slice(clauseFrom, m.index));
    // "a.ts imports b.ts": the path right before the verb, in the same
    // clause, is the importer. ("imports a.ts and b.ts" keeps the verb for
    // the whole list, and has no in-text subject.)
    const subject =
      kind !== "mentions" && !broken && previous && previous.end === clauseFrom ? previous.target : undefined;
    const key = `${kind}\u0000${target}\u0000${subject ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind, target, ...(subject ? { subject } : {}) });
    }
    if (kind === "mentions") clauseFrom = m.index + target.length;
    previous = { target, end: m.index + target.length };
  }
  return out;
}

/** The one scanned file a bare name could mean — only for a CONDITIONAL note, never as a resolution. */
function soleCandidate(path: string, source: ClaimSource): string | undefined {
  if (source.inventory.has(path)) return path;
  if (path.includes("/")) return undefined;
  const candidates = [...source.inventory].filter((f) => basename(f) === path);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Checks the claims in `text` about `subject` (the file the text is about;
 * undefined for task-level text, where a relationship is checked only if
 * the text names both files).
 */
export function checkClaims(
  text: string,
  subject: string | undefined,
  source: ClaimSource,
  limit: number,
): ClaimCheck[] {
  const nodes = new Set(source.graph.nodes.map((n) => n.id));
  const edges = new Map(source.graph.edges.map((e) => [`${e.from}\u0000${e.to}`, e]));
  const edgeNote = (from: string, to: string) => {
    const edge = edges.get(`${from}\u0000${to}`);
    const lines = edge?.evidence.flatMap((e) => (e.line !== undefined ? [e.line] : [])) ?? [];
    return edge
      ? {
          found: true,
          text: `Confirmed import ${from} -> ${to}${lines.length ? ` (line ${lines.join(", ")})` : ""}.`,
        }
      : {
          found: false,
          text: `No confirmed import ${from} -> ${to} in this scan. It may exist through an unresolved or unsupported import, or through runtime wiring; it is not shown by the scan.`,
        };
  };

  const checks: ClaimCheck[] = [];
  for (const claim of extractClaims(text)) {
    const about = claim.subject ?? subject;
    if (claim.target === about) continue;
    const kind: ClaimKind = about === undefined ? "mentions" : claim.kind;
    const base = {
      kind,
      target: claim.target,
      ...(claim.subject && kind !== "mentions" ? { subject: claim.subject } : {}),
    };
    const target = locate(claim.target, source);
    if (target === "not_a_path") continue;

    if (kind === "mentions" || about === undefined) {
      checks.push(target === "in_scan" ? { ...base, status: "in_scan" } : { ...base, ...target });
    } else {
      const subjectLoc = locate(about, source);
      const [fromName, toName] = kind === "imports" ? [about, claim.target] : [claim.target, about];
      if (target === "in_scan" && subjectLoc === "in_scan") {
        if (!nodes.has(about) || !nodes.has(claim.target)) {
          checks.push({
            ...base,
            status: "unverifiable",
            note: "One of the two files is not an analysed source file in this scan, so no import data exists.",
          });
        } else {
          const e = edgeNote(fromName, toName);
          checks.push({ ...base, status: e.found ? "supported" : "not_found", note: e.text });
        }
      } else if (
        subjectLoc === "not_a_path" ||
        (subjectLoc !== "in_scan" && subjectLoc.status === "not_in_scan")
      ) {
        checks.push({
          ...base,
          status: "unverifiable",
          note: `${about} is not in the scan (e.g. a proposed new file), so its import relationships cannot be checked.`,
        });
      } else {
        // At least one side is a bare name, relative path or unread location.
        const why = [subjectLoc, target]
          .filter((l): l is { status: ClaimStatus; note?: string } => typeof l !== "string")
          .map((l) => l.note)
          .filter(Boolean)
          .join(" ");
        const from = soleCandidate(fromName, source);
        const to = soleCandidate(toName, source);
        const conditional =
          from && to && nodes.has(from) && nodes.has(to)
            ? ` If this means ${from} -> ${to}: ${edgeNote(from, to).found ? "the scan shows that import" : "the scan does not show that import"}.`
            : "";
        checks.push({ ...base, status: "unverifiable", note: `${why}${conditional}`.trim() });
      }
    }
    if (checks.length >= limit) break;
  }
  return checks;
}
