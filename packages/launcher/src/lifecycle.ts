import path from "node:path";
import type { LauncherConfig } from "./config.js";
import type { ChildHandle, HttpResponse, System } from "./system.js";

/**
 * Who owns each resource, for THIS launcher process only. Held in memory:
 * a resource is "owned" only after this launcher itself started it
 * successfully; anything already available is "external" and is never
 * stopped. No ownership file is written or trusted.
 */
export type DependencyOwnership = "unknown" | "external" | "owned" | "disabled";

export interface OwnershipState {
  /** "owned" here means DevFlow launched Docker Desktop; it is still never closed (see docs). */
  docker: DependencyOwnership;
  mongo: DependencyOwnership;
  ollama: DependencyOwnership;
  api: DependencyOwnership;
  web: DependencyOwnership;
  /** Processes this launcher spawned, by label. Holding the handle is the ownership proof. */
  children: Map<string, ChildHandle>;
  startupComplete: boolean;
  shutdownStarted: boolean;
}

export class StartupError extends Error {}

export interface CleanupReport {
  exitCode: number;
  actions: string[];
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

interface ComposeContainer {
  Service?: string;
  State?: string;
  Health?: string;
}

/** `docker compose ps --format json` prints one object per line (v2.21+) or one array (older). */
export function parseComposePs(stdout: string): ComposeContainer[] {
  const text = stdout.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      return JSON.parse(text) as ComposeContainer[];
    } catch {
      return [];
    }
  }
  return text.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line) as ComposeContainer];
    } catch {
      return [];
    }
  });
}

/** Does Ollama's /api/tags list the configured model? "qwen" and "qwen:latest" are the same model. */
export function modelInstalled(tagsBody: string, model: string): boolean {
  let names: string[];
  try {
    const parsed = JSON.parse(tagsBody) as { models?: { name?: string; model?: string }[] };
    names = (parsed.models ?? []).flatMap((m) => [m.name, m.model].filter((n): n is string => !!n));
  } catch {
    return false;
  }
  const withTag = (n: string) => (n.includes(":") ? n : `${n}:latest`);
  return names.some((n) => withTag(n) === withTag(model));
}

/** apps/api/src/routes/health.routes.ts: { status: "ok", uptimeSeconds: number, timestamp: string }. */
export function isDevFlowApiHealth(r: HttpResponse | null): boolean {
  if (!r || r.status !== 200) return false;
  try {
    const body = JSON.parse(r.body) as Record<string, unknown>;
    return (
      body.status === "ok" && typeof body.uptimeSeconds === "number" && typeof body.timestamp === "string"
    );
  } catch {
    return false;
  }
}

/** The page title from apps/web/index.html (a test keeps the two in sync). */
export const DEVFLOW_WEB_TITLE = "<title>DevFlow AI</title>";

export function isDevFlowWebPage(r: HttpResponse | null): boolean {
  return !!r && r.status === 200 && r.body.includes(DEVFLOW_WEB_TITLE);
}

export class Launcher {
  readonly state: OwnershipState = {
    docker: "unknown",
    mongo: "unknown",
    ollama: "unknown",
    api: "unknown",
    web: "unknown",
    children: new Map(),
    startupComplete: false,
    shutdownStarted: false,
  };

  private startupPromise: Promise<void> | undefined;
  private cleanupPromise: Promise<CleanupReport> | undefined;
  private cleanupFinished = false;
  private resolveStopped: ((code: number) => void) | undefined;
  private readonly stopped = new Promise<number>((resolve) => (this.resolveStopped = resolve));

  constructor(
    private readonly config: LauncherConfig,
    private readonly sys: System,
  ) {}

  // ---------------------------------------------------------------- startup

