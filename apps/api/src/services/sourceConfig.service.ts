import path from "node:path";
import { Project, type ProjectDocument } from "../models/Project.js";
import { requireValidObjectId } from "./project.service.js";
import { resolveScanRoot, FsSafetyError } from "../lib/fsSafety.js";
import { AppError } from "../utils/AppError.js";

export interface SafeSourceConfig {
  label: string | null;
  configuredAt: string | null;
  hasPath: boolean;
}

function toSafeView(project: ProjectDocument): SafeSourceConfig {
  const cfg = project.sourceConfig;
  return {
    label: cfg?.label ?? null,
    configuredAt: cfg?.configuredAt ? cfg.configuredAt.toISOString() : null,
    hasPath: Boolean(cfg?.label),
  };
}

/**
 * Validates and stores a project's local source directory. Ownership is
 * enforced the same way as every other project-scoped write (query-level
 * `{_id, owner}`). Never executes or reads file contents here — only
 * resolves/validates the path via fsSafety and records it. Saving a path
 * does not trigger a scan; see scan.service.ts.
 */
export async function configureSourceForOwner(
  ownerId: string,
  projectId: string,
  rawPath: string,
): Promise<SafeSourceConfig> {
  requireValidObjectId(projectId, "project id");
  const project = await Project.findOne({ _id: projectId, owner: ownerId });
  if (!project) {
    throw new AppError("Project not found", 404);
  }

  let canonicalPath: string;
  try {
    canonicalPath = await resolveScanRoot(rawPath);
  } catch (err) {
    if (err instanceof FsSafetyError) {
      throw new AppError(err.message, 400);
    }
    throw err;
  }

  project.sourceConfig = {
    canonicalPath,
    label: path.basename(canonicalPath),
    configuredAt: new Date(),
  };
  await project.save();

  return toSafeView(project);
}

export async function getSourceConfigForOwner(ownerId: string, projectId: string): Promise<SafeSourceConfig> {
  requireValidObjectId(projectId, "project id");
  const project = await Project.findOne({ _id: projectId, owner: ownerId });
  if (!project) {
    throw new AppError("Project not found", 404);
  }
  return toSafeView(project);
}
