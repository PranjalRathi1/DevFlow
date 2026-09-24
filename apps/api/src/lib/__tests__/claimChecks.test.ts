import { describe, expect, it } from "vitest";
import { checkClaims, extractClaims, type ClaimSource } from "../claimChecks.js";
import { buildDependencyGraph, type GraphRelationshipInput } from "../sourceDependencyGraph.js";
import { classifyAffectedFiles } from "../planningContext.js";

// Task 3 (ADR-030). Expected labels are derived by hand from the fixture:
//   src/app.ts -> src/routes.ts (line 3) -> src/service.ts (line 1)
//   src/styles.css, README.md exist but are not analysed source files.
//   legacy/ was not read by the scan.
const files = [
  "src/app.ts",
  "src/routes.ts",
  "src/service.ts",
  "src/util.ts",
  "src/styles.css",
  "README.md",
  "lib/util.ts",
];
const edge = (from: string, to: string, line: number): GraphRelationshipInput => ({
  importerRelativePath: from,
  rawImport: `./${to}`,
  isLiteral: true,
  importType: "import",
  line,
  status: "confirmed",
  resolvedRelativePath: to,
});
const graph = buildDependencyGraph(
  files.map((relativePath) => ({
    relativePath,
    language: relativePath.endsWith(".ts") ? "typescript" : null,
  })),
  [edge("src/app.ts", "src/routes.ts", 3), edge("src/routes.ts", "src/service.ts", 1)],
);
const source: ClaimSource = {
  inventory: new Set(files),
  graph,
  absenceNote: (p) => (p.startsWith("legacy/") ? "Inside legacy, not read" : undefined),
};

describe("extractClaims", () => {
  it("reads present-tense relationship verbs and their direction", () => {
    expect(extractClaims("Imported by src/app.ts and used by src/x.ts")).toEqual([
      { kind: "imported_by", target: "src/app.ts" },
      { kind: "imported_by", target: "src/x.ts" },
    ]);
    expect(extractClaims("It imports src/a.ts; depends on src/b.ts")).toEqual([
      { kind: "imports", target: "src/a.ts" },
      { kind: "imports", target: "src/b.ts" },
    ]);
  });

  it("names the subject when the text does: 'a imports b'", () => {
    expect(extractClaims("src/app.ts imports src/routes.ts")).toEqual([
      { kind: "mentions", target: "src/app.ts" },
      { kind: "imports", target: "src/routes.ts", subject: "src/app.ts" },
    ]);
  });

  it("treats intent and imperative verbs as mentions, not claims about the code", () => {
    expect(
      extractClaims("The handler will import src/a.ts. Import src/b.ts here. Needs to use src/c.ts"),
    ).toEqual([
      { kind: "mentions", target: "src/a.ts" },
      { kind: "mentions", target: "src/b.ts" },
      { kind: "mentions", target: "src/c.ts" },
    ]);
    expect(extractClaims("should be used by src/d.ts")).toEqual([{ kind: "mentions", target: "src/d.ts" }]);
  });

  it("never carries a verb across a sentence boundary", () => {
    expect(extractClaims("It imports things. See src/a.ts")).toEqual([
      { kind: "mentions", target: "src/a.ts" },
    ]);
  });

  it("only picks tokens with a file extension, keeping paths intact at sentence end", () => {
    expect(extractClaims("Update the auth service in src/auth/service.ts.")).toEqual([
      { kind: "mentions", target: "src/auth/service.ts" },
    ]);
    expect(extractClaims("no paths here, e.g. version 1.2")).toEqual([]);
  });
});

