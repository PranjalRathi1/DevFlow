import type { Request, Response } from "express";
import {
  createRequirement,
  deleteRequirementForOwner,
  getRequirementForOwner,
  listRequirementsForProject,
  updateRequirementForOwner,
} from "../services/requirement.service.js";
import { AppError } from "../utils/AppError.js";
import type { ListRequirementsQuery } from "../validators/requirement.validators.js";

function requireUserId(req: Request): string {
  if (!req.user) {
    throw new AppError("Authentication required", 401);
  }
  return req.user.id;
}

export async function create(req: Request, res: Response): Promise<void> {
  const requirement = await createRequirement(requireUserId(req), req.params.projectId as string, req.body);
  res.status(201).json({ requirement });
}

export async function list(req: Request, res: Response): Promise<void> {
  const requirements = await listRequirementsForProject(
    requireUserId(req),
    req.params.projectId as string,
    req.validatedQuery as ListRequirementsQuery,
  );
  res.status(200).json({ requirements });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const requirement = await getRequirementForOwner(requireUserId(req), req.params.id as string);
  res.status(200).json({ requirement });
}

export async function update(req: Request, res: Response): Promise<void> {
  const requirement = await updateRequirementForOwner(requireUserId(req), req.params.id as string, req.body);
  res.status(200).json({ requirement });
}

export async function remove(req: Request, res: Response): Promise<void> {
  await deleteRequirementForOwner(requireUserId(req), req.params.id as string);
  res.status(204).send();
}
