import { Router } from "express";
import * as planController from "../controllers/plan.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.js";
import { generatePlanSchema, updatePlanSchema } from "../validators/plan.validators.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Collection routes, mounted at /api/projects/:projectId/plans.
export const planCollectionRouter = Router({ mergeParams: true });
planCollectionRouter.use(requireAuth);
planCollectionRouter.post(
  "/generate",
  validateBody(generatePlanSchema),
  asyncHandler(planController.generate),
);
planCollectionRouter.get("/", asyncHandler(planController.list));

// Single-resource routes, mounted at /api/plans.
export const planByIdRouter = Router();
planByIdRouter.use(requireAuth);
planByIdRouter.get("/:id", asyncHandler(planController.getOne));
planByIdRouter.patch("/:id", validateBody(updatePlanSchema), asyncHandler(planController.update));
planByIdRouter.post("/:id/approve", asyncHandler(planController.approve));
planByIdRouter.post("/:id/reject", asyncHandler(planController.reject));
