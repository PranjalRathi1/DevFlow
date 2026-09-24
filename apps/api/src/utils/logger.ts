import pino, { type LoggerOptions } from "pino";
import { env } from "../config/env.js";

const options: LoggerOptions = {
  level: env.NODE_ENV === "production" ? "info" : "debug",
  // pino-http logs request/response headers by default, which would
  // otherwise leak the auth cookie and any Authorization header verbatim
  // into every request log line. Redact rather than rely on nothing ever
  // logging them elsewhere.
  redact: {
    paths: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'],
    censor: "[redacted]",
  },
};

if (env.NODE_ENV === "development") {
  options.transport = {
    target: "pino-pretty",
    options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
  };
}

export const logger = pino(options);
