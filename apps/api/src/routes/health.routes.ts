import { Router } from "express";
import { getDbState } from "../config/database.js";

export const healthRouter = Router();

const startedAt = Date.now();

// Liveness: "is the process up". Deliberately has no database dependency
// so it keeps responding even if MongoDB is unreachable — unchanged from
// Phase 1 and covered by the existing health.test.ts.
healthRouter.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

// Readiness: "can the app actually serve database-backed requests". Kept
// separate from /health (standard liveness/readiness split) so a database
// outage is visible and diagnosable without taking down the liveness check.
healthRouter.get("/health/db", (_req, res) => {
  const { label } = getDbState();

  if (label === "connected") {
    res.status(200).json({ status: "ok", db: label });
    return;
  }

  res.status(503).json({
    status: "error",
    db: label,
    message: "Database is not connected",
  });
});
