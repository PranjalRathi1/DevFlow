import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { connectDB, disconnectDB } from "./config/database.js";

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

// Connected independently of app.listen(): a database outage should not
// prevent the process from starting or from serving the liveness check at
// GET /api/health. GET /api/health/db reports the outcome of this call.
connectDB().catch((err: unknown) => {
  logger.error(
    { err },
    "Failed to connect to MongoDB at startup. The API is still running and " +
      "GET /api/health stays up, but database-backed endpoints will fail " +
      "until this is resolved. Check MONGODB_URI and that the database is " +
      "reachable — e.g. `npm run db:up`.",
  );
});

function shutdown(signal: string): void {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  server.close((err) => {
    if (err) {
      logger.error({ err }, "Error during shutdown");
      process.exit(1);
      return;
    }
    disconnectDB()
      .catch((dbErr: unknown) => logger.error({ err: dbErr }, "Error disconnecting MongoDB during shutdown"))
      .finally(() => {
        logger.info("Server closed. Bye.");
        process.exit(0);
      });
  });

  // Force-exit if close() hangs (e.g. keep-alive connections not draining).
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
  process.exit(1);
});
