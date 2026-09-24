import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import type { UserRole } from "../models/User.js";

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
}

type ExpiresIn = NonNullable<jwt.SignOptions["expiresIn"]>;

export function signAccessToken(payload: AccessTokenPayload): string {
  const options: jwt.SignOptions = { expiresIn: env.JWT_ACCESS_TTL as ExpiresIn };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, options);
}

export class InvalidTokenError extends Error {
  constructor(message = "Invalid or expired token") {
    super(message);
    this.name = "InvalidTokenError";
  }
}

// Wraps jsonwebtoken's verify to normalize every failure mode (expired,
// malformed, wrong signature) into one InvalidTokenError — callers (the
// auth middleware) should never need to know or leak *why* a token failed.
export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (typeof decoded === "string" || typeof decoded.sub !== "string" || typeof decoded.role !== "string") {
      throw new InvalidTokenError();
    }
    return { sub: decoded.sub, role: decoded.role as UserRole };
  } catch {
    throw new InvalidTokenError();
  }
}
