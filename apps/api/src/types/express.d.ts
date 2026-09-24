import type { UserRole } from "../models/User.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth after verifying the access token. Never trust a client-supplied user id instead. */
      user?: { id: string; role: UserRole };
      /** Set by validateQuery — the parsed/validated req.query, typed per-route via a cast at the call site. */
      validatedQuery?: unknown;
    }
  }
}

export {};
