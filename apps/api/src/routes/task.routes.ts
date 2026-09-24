import { Router } from "express";
import * as taskController from "../controllers/task.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { createTaskSchema, listTasksQuerySchema, updateTaskSchema } from "../validators/task.validators.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Collection routes, mounted at /api/projects/:projectId/tasks.
export const taskCollectionRouter = Router({ mergeParams: true });
taskCollectionRouter.use(requireAuth);
taskCollectionRouter.post("/", validateBody(createTaskSchema), asyncHandler(taskController.create));
taskCollectionRouter.get("/", validateQuery(listTasksQuerySchema), asyncHandler(taskController.list));

// Single-resource routes, mounted at /api/tasks.
export const taskByIdRouter = Router();
taskByIdRouter.use(requireAuth);
taskByIdRouter.get("/:id", asyncHandler(taskController.getOne));
taskByIdRouter.patch("/:id", validateBody(updateTaskSchema), asyncHandler(taskController.update));
taskByIdRouter.delete("/:id", asyncHandler(taskController.remove));
