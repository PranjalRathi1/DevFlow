import path from "node:path";

/**
 * Launcher configuration. Reuses the settings the API already reads from
 * the root `.env` (OLLAMA_BASE_URL, OLLAMA_MODEL, PORT) so the launcher and
 * the API always agree; only launcher-specific behaviour gets a new
 * DEVFLOW_* variable, each with a safe default. No secret is ever read into
 * this object, so logging it cannot leak one.
 */
export interface LauncherConfig {
  rootDir: string;
  /** false = only start the API and web; Docker, MongoDB and Ollama are left to the user. */
  autostartDependencies: boolean;
  composeFile: string;
  composeProject: string;
  mongoService: string;
  /** Stop the MongoDB service on exit — only ever if this launcher started it. */
  stopOwnedMongo: boolean;
  ollamaBaseUrl: string;
  ollamaModel: string;
  /** Stop the Ollama server on exit — only ever if this launcher started it. */
  stopOwnedOllama: boolean;
  dockerDesktopPath: string | undefined;
  ollamaPath: string | undefined;
  apiPort: number;
  webPort: number;
  startupTimeoutMs: number;
  pollIntervalMs: number;
  /** How long a child gets to exit gracefully before it is force-terminated. */
  stopGraceMs: number;
}

/** Minimal .env parser: KEY=VALUE lines, `#` comments, optional matching quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Docker Compose's own default project name: the project directory's base name, normalised. */
export function defaultComposeProject(rootDir: string): string {
  return path
    .basename(rootDir)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

export class ConfigError extends Error {}

function bool(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new ConfigError(`${name} must be true or false (got "${value}")`);
}

function int(value: string | undefined, fallback: number, name: string, min: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min)
    throw new ConfigError(`${name} must be an integer >= ${min} (got "${value}")`);
  return n;
}

/**
 * `fileEnv` is the parsed root .env; `processEnv` wins over it, matching
 * dotenv's behaviour in the API (an already-set variable is not overridden).
 */
export function loadLauncherConfig(
  rootDir: string,
  fileEnv: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): LauncherConfig {
  const get = (key: string) => processEnv[key] ?? fileEnv[key];
  const ollamaModel = get("OLLAMA_MODEL");
  if (!ollamaModel) {
    throw new ConfigError("OLLAMA_MODEL is not set. Set it in .env (see .env.example).");
  }
  const composeFile = get("DEVFLOW_COMPOSE_FILE") || "docker-compose.yml";
  return {
    rootDir,
    autostartDependencies: bool(
      get("DEVFLOW_AUTOSTART_DEPENDENCIES"),
      true,
      "DEVFLOW_AUTOSTART_DEPENDENCIES",
    ),
    composeFile: path.resolve(rootDir, composeFile),
    composeProject: get("DEVFLOW_COMPOSE_PROJECT") || defaultComposeProject(rootDir),
    mongoService: get("DEVFLOW_MONGO_SERVICE") || "mongo",
    stopOwnedMongo: bool(get("DEVFLOW_STOP_OWNED_MONGO"), true, "DEVFLOW_STOP_OWNED_MONGO"),
    // Same default as apps/api/src/config/env.ts.
    ollamaBaseUrl: (get("OLLAMA_BASE_URL") || "http://localhost:11434").replace(/\/+$/, ""),
    ollamaModel,
    stopOwnedOllama: bool(get("DEVFLOW_STOP_OWNED_OLLAMA"), true, "DEVFLOW_STOP_OWNED_OLLAMA"),
    dockerDesktopPath: get("DEVFLOW_DOCKER_DESKTOP_PATH") || undefined,
    ollamaPath: get("DEVFLOW_OLLAMA_PATH") || undefined,
    apiPort: int(get("PORT"), 4000, "PORT", 1),
    // apps/web/vite.config.ts serves on 5173.
    webPort: int(get("DEVFLOW_WEB_PORT"), 5173, "DEVFLOW_WEB_PORT", 1),
    startupTimeoutMs: int(get("DEVFLOW_STARTUP_TIMEOUT_MS"), 180_000, "DEVFLOW_STARTUP_TIMEOUT_MS", 1_000),
    pollIntervalMs: int(get("DEVFLOW_POLL_INTERVAL_MS"), 2_000, "DEVFLOW_POLL_INTERVAL_MS", 100),
    stopGraceMs: int(get("DEVFLOW_STOP_GRACE_MS"), 10_000, "DEVFLOW_STOP_GRACE_MS", 0),
  };
}
