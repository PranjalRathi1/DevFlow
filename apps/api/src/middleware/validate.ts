import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny } from "zod";

// Runs a Zod schema against req.body and replaces it with the parsed
// (validated + transformed, e.g. lowercased email) result. A failure is
// passed to next() as a ZodError, which errorHandler.ts already maps to a
// 400 VALIDATION_ERROR response.
export function validateBody(schema: ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(result.error);
      return;
    }
    req.body = result.data;
    next();
  };
}

// Same idea for query strings, attached as req.validatedQuery rather than
// overwriting req.query in place — Express's query object isn't guaranteed
// safely reassignable across versions, and keeping the raw and validated
// forms separate is clearer at call sites anyway.
export function validateQuery(schema: ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(result.error);
      return;
    }
    req.validatedQuery = result.data;
    next();
  };
}
