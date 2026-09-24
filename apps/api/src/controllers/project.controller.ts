import type { Request, Response } from "express";
import {
  createProject,
  deleteProjectForOwner,
  getProjectForOwner,
  listProjectsForOwner,
  updateProjectForOwner,
} from "../services/project.service.js";
import { AppError } from "../utils/AppError.js";

// requireAuth runs before every handler in project.routes.ts, so req.user
// is always set here — this narrows the type rather than re-authenticating.
function requireUserId(req: Request): string {
  if (!req.user) {
    throw new AppError("Authentication required", 401);
  }
  return req.user.id;
}

export async function create(req: Request, res: Response): Promise<void> {
  const project = await createProject(requireUserId(req), req.body);
  res.status(201).json({ project });
}

export async function list(req: Request, res: Response): Promise<void> {
  const projects = await listProjectsForOwner(requireUserId(req));
  res.status(200).json({ projects });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const project = await getProjectForOwner(requireUserId(req), req.params.id as string);
  res.status(200).json({ project });
}

export async function update(req: Request, res: Response): Promise<void> {
  const project = await updateProjectForOwner(requireUserId(req), req.params.id as string, req.body);
  res.status(200).json({ project });
}

export async function remove(req: Request, res: Response): Promise<void> {
  await deleteProjectForOwner(requireUserId(req), req.params.id as string);
  res.status(204).send();
}
