import { promises as fs } from "node:fs";
import { Project } from "../models/Project.js";
import {
  Analysis,
  type AnalysisDocument,
  type AnalysisOutcome,
  type RelationshipStatus,
} from "../models/Analysis.js";
import { getScanForOwner } from "./scan.service.js";
import { revalidateScanRoot, resolveSafeChild, FsSafetyError } from "../lib/fsSafety.js";
import { extractImports, isSupportedExtractionLanguage } from "../lib/importExtraction.js";
import {
  buildInventoryIndex,
  packageEntryPoints,
  resolveImport,
  type ScanInventoryIndex,
} from "../lib/importResolution.js";
import {
  CONFIG_LIMITS,
  buildResolutionConfig,
  configFilesIn,
  unloadedConfigTargets,
  type ConfigDiagnostic,
  type ResolutionConfig,
} from "../lib/resolutionConfig.js";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

interface RelationshipInput {
  importerRelativePath: string;
  rawImport: string;
  isLiteral: boolean;
  importType?: string | undefined;
  line?: number | undefined;
  column?: number | undefined;
  typeOnly?: boolean | undefined;
  status: RelationshipStatus;
  resolvedRelativePath?: string | undefined;
  resolutionMethod?: string | undefined;
  reason?: string | undefined;
}

function diagnosticOnly(importerRelativePath: string, reason: string): RelationshipInput {
  return { importerRelativePath, rawImport: "", isLiteral: false, status: "parse_error", reason };
}

/**
 * Runs deterministic import extraction + resolution for a specific,
 * already-completed scan and persists the result. The scan's own `items`
 * list is the sole source of truth for both "which files get analyzed"
 * and "what a relative import can resolve to" — no independent file
 * inventory is invented, and resolution never touches the live
 * filesystem (see lib/importResolution.ts). Reading file CONTENT (the one
 * thing that does require disk I/O) reuses the exact same
 * `revalidateScanRoot`/`resolveSafeChild` boundary as scanning — no new
 * or weaker filesystem access path. Synchronous within this one call,
 * same as scanning itself (see docs/DECISIONS.md's Batch C2 ADR).
 */
export async function runAnalysisForOwner(ownerId: string, scanId: string): Promise<AnalysisDocument> {
  const scan = await getScanForOwner(ownerId, scanId);

  if (scan.outcome === "failed") {
    throw new AppError("Cannot analyze a scan that itself failed to read the source directory", 400);
  }

  const project = await Project.findOne({ _id: scan.project, owner: ownerId }).select(
    "+sourceConfig.canonicalPath",
  );
  if (!project) {
    throw new AppError("Project not found", 404);
  }
  const configuredPath = project.sourceConfig?.canonicalPath;
  if (!configuredPath) {
    throw new AppError("No source directory is configured for this project", 400);
  }

  let canonicalPath: string;
  try {
    canonicalPath = await revalidateScanRoot(configuredPath);
  } catch (err) {
    if (err instanceof FsSafetyError) {
      throw new AppError(`Configured source directory is no longer valid: ${err.message}`, 400);
    }
    throw err;
  }

  const inventory = buildInventoryIndex(scan.items);
  const { config: resolutionConfig, readDiagnostics } = await loadResolutionConfig(canonicalPath, scan.items);
  const relationships: RelationshipInput[] = [];
  let totalFilesAnalyzed = 0;
  let totalFilesSkipped = 0;

  for (const item of scan.items) {
    if (item.type !== "file" || item.status !== "scanned") continue;
    if (!isSupportedExtractionLanguage(item.language)) {
      totalFilesSkipped += 1;
      continue;
    }

    totalFilesAnalyzed += 1;

    let absolutePath: string;
    try {
      absolutePath = resolveSafeChild(canonicalPath, item.relativePath);
    } catch {
      relationships.push(diagnosticOnly(item.relativePath, "Path is no longer safe to read"));
      continue;
    }

    let content: string;
    try {
      const stat = await fs.stat(absolutePath);
      if (stat.size > env.SCAN_MAX_FILE_SIZE_BYTES) {
        relationships.push(diagnosticOnly(item.relativePath, "File exceeds the configured size limit"));
        continue;
      }
      content = await fs.readFile(absolutePath, "utf-8");
    } catch {
      relationships.push(
        diagnosticOnly(item.relativePath, "Could not read file — it may have changed since the scan"),
      );
      continue;
    }

    const extraction = extractImports(content, item.language);
    if (extraction.status === "parse_error") {
      relationships.push(
        diagnosticOnly(item.relativePath, extraction.diagnosticReason ?? "Unable to parse file"),
      );
      continue;
    }

    for (const site of extraction.imports) {
      if (!site.isLiteral) {
        relationships.push({
          importerRelativePath: item.relativePath,
          rawImport: site.rawImport,
          isLiteral: false,
          importType: site.importType,
          line: site.line,
          column: site.column,
          status: "unsupported",
          reason: "Import target is not a static string literal — cannot be resolved without executing code",
        });
        continue;
      }

      const resolved = resolveImport(item.relativePath, site.rawImport, inventory, resolutionConfig);
      relationships.push({
        importerRelativePath: item.relativePath,
        rawImport: site.rawImport,
        isLiteral: true,
        importType: site.importType,
        line: site.line,
        column: site.column,
        ...(site.typeOnly ? { typeOnly: true } : {}),
        status: resolved.status,
        resolvedRelativePath: resolved.resolvedRelativePath,
        resolutionMethod: resolved.resolutionMethod,
        reason: resolved.reason,
      });
    }
  }

  const byStatus: Record<string, number> = {};
  for (const r of relationships) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  }

  // Mirrors Scan's own outcome philosophy: anything the analysis could
  // not fully verify (parse_error/unresolved/unsupported) flips the
  // outcome to warnings — "external" and "confirmed" are both normal,
  // fully-understood results, not warnings. A file being in an
  // unsupported LANGUAGE (totalFilesSkipped) is scope, not a warning.
  const hasWarnings = relationships.some(
    (r) => r.status === "parse_error" || r.status === "unresolved" || r.status === "unsupported",
  );
  const outcome: AnalysisOutcome = hasWarnings ? "completed_with_warnings" : "completed";

  return Analysis.create({
    project: scan.project,
    owner: ownerId,
    scan: scan._id,
    outcome,
    summary: {
      totalFilesAnalyzed,
      totalFilesSkipped,
      totalRelationships: relationships.length,
      byStatus,
    },
    relationships,
    resolutionConfig: summarizeResolutionConfig(resolutionConfig, readDiagnostics, inventory),
  });
}