  /**
   * Prepares dependencies, starts the app, then waits until shutdown.
   * Resolves with the process exit code. Any startup failure cleans up
   * whatever this launcher had already started.
   */
  async run(): Promise<number> {
    this.startupPromise = this.startup();
    try {
      await this.startupPromise;
    } catch (err) {
      if (this.state.shutdownStarted) {
        // A signal (or a crashed child) stopped startup: not a startup failure.
        this.sys.log("Startup stopped because DevFlow is shutting down.");
        return this.stopped;
      }
      this.sys.error(err instanceof StartupError ? err.message : `Startup failed: ${(err as Error).message}`);
      const report = await this.shutdown("startup failure");
      return Math.max(1, report.exitCode);
    }
    if (this.state.shutdownStarted) return this.stopped;
    this.state.startupComplete = true;
    this.sys.log(
      `DevFlow is running — web http://localhost:${this.config.webPort}, API http://localhost:${this.config.apiPort}/api. Press Ctrl+C to stop.`,
    );
    return this.stopped;
  }

  async startup(): Promise<void> {
    if (this.config.autostartDependencies) {
      await this.ensureDocker();
      this.throwIfStopping();
      await this.ensureMongo();
      this.throwIfStopping();
      await this.ensureOllama();
      this.throwIfStopping();
    } else {
      this.state.docker = this.state.mongo = this.state.ollama = "disabled";
      this.sys.log(
        "DEVFLOW_AUTOSTART_DEPENDENCIES=false: not managing Docker, MongoDB or Ollama. Make sure they are running.",
      );
    }
    await this.startApi();
    this.throwIfStopping();
    await this.startWeb();
  }

  private throwIfStopping() {
    if (this.state.shutdownStarted) throw new StartupError("Startup interrupted by shutdown.");
  }

  /** Polls `check` until it returns a value, or throws `timeoutMessage` after the startup timeout. */
  private async waitFor<T>(
    what: string,
    check: () => Promise<T | undefined>,
    timeoutMessage: string,
  ): Promise<T> {
    const deadline = this.sys.now() + this.config.startupTimeoutMs;
    let lastNotice = this.sys.now();
    for (;;) {
      const value = await check();
      if (value !== undefined) return value;
      if (this.state.shutdownStarted) throw new StartupError(`Stopped while waiting for ${what}.`);
      if (this.sys.now() >= deadline) throw new StartupError(timeoutMessage);
      if (this.sys.now() - lastNotice >= 15_000) {
        lastNotice = this.sys.now();
        this.sys.log(`Still waiting for ${what}…`);
      }
      await this.sys.sleep(this.config.pollIntervalMs);
    }
  }

  private async dockerReady(): Promise<"ready" | "not_ready" | "missing"> {
    const r = await this.sys.run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
    if (r.code === 0) return "ready";
    if (r.code === null && /ENOENT|not found/i.test(r.error ?? "")) return "missing";
    return "not_ready";
  }

  /** Docker Desktop's executable: the configured path, else standard install locations from the environment. */
  findDockerDesktop(): string | undefined {
    if (this.config.dockerDesktopPath) {
      return this.sys.fileExists(this.config.dockerDesktopPath) ? this.config.dockerDesktopPath : undefined;
    }
    if (this.sys.platform !== "win32") return undefined;
    const e = this.sys.env;
    const candidates = [
      e.ProgramFiles,
      e.ProgramW6432,
      e.LOCALAPPDATA && path.win32.join(e.LOCALAPPDATA, "Programs"),
    ]
      .filter((d): d is string => !!d)
      .map((dir) => path.win32.join(dir, "Docker", "Docker", "Docker Desktop.exe"));
    return candidates.find((c) => this.sys.fileExists(c));
  }

