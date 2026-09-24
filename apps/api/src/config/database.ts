import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "../utils/logger.js";

mongoose.connection.on("error", (err) => {
  logger.error({ err }, "MongoDB connection error");
});

mongoose.connection.on("disconnected", () => {
  logger.warn("MongoDB disconnected");
});

mongoose.connection.on("reconnected", () => {
  logger.info("MongoDB reconnected");
});

/**
 * Connects to MongoDB with a bounded server-selection timeout so an
 * unreachable database fails fast (a few seconds) instead of hanging on
 * Mongoose's default 30s. Callers decide how to react to failure — this
 * function does not exit the process, so the API can still serve
 * `/api/health` (liveness) even when the database is down.
 */
export async function connectDB(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: env.DB_CONNECT_TIMEOUT_MS,
  });
  logger.info("MongoDB connected");
}

export async function disconnectDB(): Promise<void> {
  if (mongoose.connection.readyState === mongoose.ConnectionStates.disconnected) {
    return;
  }
  await mongoose.disconnect();
  logger.info("MongoDB disconnected cleanly");
}

const READY_STATE_LABEL = {
  [mongoose.ConnectionStates.disconnected]: "disconnected",
  [mongoose.ConnectionStates.connected]: "connected",
  [mongoose.ConnectionStates.connecting]: "connecting",
  [mongoose.ConnectionStates.disconnecting]: "disconnecting",
  [mongoose.ConnectionStates.uninitialized]: "uninitialized",
} as const;

export function getDbState(): { readyState: number; label: string } {
  const readyState = mongoose.connection.readyState;
  return { readyState, label: READY_STATE_LABEL[readyState] ?? "unknown" };
}
