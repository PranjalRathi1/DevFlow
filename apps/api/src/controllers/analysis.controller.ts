import type { Request, Response } from "express";
import { runAnalysisForOwner, getLatestAnalysisForOwner } from "../services/analysis.service.js";
import { AppError } from "../utils/AppError.js";

// requireAuth runs before every handler in scan.routes.ts, so req.user is
// always set here — same narrowing pattern as scan.controller.ts.
function requireUserId(req: Request): string {
  if (!req.user) {
    throw new AppError("Authentication required", 401);
  }
  return req.user.id;
}

export async function runAnalysis(req: Request, res: Response): Promise<void> {
  const analysis = await runAnalysisForOwner(requireUserId(req), req.params.id as string);
  res.status(201).json({ analysis });
}

export async function getAnalysis(req: Request, res: Response): Promise<void> {
  const analysis = await getLatestAnalysisForOwner(requireUserId(req), req.params.id as string);
  res.status(200).json({ analysis });
}
