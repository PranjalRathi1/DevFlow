import ts from "typescript";

/**
 * Deterministic, read-only import/require extraction from JS/JSX/TS/TSX
 * source TEXT — no filesystem access here at all (reading the file is the
 * orchestrating service's job, see services/analysis.service.ts). Uses
 * TypeScript's own parser (`ts.createSourceFile`) rather than regular
 * expressions, since import syntax has too many real edge cases (string
 * quoting, comments containing `import`, template-literal-adjacent code)
 * for a regex to handle reliably. Parsing only — no type-checking, no
 * `Program`/`TypeChecker`, so this never resolves types or touches other
 * files, and never executes or evaluates any code.
 */
export const SUPPORTED_EXTRACTION_LANGUAGES = ["javascript", "jsx", "typescript", "tsx"] as const;
export type SupportedExtractionLanguage = (typeof SUPPORTED_EXTRACTION_LANGUAGES)[number];

export function isSupportedExtractionLanguage(
  language: string | null | undefined,
): language is SupportedExtractionLanguage {
  return (SUPPORTED_EXTRACTION_LANGUAGES as readonly string[]).includes(language ?? "");
}

export type ImportType = "import" | "export_from" | "require" | "dynamic_import";

export interface ExtractedImportSite {
  /**
   * The literal module specifier string when the import target is a plain
   * string literal (`isLiteral: true`), otherwise a safe, truncated
   * snippet of the actual source expression — never an evaluated value,
   * since evaluating it would mean executing code. `isLiteral: false`
   * callers must not attempt to resolve `rawImport` as a module path.
   */
  rawImport: string;
  isLiteral: boolean;
  importType: ImportType;
  /** 1-based, matching editor conventions. */
  line: number;
  /** 1-based. */
  column: number;
  /**
   * Stage 5: true only when the SYNTAX guarantees the import is erased
   * from emitted JavaScript under every compiler setting: `import type`,
   * `export type ... from`, and type-position `import("...")`. Absent
   * does not mean "used at runtime". `import { type A }` is deliberately
   * NOT marked: under `verbatimModuleSyntax` it still loads the module.
   */
  typeOnly?: boolean;
}

export interface ExtractionResult {
  status: "ok" | "parse_error";
  imports: ExtractedImportSite[];
  /** Only set when status is "parse_error" — short and safe, never raw diagnostic text that could echo source content back. */
  diagnosticReason?: string;
}

const MAX_SNIPPET_LENGTH = 120;

function safeSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_SNIPPET_LENGTH ? `${collapsed.slice(0, MAX_SNIPPET_LENGTH)}…` : collapsed;
}

function scriptKindFor(language: SupportedExtractionLanguage): ts.ScriptKind {
  switch (language) {
    case "javascript":
      return ts.ScriptKind.JS;
    case "jsx":
      return ts.ScriptKind.JSX;
    case "typescript":
      return ts.ScriptKind.TS;
    case "tsx":
      return ts.ScriptKind.TSX;
  }
}

// `SourceFile.parseDiagnostics` is a real, stable-in-practice field the
// TypeScript compiler populates internally, but it isn't part of the
// package's published public `.d.ts` — accessed defensively here with a
// fail-open fallback (treated as "no errors detected") if it's ever
// absent or a different shape, rather than crashing or false-flagging a
// valid file. This is a syntax-only diagnostic (no type-checking is ever
// performed — no Program/TypeChecker is created), consistent with "parse
// only, never evaluate."
function hasSyntaxErrors(sourceFile: ts.SourceFile): boolean {
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: unknown }).parseDiagnostics;
  return Array.isArray(diagnostics) && diagnostics.length > 0;
}

function locationOf(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function pushLiteralOrSnippet(
  sites: ExtractedImportSite[],
  sourceFile: ts.SourceFile,
  node: ts.Node,
  importType: ImportType,
  argument: ts.Expression | undefined,
  typeOnly = false,
): void {
  const { line, column } = locationOf(sourceFile, node);
  const flag = typeOnly ? { typeOnly: true } : {};
  if (argument && ts.isStringLiteralLike(argument)) {
    sites.push({ rawImport: argument.text, isLiteral: true, importType, line, column, ...flag });
    return;
  }
  const snippetSource = argument ?? node;
  sites.push({
    rawImport: safeSnippet(snippetSource.getText(sourceFile)),
    isLiteral: false,
    importType,
    line,
    column,
    ...flag,
  });
}

export function extractImports(sourceText: string, language: SupportedExtractionLanguage): ExtractionResult {
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(
      `file.${language}`,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(language),
    );
  } catch {
    return { status: "parse_error", imports: [], diagnosticReason: "Unable to parse file" };
  }

  if (hasSyntaxErrors(sourceFile)) {
    return { status: "parse_error", imports: [], diagnosticReason: "Syntax errors detected" };
  }

  const sites: ExtractedImportSite[] = [];

  try {
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const typeOnly = node.importClause?.isTypeOnly === true;
        pushLiteralOrSnippet(sites, sourceFile, node, "import", node.moduleSpecifier, typeOnly);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        pushLiteralOrSnippet(sites, sourceFile, node, "export_from", node.moduleSpecifier, node.isTypeOnly);
      } else if (ts.isImportTypeNode(node)) {
        // `typeof import("./x.js")` / `import("./x.js").T` — a compile-time
        // reference that previously produced no relationship at all.
        const arg = node.argument;
        const literal =
          ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal) ? arg.literal : undefined;
        pushLiteralOrSnippet(sites, sourceFile, node, "import", literal, true);
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          pushLiteralOrSnippet(sites, sourceFile, node, "dynamic_import", node.arguments[0]);
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          pushLiteralOrSnippet(sites, sourceFile, node, "require", node.arguments[0]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  } catch {
    return { status: "parse_error", imports: [], diagnosticReason: "Unable to traverse parsed syntax tree" };
  }

  return { status: "ok", imports: sites };
}
