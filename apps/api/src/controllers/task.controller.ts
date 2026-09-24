import type { Request, Response } from "express";
import {
  createTask,
  deleteTaskForOwner,
  getTaskForOwner,
  listTasksForProject,
  updateTaskForOwner,
} from "../services/task.service.js";
import { AppError } from "../utils/AppError.js";
import type { ListTasksQuery } from "../validators/task.validators.js";

function requireUserId(req: Request): string {
  if (!req.user) {
    throw new AppError("Authentication required", 401);
  }
  return req.user.id;
}

export async function create(req: Request, res: Response): Promise<void> {
  const task = await createTask(requireUserId(req), req.params.projectId as string, req.body);
  res.status(201).json({ task });
}

export async function list(req: Request, res: Response): Promise<void> {
  const tasks = await listTasksForProject(
    requireUserId(req),
    req.params.projectId as string,
    req.validatedQuery as ListTasksQuery,
  );
  res.status(200).json({ tasks });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const task = await getTaskForOwner(requireUserId(req), req.params.id as string);
  res.status(200).json({ task });
}

export async function update(req: Request, res: Response): Promise<void> {
  const task = await updateTaskForOwner(requireUserId(req), req.params.id as string, req.body);
  res.status(200).json({ task });
}

export async function remove(req: Request, res: Response): Promise<void> {
  await deleteTaskForOwner(requireUserId(req), req.params.id as string);
  res.status(204).send();
}
