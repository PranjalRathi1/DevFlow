import { Router } from "express";
import * as projectController from "../controllers/project.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.js";
import { createProjectSchema, updateProjectSchema } from "../validators/project.validators.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Mounted at /api/projects (see routes/index.ts) — paths here are relative
// to that prefix. Mounting with an explicit prefix (rather than `.use()`
// with no path) matters: an unscoped `.use(requireAuth)` on a router
// mounted at "/" would run for every request that reaches this router,
// including ones matching no route in it at all — intercepting e.g. a
// nonexistent /api/does-not-exist path with a 401 before it ever reached
// the 404 handler. Scoping the mount to "/projects" ensures requests for
// other paths never enter this router in the first place.
export const projectRouter = Router();

// Every project route requires authentication — ownership is enforced
// per-operation in project.service.ts's queries, not here.
projectRouter.use(requireAuth);

projectRouter.post("/", validateBody(createProjectSchema), asyncHandler(projectController.create));
projectRouter.get("/", asyncHandler(projectController.list));
projectRouter.get("/:id", asyncHandler(projectController.getOne));
projectRouter.patch("/:id", validateBody(updateProjectSchema), asyncHandler(projectController.update));
projectRouter.delete("/:id", asyncHandler(projectController.remove));
