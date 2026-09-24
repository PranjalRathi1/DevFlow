import type { NextFunction, Request, Response } from "express";
import { AUTH_COOKIE_NAME } from "../utils/authCookie.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { AppError } from "../utils/AppError.js";

/**
 * Extracts and verifies the access-token cookie, attaching a validated
 * identity to req.user. Never trusts any user id the client sends in a
 * body/param instead — route handlers must read req.user, not req.body.userId
 * or similar. Rejects with a generic 401 on any failure (missing, malformed,
 * wrong signature, expired) — jsonwebtoken's specific error type is never
 * exposed to the client (see utils/jwt.ts's InvalidTokenError wrapper).
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token: unknown = req.cookies?.[AUTH_COOKIE_NAME];

  if (typeof token !== "string" || token.length === 0) {
    next(new AppError("Authentication required", 401));
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    next(new AppError("Invalid or expired session", 401));
  }
}
