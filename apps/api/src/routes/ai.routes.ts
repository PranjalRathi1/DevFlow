import { Router } from "express";
import { aiStatus } from "../controllers/plan.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Mounted at /api/ai. Only ever returns a boolean + provider/model *name*
// — never a base URL, API key, or other server-side config. See
// docs/SECURITY.md.
export const aiRouter = Router();
aiRouter.use(requireAuth);
aiRouter.get("/status", asyncHandler(aiStatus));