  async ensureDocker(): Promise<void> {
    const status = await this.dockerReady();
    if (status === "ready") {
      this.state.docker = "external";
      this.sys.log("Docker is already running.");
      return;
    }
    if (status === "missing") {
      throw new StartupError(
        "The Docker CLI was not found. Install Docker Desktop (https://docs.docker.com/desktop/), or set DEVFLOW_AUTOSTART_DEPENDENCIES=false and start MongoDB yourself.",
      );
    }
    if (this.sys.platform === "darwin" && !this.config.dockerDesktopPath) {
      this.sys.log("Docker is not running; opening Docker Desktop…");
      this.sys.launchDetached("open", ["-a", "Docker"]);
    } else {
      const exe = this.findDockerDesktop();
      if (!exe) {
        throw new StartupError(
          this.config.dockerDesktopPath
            ? `DEVFLOW_DOCKER_DESKTOP_PATH (${this.config.dockerDesktopPath}) does not exist.`
            : "Docker is not running and Docker Desktop was not found in its standard install location. Start Docker yourself, or set DEVFLOW_DOCKER_DESKTOP_PATH to 'Docker Desktop.exe'.",
        );
      }
      this.sys.log(`Docker is not running; starting Docker Desktop (${exe})…`);
      this.sys.launchDetached(exe, []);
    }
    // Launched by DevFlow — but Docker Desktop is shared with other
    // containers and apps, so it is deliberately never closed on exit.
    this.state.docker = "owned";
    await this.waitFor(
      "Docker to become ready",
      async () => ((await this.dockerReady()) === "ready" ? true : undefined),
      `Docker did not become ready within ${Math.round(this.config.startupTimeoutMs / 1000)} s. Open Docker Desktop, wait until it says it is running, then start DevFlow again (or raise DEVFLOW_STARTUP_TIMEOUT_MS).`,
    );
    this.sys.log("Docker is ready.");
  }

  /** Every compose call names DevFlow's own project and file explicitly, so no other project can be affected. */
  composeArgs(...rest: string[]): string[] {
    return [
      "compose",
      "--project-name",
      this.config.composeProject,
      "--project-directory",
      this.config.rootDir,
      "--file",
      this.config.composeFile,
      ...rest,
    ];
  }

  private async mongoContainer(): Promise<ComposeContainer | undefined> {
    const r = await this.sys.run(
      "docker",
      this.composeArgs("ps", "--all", "--format", "json", this.config.mongoService),
      {
        cwd: this.config.rootDir,
        timeoutMs: 30_000,
      },
    );
    if (r.code !== 0) {
      throw new StartupError(`Could not query the MongoDB service: ${(r.stderr || r.error || "").trim()}`);
    }
    return parseComposePs(r.stdout).find((c) => c.Service === this.config.mongoService);
  }

  async ensureMongo(): Promise<void> {
    const { mongoService: service, composeProject: project } = this.config;
    const current = await this.mongoContainer();
    if (current?.State === "running") {
      this.state.mongo = "external";
      this.sys.log(`MongoDB (${project}/${service}) is already running; DevFlow will leave it running.`);
    } else {
      this.sys.log(`Starting MongoDB (${project}/${service})…`);
      // --no-recreate: an existing container (and its data volume) is reused, never replaced.
      const r = await this.sys.run("docker", this.composeArgs("up", "--detach", "--no-recreate", service), {
        cwd: this.config.rootDir,
        timeoutMs: this.config.startupTimeoutMs,
      });
      if (r.code !== 0 && this.state.shutdownStarted) {
        this.sys.warn(
          `Starting MongoDB was interrupted; it may or may not be running now, and DevFlow does not treat it as its own. If you don't need it: npm run db:down`,
        );
        throw new StartupError("Startup interrupted by shutdown.");
      }
      if (r.code !== 0) {
        throw new StartupError(
          `Could not start MongoDB: ${(r.stderr || r.error || "").trim()}\nCheck that .env sets MONGO_ROOT_USERNAME and MONGO_ROOT_PASSWORD, and that port 27017 is free.`,
        );
      }
      this.state.mongo = "owned";
    }
    await this.waitFor(
      "MongoDB to become healthy",
      async () => {
        const c = await this.mongoContainer();
        if (c?.State !== "running") return undefined;
        // No health check defined => running is the best available signal.
        return !c.Health || c.Health === "healthy" ? true : undefined;
      },
      `MongoDB did not become healthy within ${Math.round(this.config.startupTimeoutMs / 1000)} s. Inspect it with: npm run db:logs`,
    );
    this.sys.log("MongoDB is ready.");
  }

  private async ollamaTags(): Promise<string | undefined> {
    const r = await this.sys.httpGet(`${this.config.ollamaBaseUrl}/api/tags`, 3_000);
    return r && r.status === 200 ? r.body : undefined;
  }

