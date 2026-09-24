import { Router } from "express";
import * as requirementController from "../controllers/requirement.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import {
  createRequirementSchema,
  listRequirementsQuerySchema,
  updateRequirementSchema,
} from "../validators/requirement.validators.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Collection routes, mounted at /api/projects/:projectId/requirements
// (mergeParams so req.params.projectId is visible here).
export const requirementCollectionRouter = Router({ mergeParams: true });
requirementCollectionRouter.use(requireAuth);
requirementCollectionRouter.post(
  "/",
  validateBody(createRequirementSchema),
  asyncHandler(requirementController.create),
);
requirementCollectionRouter.get(
  "/",
  validateQuery(listRequirementsQuerySchema),
  asyncHandler(requirementController.list),
);

// Single-resource routes, mounted at /api/requirements — ownership is
// verified via the requirement's own denormalized `owner` field, so no
// projectId is needed in these URLs.
export const requirementByIdRouter = Router();
requirementByIdRouter.use(requireAuth);
requirementByIdRouter.get("/:id", asyncHandler(requirementController.getOne));
requirementByIdRouter.patch(
  "/:id",
  validateBody(updateRequirementSchema),
  asyncHandler(requirementController.update),
);
requirementByIdRouter.delete("/:id", asyncHandler(requirementController.remove));
