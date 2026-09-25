import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Everything the launcher does to the machine goes through this interface,
 * so the lifecycle logic (lifecycle.ts) is tested with a fake and never
 * touches the user's Docker, MongoDB or Ollama during tests.
 */

export interface CommandResult {
  /** null when the command could not be started at all (e.g. not installed). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not be started (ENOENT etc.) or timed out. */
  error?: string | undefined;
}

export type StopOutcome = "already_stopped" | "stopped" | "forced" | "still_running";

/** A process this launcher spawned. Holding the handle is the proof of ownership. */
export interface ChildHandle {
  readonly label: string;
  readonly pid: number | undefined;
  isRunning(): boolean;
  /** Called once, when the process exits (or fails to spawn). */
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  /** Graceful stop of THIS process and its descendants, then forced after `graceMs`. */
  stop(graceMs: number): Promise<StopOutcome>;
  /** Last-resort synchronous forced stop (process "exit" handler). */
  forceStopSync(): void;
  /** Let the launcher exit without waiting for this process (it keeps running). */
  release(): void;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Run through the platform shell (needed for npm on Windows). */
  shell?: boolean;
  /** Own process group / console: not reached by the launcher's Ctrl+C. */
  detached?: boolean;
  /** Prefix and forward the child's output to the launcher's console. */
  forwardOutput?: boolean;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export interface System {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  run(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<CommandResult>;
  runSync(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }): CommandResult;
  spawn(label: string, command: string, args: string[], options?: SpawnOptions): ChildHandle;
  /** Start an application and do not track it (used only for Docker Desktop). */
  launchDetached(command: string, args: string[]): void;
  /** null = nothing answered (connection refused, timeout, DNS failure). */
  httpGet(url: string, timeoutMs: number): Promise<HttpResponse | null>;
  /** Does anything accept TCP connections on localhost:port (IPv4 or IPv6)? */
  portInUse(port: number): Promise<boolean>;
  fileExists(filePath: string): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const PREFIX = "[devflow]";

function forwardLines(label: string, stream: NodeJS.ReadableStream | null, write: (s: string) => void) {
  if (!stream) return;
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) write(`[${label}] ${line}\n`);
  });
  stream.on("end", () => {
    if (pending) write(`[${label}] ${pending}\n`);
  });
}

class NodeChildHandle implements ChildHandle {
  private exited = false;
  private readonly listeners: ((code: number | null, signal: string | null) => void)[] = [];
  private exitInfo: [number | null, string | null] | undefined;

  constructor(
    readonly label: string,
    private readonly child: ChildProcess,
    private readonly platform: NodeJS.Platform,
    private readonly detached: boolean,
  ) {
    const finish = (code: number | null, signal: string | null) => {
      if (this.exited) return;
      this.exited = true;
      this.exitInfo = [code, signal];
      for (const l of this.listeners) l(code, signal);
    };
    child.once("exit", (code, signal) => finish(code, signal));
    child.once("error", () => finish(null, null));
  }

  get pid() {
    return this.child.pid;
  }

  isRunning() {
    return !this.exited && this.child.pid !== undefined;
  }

  onExit(listener: (code: number | null, signal: string | null) => void) {
    if (this.exitInfo) listener(...this.exitInfo);
    else this.listeners.push(listener);
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (!this.isRunning()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(!this.isRunning()), ms);
      this.onExit(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private signalTree(force: boolean) {
    const pid = this.child.pid;
    if (pid === undefined || !this.isRunning()) return;
    if (this.platform === "win32") {
      // /T = this process and the processes it started; only ever by OUR pid.
      spawnSync("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      try {
        // Detached children lead their own process group; signal the group.
        process.kill(this.detached ? -pid : pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }

  async stop(graceMs: number): Promise<StopOutcome> {
    if (!this.isRunning()) return "already_stopped";
    this.signalTree(false);
    if (await this.waitForExit(graceMs)) return "stopped";
    this.signalTree(true);
    return (await this.waitForExit(5_000)) ? "forced" : "still_running";
  }

  forceStopSync() {
    this.signalTree(true);
  }

  release() {
    this.child.unref();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }
}

export function createNodeSystem(): System {
  const platform = process.platform;
  return {
    platform,
    env: process.env,
    run(command, args, options = {}) {
      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const done = (r: CommandResult) => {
          if (!settled) {
            settled = true;
            resolve(r);
          }
        };
        let child: ChildProcess;
        try {
          child = spawn(command, args, { cwd: options.cwd, windowsHide: true });
        } catch (err) {
          done({ code: null, stdout, stderr, error: (err as Error).message });
          return;
        }
        const timer =
          options.timeoutMs !== undefined
            ? setTimeout(() => {
                child.kill();
                done({ code: null, stdout, stderr, error: `timed out after ${options.timeoutMs} ms` });
              }, options.timeoutMs)
            : undefined;
        child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
        child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
        child.once("error", (err) => {
          if (timer) clearTimeout(timer);
          done({ code: null, stdout, stderr, error: err.message });
        });
        child.once("close", (code) => {
          if (timer) clearTimeout(timer);
          done({ code, stdout, stderr });
        });
      });
    },
    runSync(command, args, options = {}) {
      const r = spawnSync(command, args, {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        encoding: "utf8",
        windowsHide: true,
      });
      return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error?.message };
    },
    spawn(label, command, args, options = {}) {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        shell: options.shell ?? false,
        detached: options.detached ?? false,
        windowsHide: true,
        stdio: [
          "ignore",
          options.forwardOutput ? "pipe" : "ignore",
          options.forwardOutput ? "pipe" : "ignore",
        ],
      });
      if (options.forwardOutput) {
        forwardLines(label, child.stdout, (s) => process.stdout.write(s));
        forwardLines(label, child.stderr, (s) => process.stderr.write(s));
      }
      return new NodeChildHandle(label, child, platform, options.detached ?? false);
    },
    launchDetached(command, args) {
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
      child.on("error", () => undefined);
      child.unref();
    },
    httpGet(url, timeoutMs) {
      return new Promise((resolve) => {
        const lib = url.startsWith("https:") ? https : http;
        const req = lib.get(url, { timeout: timeoutMs }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (d: string) => {
            if (body.length < 1_000_000) body += d;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          res.on("error", () => resolve(null));
        });
        req.on("timeout", () => req.destroy());
        req.on("error", () => resolve(null));
      });
    },
    portInUse(port) {
      const tryHost = (host: string) =>
        new Promise<boolean>((resolve) => {
          const socket = net.connect({ port, host, timeout: 1_500 });
          const done = (inUse: boolean) => {
            socket.destroy();
            resolve(inUse);
          };
          socket.once("connect", () => done(true));
          socket.once("timeout", () => done(false));
          socket.once("error", () => done(false));
        });
      return Promise.all([tryHost("127.0.0.1"), tryHost("::1")]).then(([v4, v6]) => v4 || v6);
    },
    fileExists: (p) => existsSync(p),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (m) => console.log(`${PREFIX} ${m}`),
    warn: (m) => console.warn(`${PREFIX} ${m}`),
    error: (m) => console.error(`${PREFIX} ${m}`),
  };
}