describe("checkClaims against the scan", () => {
  const check = (text: string, subject?: string) => checkClaims(text, subject, source, 5);

  it("supports a relationship only with a confirmed edge in the stated direction", () => {
    expect(check("Imported by src/app.ts", "src/routes.ts")).toEqual([
      {
        kind: "imported_by",
        target: "src/app.ts",
        status: "supported",
        note: "Confirmed import src/app.ts -> src/routes.ts (line 3).",
      },
    ]);
    // Reversed direction is NOT supported by that edge.
    expect(check("It imports src/app.ts", "src/routes.ts")[0]).toMatchObject({
      status: "not_found",
      note: expect.stringMatching(
        /No confirmed import src\/routes\.ts -> src\/app\.ts .* not shown by the scan/,
      ),
    });
    // A transitive relation is not a direct import.
    expect(check("Imported by src/app.ts", "src/service.ts")[0]?.status).toBe("not_found");
  });

  it("checks relationships the text states between two named files", () => {
    expect(check("src/app.ts imports src/routes.ts", undefined)).toEqual([
      { kind: "mentions", target: "src/app.ts", status: "in_scan" },
      {
        kind: "imports",
        subject: "src/app.ts",
        target: "src/routes.ts",
        status: "supported",
        note: "Confirmed import src/app.ts -> src/routes.ts (line 3).",
      },
    ]);
  });

  it("labels mentions: in scan, not in scan, unread location, relative, ambiguous name, prose", () => {
    expect(check("See src/util.ts, src/missing.ts, legacy/x.ts, ./local.ts, util.ts, Node.js")).toEqual([
      { kind: "mentions", target: "src/util.ts", status: "in_scan" },
      {
        kind: "mentions",
        target: "src/missing.ts",
        status: "not_in_scan",
        note: "The scan looked for this path and did not find it.",
      },
      { kind: "mentions", target: "legacy/x.ts", status: "unverifiable", note: "Inside legacy, not read" },
      {
        kind: "mentions",
        target: "./local.ts",
        status: "unverifiable",
        note: expect.stringMatching(/relative path/),
      },
      {
        kind: "mentions",
        target: "util.ts",
        status: "unverifiable",
        note: "Not a full scan path; 2 scanned file(s) have this name (lib/util.ts, src/util.ts), so DevFlow did not pick one.",
      },
      // "Node.js": no scanned file has that name -> prose, not flagged.
    ]);
  });

  it("keeps bare file names unverifiable, adding only a conditional finding for a single candidate", () => {
    // Each bare name has exactly one scanned candidate (routes.ts, app.ts).
    expect(check("routes.ts is imported by app.ts")).toEqual([
      {
        kind: "mentions",
        target: "routes.ts",
        status: "unverifiable",
        note: "Not a full scan path; 1 scanned file(s) have this name (src/routes.ts), so DevFlow did not pick one.",
      },
      {
        kind: "imported_by",
        subject: "routes.ts",
        target: "app.ts",
        status: "unverifiable",
        note: expect.stringMatching(
          /If this means src\/app\.ts -> src\/routes\.ts: the scan shows that import\.$/,
        ),
      },
    ]);
    expect(check("service.ts imports app.ts")[1]?.note).toMatch(
      /If this means src\/service\.ts -> src\/app\.ts: the scan does not show that import\.$/,
    );
    // util.ts has two candidates: no conditional finding at all.
    expect(check("util.ts imports app.ts")[1]?.note).not.toMatch(/If this means/);
    // A bare subject is never described as a new file.
    expect(check("service.ts imports app.ts")[1]?.note).not.toMatch(/proposed new file/);
  });

  it("never flags technology names as missing files", () => {
    expect(check("Built on Node.js and Next.js, served by Express.js")).toEqual([]);
  });

  it("does not check relationships for non-source files or files not in the scan", () => {
    expect(check("Imported by src/styles.css", "src/app.ts")[0]).toMatchObject({
      status: "unverifiable",
      note: expect.stringMatching(/not an analysed source file/),
    });
    expect(check("Imported by src/app.ts", "src/new.ts")[0]).toMatchObject({
      status: "unverifiable",
      note: expect.stringMatching(/not in the scan \(e\.g\. a proposed new file\)/),
    });
  });

  it("skips the subject itself and stops at the limit", () => {
    expect(check("src/app.ts is this file", "src/app.ts")).toEqual([]);
    const many = Array.from({ length: 9 }, (_, i) => `src/m${i}.ts`).join(" ");
    expect(checkClaims(many, undefined, source, 3)).toHaveLength(3);
  });
});

describe("classifyAffectedFiles attaches claim checks from the AI's reason", () => {
  const evidenceSource = { inventory: new Set(files), graph };

  it("labels the reason's claims and leaves files without claims unchanged", () => {
    const [withClaim, plain] = classifyAffectedFiles(
      [
        { path: "src/routes.ts", reason: "Imported by src/app.ts and src/service.ts", change: "modify" },
        { path: "src/util.ts", reason: "add a cache" },
      ],
      evidenceSource,
    );
    expect(withClaim?.claimChecks).toEqual([
      expect.objectContaining({ kind: "imported_by", target: "src/app.ts", status: "supported" }),
      expect.objectContaining({ kind: "imported_by", target: "src/service.ts", status: "not_found" }),
    ]);
    expect(plain).not.toHaveProperty("claimChecks");
  });

  it("checks nothing when the plan is not grounded in a scan", () => {
    const [f] = classifyAffectedFiles([{ path: "src/routes.ts", reason: "Imported by src/app.ts" }], null);
    expect(f).not.toHaveProperty("claimChecks");
  });
});
