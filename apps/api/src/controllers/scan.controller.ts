import type { Request, Response } from "express";
import { configureSourceForOwner, getSourceConfigForOwner } from "../services/sourceConfig.service.js";
import { runScanForOwner, getLatestScanForOwner, getScanForOwner } from "../services/scan.service.js";
import { AppError } from "../utils/AppError.js";

// requireAuth runs before every handler in scan.routes.ts, so req.user is
// always set here — same narrowing pattern as project.controller.ts.
function requireUserId(req: Request): string {
  if (!req.user) {
    throw new AppError("Authentication required", 401);
  }
  return req.user.id;
}

export async function getSource(req: Request, res: Response): Promise<void> {
  const sourceConfig = await getSourceConfigForOwner(requireUserId(req), req.params.projectId as string);
  res.status(200).json({ sourceConfig });
}

export async function putSource(req: Request, res: Response): Promise<void> {
  const sourceConfig = await configureSourceForOwner(
    requireUserId(req),
    req.params.projectId as string,
    req.body.path,
  );
  res.status(200).json({ sourceConfig });
}

export async function startScan(req: Request, res: Response): Promise<void> {
  const scan = await runScanForOwner(requireUserId(req), req.params.projectId as string);
  res.status(201).json({ scan });
}

export async function getLatestScan(req: Request, res: Response): Promise<void> {
  const scan = await getLatestScanForOwner(requireUserId(req), req.params.projectId as string);
  res.status(200).json({ scan });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const scan = await getScanForOwner(requireUserId(req), req.params.id as string);
  res.status(200).json({ scan });
}