// Task 1 (ADR-028): config files are read through the SAME safe-path
// boundary as source files, only if the scan observed them, and bounded
// in count and size. Nothing is evaluated; package-based and out-of-root
// `extends` are recorded as unsupported by the pure builder.
const MAX_CONFIG_BYTES = 512_000;

async function loadResolutionConfig(
  canonicalPath: string,
  items: readonly { relativePath: string; type: string; status: string }[],
): Promise<{ config: ResolutionConfig; readDiagnostics: ConfigDiagnostic[] }> {
  const observed = new Set(
    items.filter((i) => i.type === "file" && i.status === "scanned").map((i) => i.relativePath),
  );
  const loaded = new Map<string, string>();
  const readDiagnostics: ConfigDiagnostic[] = [];

  const tryLoad = async (file: string) => {
    if (loaded.size >= CONFIG_LIMITS.maxConfigFiles) return;
    try {
      const abs = resolveSafeChild(canonicalPath, file);
      const stat = await fs.stat(abs);
      if (stat.size > MAX_CONFIG_BYTES) {
        readDiagnostics.push({ file, message: "Config file exceeds the size limit; ignored" });
        return;
      }
      loaded.set(file, await fs.readFile(abs, "utf-8"));
    } catch {
      readDiagnostics.push({ file, message: "Config file could not be read; ignored" });
    }
  };

  for (const file of configFilesIn(observed)) await tryLoad(file);
  // Relative extends/references may name files outside the default pattern.
  for (let round = 0; round < CONFIG_LIMITS.maxExtendsDepth; round += 1) {
    const more = unloadedConfigTargets(loaded, observed);
    if (more.length === 0) break;
    for (const file of more) await tryLoad(file);
  }
  return { config: buildResolutionConfig(loaded), readDiagnostics };
}

const SUMMARY_LIMIT = 100;

function summarizeResolutionConfig(
  config: ResolutionConfig,
  readDiagnostics: ConfigDiagnostic[],
  inventory: ScanInventoryIndex,
) {
  return {
    aliasScopes: [...config.aliasScopes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, SUMMARY_LIMIT)
      .map(([dir, s]) => ({
        dir,
        configFile: s.configFile,
        baseUrl: s.baseUrl ?? null,
        patterns: s.paths.map((p) => p.pattern),
        ambiguous: s.ambiguous ?? null,
      })),
    packages: config.packages.slice(0, SUMMARY_LIMIT).map((p) => ({
      file: p.file,
      name: p.name ?? null,
      hasExports: p.exports !== undefined,
      hasImports: p.imports !== undefined,
      // Task 2 (ADR-029): declared entry points that exist in this scan.
      entryPoints: packageEntryPoints(p, inventory).slice(0, SUMMARY_LIMIT),
    })),
    diagnostics: [...readDiagnostics, ...config.diagnostics].slice(0, SUMMARY_LIMIT),
  };
}

export async function getLatestAnalysisForOwner(
  ownerId: string,
  scanId: string,
): Promise<AnalysisDocument | null> {
  const scan = await getScanForOwner(ownerId, scanId);
  return Analysis.findOne({ scan: scan._id, owner: ownerId }).sort({ createdAt: -1 });
}
