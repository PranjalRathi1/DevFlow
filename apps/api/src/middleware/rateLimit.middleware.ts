import rateLimit from "express-rate-limit";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { env } from "../config/env.js";

const passthrough: RequestHandler = (_req: Request, _res: Response, next: NextFunction) => next();

// Brute-force protection specifically for /api/auth/register and
// /api/auth/login — not a general API rate limit. Disabled in the test
// environment: express-rate-limit's default store is in-memory and shared
// across the whole test run, so without this the many deliberate
// invalid-login/duplicate-registration test cases would trip it and
// produce flaky 429s unrelated to what each test is actually checking.
// This mirrors a common, intentional testing pattern — not a security
// bypass in real environments. See docs/SECURITY.md.
export const authLimiter: RequestHandler =
  env.NODE_ENV === "test"
    ? passthrough
    : rateLimit({
        windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
        limit: env.AUTH_RATE_LIMIT_MAX,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: { message: "Too many attempts. Please try again later.", code: "RATE_LIMITED" },
        },
      });
