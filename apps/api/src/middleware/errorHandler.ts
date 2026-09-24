import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import mongoose from "mongoose";
import { AppError } from "../utils/AppError.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

// Express only treats a 4-arg function as an error handler, so all params are required.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        message: "Validation failed",
        code: "VALIDATION_ERROR",
        details: err.flatten(),
      },
    });
    return;
  }

  // Malformed ObjectId passed to a query — a route that queries by ID
  // without a service-layer pre-check (project.service.ts already
  // validates explicitly; this is a defensive fallback for any other path).
  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({
      error: { message: "Invalid identifier format", code: "INVALID_ID" },
    });
    return;
  }

  // Fallback for a duplicate-key write that wasn't caught explicitly at
  // the service layer (auth.service.ts already handles the registration
  // case specifically, with a message naming the conflicting resource).
  if (isDuplicateKeyError(err)) {
    res.status(409).json({
      error: { message: "A resource with that value already exists", code: "DUPLICATE" },
    });
    return;
  }

  if (err instanceof AppError) {
    if (!err.isOperational) {
      logger.error({ err }, "Non-operational AppError");
    }
    res.status(err.statusCode).json({
      error: { message: err.message, code: err.name },
    });
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, "Unhandled error");

  res.status(500).json({
    error: {
      message:
        env.NODE_ENV === "production"
          ? "Internal server error"
          : ((err as Error)?.message ?? "Internal server error"),
      code: "INTERNAL_ERROR",
    },
  });
}
