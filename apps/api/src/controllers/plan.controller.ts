import type { Request, Response } from "express";
import {
  approvePlanForOwner,
  checkAIProviderStatus,
  generatePlan,
  getPlanForOwner,
  listPlansForProject,
  rejectPlanForOwner,
  updatePlanForOwner,
} from "../services/plan.service.js";
import { AppError } from "../utils/AppError.js";

function requireUserId(req: Request): string {
  if (!req.user) {
    throw new AppError("Authentication required", 401);
  }
  return req.user.id;
}

export async function generate(req: Request, res: Response): Promise<void> {
  const plan = await generatePlan(requireUserId(req), req.params.projectId as string, req.body.requirementId);
  res.status(201).json({ plan });
}

export async function list(req: Request, res: Response): Promise<void> {
  const plans = await listPlansForProject(requireUserId(req), req.params.projectId as string);
  res.status(200).json({ plans });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const plan = await getPlanForOwner(requireUserId(req), req.params.id as string);
  res.status(200).json({ plan });
}

export async function update(req: Request, res: Response): Promise<void> {
  const plan = await updatePlanForOwner(requireUserId(req), req.params.id as string, req.body);
  res.status(200).json({ plan });
}

export async function approve(req: Request, res: Response): Promise<void> {
  const { plan, createdTasks } = await approvePlanForOwner(requireUserId(req), req.params.id as string);
  res.status(200).json({ plan, createdTasks });
}

export async function reject(req: Request, res: Response): Promise<void> {
  const plan = await rejectPlanForOwner(requireUserId(req), req.params.id as string);
  res.status(200).json({ plan });
}

export async function aiStatus(_req: Request, res: Response): Promise<void> {
  const status = await checkAIProviderStatus();
  res.status(200).json(status);
}