  private async findOllama(): Promise<string | undefined> {
    if (this.config.ollamaPath) {
      return this.sys.fileExists(this.config.ollamaPath) ? this.config.ollamaPath : undefined;
    }
    const lookup = await this.sys.run(this.sys.platform === "win32" ? "where" : "which", ["ollama"], {
      timeoutMs: 10_000,
    });
    const onPath =
      lookup.code === 0
        ? lookup.stdout
            .split(/\r?\n/)
            .find((l) => l.trim())
            ?.trim()
        : undefined;
    if (onPath) return onPath;
    if (this.sys.platform === "win32" && this.sys.env.LOCALAPPDATA) {
      const standard = path.win32.join(this.sys.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe");
      if (this.sys.fileExists(standard)) return standard;
    }
    return undefined;
  }

  async ensureOllama(): Promise<void> {
    const base = this.config.ollamaBaseUrl;
    let tags = await this.ollamaTags();
    if (tags !== undefined) {
      this.state.ollama = "external";
      this.sys.log(`Ollama is already running at ${base}; DevFlow will leave it running.`);
    } else {
      let url: URL;
      try {
        url = new URL(base);
      } catch {
        throw new StartupError(`OLLAMA_BASE_URL is not a valid URL: ${base}`);
      }
      if (!LOOPBACK_HOSTS.has(url.hostname)) {
        throw new StartupError(
          `Ollama at ${base} is not reachable, and it is not on this machine, so DevFlow cannot start it. Start Ollama on that host or change OLLAMA_BASE_URL.`,
        );
      }
      const exe = await this.findOllama();
      if (!exe) {
        throw new StartupError(
          this.config.ollamaPath
            ? `DEVFLOW_OLLAMA_PATH (${this.config.ollamaPath}) does not exist.`
            : "Ollama is not running and its executable was not found. Install it from https://ollama.com, start it, or set DEVFLOW_OLLAMA_PATH.",
        );
      }
      this.sys.log(`Ollama is not running; starting "${exe} serve"…`);
      const port = url.port || (url.protocol === "https:" ? "443" : "80");
      // Detached: its own process group/console, so a Ctrl+C aimed at the
      // launcher doesn't kill it behind DevFlow's back — it is stopped in
      // cleanup (only because DevFlow owns it) or deliberately left running.
      const child = this.sys.spawn("ollama", exe, ["serve"], {
        env: { OLLAMA_HOST: `${url.hostname}:${port}` },
        detached: true,
      });
      this.state.children.set("ollama", child);
      tags = await this.waitFor(
        "Ollama to become ready",
        async () => {
          const body = await this.ollamaTags();
          if (body !== undefined) return body;
          if (!child.isRunning()) {
            throw new StartupError(
              `The Ollama server DevFlow started exited before it became ready. Try running "ollama serve" yourself to see the error.`,
            );
          }
          return undefined;
        },
        `Ollama did not become ready at ${base} within ${Math.round(this.config.startupTimeoutMs / 1000)} s.`,
      );
      if (child.isRunning()) {
        this.state.ollama = "owned";
        child.onExit((code) => {
          this.state.children.delete("ollama");
          if (!this.state.shutdownStarted) {
            this.sys.warn(
              `The Ollama server DevFlow started exited unexpectedly (code ${code}). AI planning is unavailable until Ollama runs again.`,
            );
          }
        });
      } else {
        // Our process died, yet something answers: another Ollama (e.g. the
        // desktop app) took the port. That one is not ours.
        this.state.children.delete("ollama");
        this.state.ollama = "external";
      }
      this.sys.log("Ollama is ready.");
    }
    if (!modelInstalled(tags, this.config.ollamaModel)) {
      throw new StartupError(
        `The configured model "${this.config.ollamaModel}" is not installed in Ollama at ${base}. DevFlow does not download models automatically. Install it with:\n  ollama pull ${this.config.ollamaModel}\nor set OLLAMA_MODEL in .env to a model you have (list them with: ollama list).`,
      );
    }
    this.sys.log(`Ollama model "${this.config.ollamaModel}" is available.`);
  }

  private startAppProcess(label: "api" | "web", script: string) {
    const child = this.sys.spawn(label, "npm", ["run", script], {
      cwd: this.config.rootDir,
      // npm is a .cmd shim on Windows, which Node only runs through a shell.
      shell: this.sys.platform === "win32",
      detached: this.sys.platform !== "win32",
      env: { FORCE_COLOR: "1" },
      forwardOutput: true,
    });
    this.state.children.set(label, child);
    this.state[label] = "owned";
    child.onExit((code, signal) => {
      this.state.children.delete(label);
      if (!this.state.shutdownStarted) {
        this.sys.error(
          `The ${label === "api" ? "API" : "web"} process exited unexpectedly (${signal ?? `code ${code}`}); stopping DevFlow.`,
        );
        void this.shutdown(`${label} exited`, 1);
      }
    });
    return child;
  }

  /**
   * An app port is adopted as DevFlow's only when it answers like DevFlow.
   * Anything else on the port is someone else's: DevFlow neither adopts it
   * nor stops it, and does not start a second server that would collide.
   */
  private async ensureAppProcess(
    label: "api" | "web",
    port: number,
    url: string,
    isDevFlow: (r: HttpResponse | null) => boolean,
    what: string,
  ): Promise<void> {
    const probe = await this.sys.httpGet(url, 2_000);
    if (isDevFlow(probe)) {
      this.state[label] = "external";
      this.sys.log(
        `DevFlow's ${what} is already running on port ${port}; using it, and it will be left running.`,
      );
      return;
    }
    if (probe || (await this.sys.portInUse(port))) {
      throw new StartupError(
        `Port ${port} is in use by another program that is not DevFlow's ${what} (${
          probe ? `it answered ${url} with HTTP ${probe.status}` : "it does not answer HTTP"
        }). DevFlow will not stop it. Free the port, then start DevFlow again.`,
      );
    }
    this.throwIfStopping();
    const script = label === "api" ? "dev:api" : "dev:web";
    this.sys.log(`Starting the ${what} (npm run ${script})…`);
    this.startAppProcess(label, script);
    await this.waitFor(
      `the ${what}`,
      async () => (isDevFlow(await this.sys.httpGet(url, 2_000)) ? true : undefined),
      `The ${what} did not answer at ${url} within ${Math.round(this.config.startupTimeoutMs / 1000)} s; see the [${label}] output above.`,
    );
    this.sys.log(`${what[0]!.toUpperCase()}${what.slice(1)} is ready.`);
  }

  startApi(): Promise<void> {
    const { apiPort } = this.config;
    return this.ensureAppProcess(
      "api",
      apiPort,
      `http://localhost:${apiPort}/api/health`,
      isDevFlowApiHealth,
      "API",
    );
  }

  startWeb(): Promise<void> {
    const { webPort } = this.config;
    return this.ensureAppProcess("web", webPort, `http://localhost:${webPort}/`, isDevFlowWebPage, "web app");
  }

  // --------------------------------------------------------------- shutdown

  /**
   * Centralised, idempotent cleanup. Repeated calls (a second Ctrl+C, a
   * child exiting during shutdown) return the same in-flight promise.
   */
  shutdown(reason: string, exitCode = 0): Promise<CleanupReport> {
    if (this.cleanupPromise) {
      this.sys.log(`Shutdown already in progress (${reason}); please wait.`);
      return this.cleanupPromise;
    }
    this.state.shutdownStarted = true;
    this.sys.log(`Shutting down (${reason})…`);
    this.cleanupPromise = this.cleanup(exitCode).then((report) => {
      this.cleanupFinished = true;
      this.resolveStopped?.(report.exitCode);
      return report;
    });
    return this.cleanupPromise;
  }

  private async stopChild(label: string, actions: string[]): Promise<boolean> {
    const child = this.state.children.get(label);
    if (!child) return true;
    const outcome = await child.stop(this.config.stopGraceMs);
    this.state.children.delete(label);
    const text = {
      already_stopped: "had already exited",
      stopped: "stopped",
      forced: "did not exit in time; force-stopped",
      still_running: "could NOT be stopped",
    }[outcome];
    actions.push(`${label}: ${text}`);
    this.sys.log(`${label} ${text}.`);
    return outcome !== "still_running";
  }

  private async cleanup(requestedExitCode: number): Promise<CleanupReport> {
    const actions: string[] = [];
    let ok = true;

    // A signal can arrive mid-step (e.g. while "compose up" or a spawn is in
    // flight). Let that step settle first, so anything it started is recorded
    // as owned before cleanup decides what to stop. Polling steps notice the
    // shutdown at their next poll; commands have timeouts.
    if (this.startupPromise && !this.state.startupComplete) {
      this.sys.log("Waiting for the current startup step to finish before cleaning up…");
      await this.startupPromise.catch(() => undefined);
    }

    // 1. The app processes (they may still be using MongoDB/Ollama).
    const appResults = await Promise.all([this.stopChild("web", actions), this.stopChild("api", actions)]);
    ok = appResults.every(Boolean) && ok;

    // 2. MongoDB — only the DevFlow service, only if this launcher started it. Data volume untouched.
    if (this.state.mongo === "owned") {
      if (this.config.stopOwnedMongo) {
        const r = await this.sys.run("docker", this.composeArgs("stop", this.config.mongoService), {
          cwd: this.config.rootDir,
          timeoutMs: 60_000,
        });
        if (r.code === 0) {
          actions.push("mongo: stopped (data volume kept)");
          this.sys.log(
            `MongoDB (${this.config.composeProject}/${this.config.mongoService}) stopped; its data is kept.`,
          );
        } else {
          ok = false;
          actions.push("mongo: stop failed");
          this.sys.error(
            `Could not stop MongoDB: ${(r.stderr || r.error || "").trim()} — stop it with: npm run db:down`,
          );
        }
      } else {
        actions.push("mongo: left running (DEVFLOW_STOP_OWNED_MONGO=false)");
      }
    } else if (this.state.mongo === "external") {
      actions.push("mongo: left running (was already running)");
    }

    // 3. Ollama — only the exact process this launcher started.
    const ollama = this.state.children.get("ollama");
    if (ollama) {
      if (this.config.stopOwnedOllama) {
        ok = (await this.stopChild("ollama", actions)) && ok;
      } else {
        ollama.release();
        this.state.children.delete("ollama");
        actions.push("ollama: left running (DEVFLOW_STOP_OWNED_OLLAMA=false)");
        this.sys.log("Leaving the Ollama server DevFlow started running (DEVFLOW_STOP_OWNED_OLLAMA=false).");
      }
    } else if (this.state.ollama === "external") {
      actions.push("ollama: left running (was already running)");
    }

    // 4. Docker Desktop is never closed by DevFlow.
    if (this.state.docker === "owned") {
      actions.push("docker: left running (Docker Desktop is shared; close it yourself if you want)");
      this.sys.log(
        "Docker Desktop was started by DevFlow and is left running; close it yourself if you like.",
      );
    }

    const exitCode = ok ? requestedExitCode : Math.max(1, requestedExitCode);
    this.sys.log(`Shutdown complete${ok ? "" : " with errors"}.`);
    return { exitCode, actions };
  }

  /**
   * Last resort from the process "exit" handler (synchronous only), when the
   * launcher dies without finishing cleanup: force-stop OUR child processes
   * and, if we started it, the DevFlow MongoDB service.
   */
  emergencyCleanupSync(): void {
    if (this.cleanupFinished) return;
    // Exit listeners must not start a second, asynchronous shutdown now.
    this.state.shutdownStarted = true;
    for (const [label, child] of [...this.state.children]) {
      if (label === "ollama" && !this.config.stopOwnedOllama) continue;
      if (child.isRunning()) child.forceStopSync();
    }
    if (this.state.mongo === "owned" && this.config.stopOwnedMongo) {
      this.sys.runSync("docker", this.composeArgs("stop", this.config.mongoService), {
        cwd: this.config.rootDir,
        timeoutMs: 30_000,
      });
    }
    this.cleanupFinished = true;
  }
}
