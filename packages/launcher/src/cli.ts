import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadLauncherConfig, parseEnvFile } from "./config.js";
import { Launcher } from "./lifecycle.js";
import { createNodeSystem } from "./system.js";

// packages/launcher/src/cli.ts -> repository root
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sys = createNodeSystem();

const envFile = path.join(rootDir, ".env");
if (!existsSync(envFile)) {
  sys.error(
    "No .env file found at the repository root. Copy .env.example to .env and fill it in (see README).",
  );
  process.exit(1);
}

let launcher: Launcher;
try {
  const config = loadLauncherConfig(rootDir, parseEnvFile(readFileSync(envFile, "utf8")), process.env);
  launcher = new Launcher(config, sys);
} catch (err) {
  sys.error(err instanceof ConfigError ? `Configuration error: ${err.message}` : String(err));
  process.exit(1);
}

// Ctrl+C, termination, and closing the console window (SIGHUP on Windows).
// Each handler only starts the shared, idempotent cleanup; the process exits
// below, once run() resolves, which is after that cleanup has finished.
// (Closing the window on Windows allows only a few seconds before Windows
// ends the process, so cleanup may not finish in that case.)
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    void launcher.shutdown(signal);
  });
}
process.on("uncaughtException", (err) => {
  sys.error(`Unexpected error: ${err.stack ?? err.message}`);
  void launcher.shutdown("unexpected error", 1).then((r) => process.exit(Math.max(1, r.exitCode)));
});
process.on("unhandledRejection", (reason) => {
  sys.error(`Unexpected error: ${String(reason)}`);
  void launcher.shutdown("unexpected error", 1).then((r) => process.exit(Math.max(1, r.exitCode)));
});
// Best-effort only: "exit" handlers run synchronously, so this can force-stop
// the processes we spawned (and stop an owned MongoDB), but cannot wait for
// anything asynchronous. It does not run at all when the process is killed
// outright (Task Manager, taskkill /F, SIGKILL).
process.on("exit", () => launcher.emergencyCleanupSync());

const exitCode = await launcher.run();
process.exit(exitCode);
