import type { Request, Response } from "express";
import { getDependencyGraphForOwner } from "../services/graph.service.js";
import { getImpactForOwner } from "../services/impact.service.js";
import type { ImpactQuery } from "../validators/impact.validators.js";
import { AppError } from "../utils/AppError.js";

// requireAuth runs before every handler in scan.routes.ts, so req.user is
// always set here — same narrowing pattern as scan.controller.ts.
function requireUserId(req: Request): string {
  if (!req.user) {
    throw new AppError("Authentication required", 401);
  }
  return req.user.id;
}

export async function getImpact(req: Request, res: Response): Promise<void> {
  const { file, maxDepth, maxNodes } = req.validatedQuery as ImpactQuery;
  const impact = await getImpactForOwner(requireUserId(req), req.params.id as string, file, {
    maxDepth,
    maxNodes,
  });
  res.status(200).json({ impact });
}

export async function getGraph(req: Request, res: Response): Promise<void> {
  const graph = await getDependencyGraphForOwner(requireUserId(req), req.params.id as string);
  res.status(200).json({ graph });
}
