import { Router } from "express";
import { login, logout, me, register } from "../controllers/auth.controller.js";
import { validateBody } from "../middleware/validate.js";
import { loginSchema, registerSchema } from "../validators/auth.validators.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authLimiter } from "../middleware/rateLimit.middleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Mounted at /api/auth (see routes/index.ts) — paths here are relative to
// that prefix. See project.routes.ts for why explicit prefix scoping
// matters (an unscoped mount's `.use()` middleware would run for every
// request reaching this router, not just ones matching a route in it).
export const authRouter = Router();

authRouter.post("/register", authLimiter, validateBody(registerSchema), asyncHandler(register));
authRouter.post("/login", authLimiter, validateBody(loginSchema), asyncHandler(login));
authRouter.post("/logout", asyncHandler(logout));
authRouter.get("/me", requireAuth, asyncHandler(me));
