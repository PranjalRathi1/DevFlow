import { Router } from "express";
import * as scanController from "../controllers/scan.controller.js";
import * as analysisController from "../controllers/analysis.controller.js";
import * as graphController from "../controllers/graph.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.js";
import { configureSourceSchema } from "../validators/scan.validators.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Mounted at /api/projects/:projectId/source — same explicit-prefix
// mounting pattern as every other nested collection router (see
// routes/index.ts's comment on why an unscoped `.use()` is unsafe).
export const sourceRouter = Router({ mergeParams: true });
sourceRouter.use(requireAuth);
sourceRouter.get("/", asyncHandler(scanController.getSource));
sourceRouter.put("/", validateBody(configureSourceSchema), asyncHandler(scanController.putSource));

// Mounted at /api/projects/:projectId/scans.
export const scanRouter = Router({ mergeParams: true });
scanRouter.use(requireAuth);
scanRouter.post("/", asyncHandler(scanController.startScan));
scanRouter.get("/latest", asyncHandler(scanController.getLatestScan));

// Mounted at /api/scans — single-resource-by-id, same dual-router pattern
// as plan.routes.ts's planByIdRouter (no :projectId needed; ownership is
// enforced via Scan's own denormalized `owner` field). Batch C2's
// import-extraction analysis is scoped to a specific scan, so it's
// nested here rather than under a new top-level router.
export const scanByIdRouter = Router();
scanByIdRouter.use(requireAuth);
scanByIdRouter.get("/:id", asyncHandler(scanController.getOne));
scanByIdRouter.post("/:id/analysis", asyncHandler(analysisController.runAnalysis));
scanByIdRouter.get("/:id/analysis", asyncHandler(analysisController.getAnalysis));
// Batch C3 — computed on demand from the scan's own inventory + its
// latest analysis; see services/graph.service.ts for why no separate
// graph model is persisted.
scanByIdRouter.get("/:id/graph", asyncHandler(graphController.getGraph));
