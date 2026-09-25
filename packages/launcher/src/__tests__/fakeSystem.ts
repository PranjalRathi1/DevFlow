import type {
  ChildHandle,
  CommandResult,
  HttpResponse,
  SpawnOptions,
  StopOutcome,
  System,
} from "../system.js";
import { loadLauncherConfig, type LauncherConfig } from "../config.js";

/** The simulated machine. Tests set the starting state; commands and spawns change it. */
export interface World {
  dockerCli: boolean;
  dockerReady: boolean;
  /** Polls of `docker info` after Docker Desktop is launched before it reports ready (Infinity = never). */
  dockerReadyAfterPolls: number;
  mongo: { state: "none" | "exited" | "running"; health: "" | "starting" | "healthy" | "unhealthy" };
  composeUpFails: boolean;
  ollamaUp: boolean;
  ollamaModels: string[];
  /** The spawned "ollama serve" exits immediately. */
  ollamaSpawnDies: boolean;
  ollamaOnPath: string | undefined;
  apiUp: boolean;
  webUp: boolean;
  /** Something that is NOT DevFlow holds the API / web port. */
  apiPortForeign: "http" | "tcp" | undefined;
  webPortForeign: "http" | "tcp" | undefined;
  files: Set<string>;
  /** Docker volumes; a "down -v" would remove the project's volume. */
  volumes: Set<string>;
  /** Processes this launcher did not start (e.g. the Ollama desktop app). Nothing may remove them. */
  unrelatedProcesses: { pid: number; name: string }[];
}

export class FakeChild implements ChildHandle {
  running = true;
  stopCalls = 0;
  forceStopSyncCalls = 0;
  released = false;
  /** When false, the process ignores the graceful stop and must be forced. */
  exitsGracefully = true;
  private listeners: ((code: number | null, signal: string | null) => void)[] = [];

  constructor(
    readonly label: string,
    readonly pid: number,
    readonly command: string,
    readonly args: string[],
    readonly options: SpawnOptions,
    private readonly onStopped: () => void,
  ) {}

  isRunning() {
    return this.running;
  }
  onExit(listener: (code: number | null, signal: string | null) => void) {
    if (!this.running) listener(0, null);
    else this.listeners.push(listener);
  }
  exit(code: number | null = 0) {
    if (!this.running) return;
    this.running = false;
    this.onStopped();
    for (const l of this.listeners) l(code, null);
  }
  async stop(): Promise<StopOutcome> {
    this.stopCalls += 1;
    if (!this.running) return "already_stopped";
    const graceful = this.exitsGracefully;
    this.exit(null);
    return graceful ? "stopped" : "forced";
  }
  forceStopSync() {
    this.forceStopSyncCalls += 1;
    this.exit(null);
  }
  release() {
    this.released = true;
  }
}

export function makeWorld(overrides: Partial<World> = {}): World {
  return {
    dockerCli: true,
    dockerReady: true,
    dockerReadyAfterPolls: 2,
    mongo: { state: "running", health: "healthy" },
    composeUpFails: false,
    ollamaUp: true,
    ollamaModels: ["qwen2.5:7b"],
    ollamaSpawnDies: false,
    ollamaOnPath: "C:\\Tools\\Ollama\\ollama.exe",
    apiUp: false,
    webUp: false,
    apiPortForeign: undefined,
    webPortForeign: undefined,
    files: new Set(["C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"]),
    volumes: new Set(["devflow-mongo-data", "someone-elses-volume"]),
    unrelatedProcesses: [
      { pid: 7001, name: "ollama.exe" },
      { pid: 7002, name: "ollama app.exe" },
    ],
    ...overrides,
  };
}

export class FakeSystem implements System {
  readonly platform: NodeJS.Platform = "win32";
  readonly env = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" };
  clock = 0;
  commands: { command: string; args: string[] }[] = [];
  syncCommands: { command: string; args: string[] }[] = [];
  children: FakeChild[] = [];
  launched: { command: string; args: string[] }[] = [];
  logs: string[] = [];
  private dockerPollsSinceLaunch = 0;
  private nextPid = 1000;

  constructor(readonly world: World) {}

  /** Every argv this system was asked to run, joined — for "never ran X" assertions. */
  allCommandLines(): string[] {
    return [...this.commands, ...this.syncCommands].map((c) => [c.command, ...c.args].join(" "));
  }

  /** Test hook: runs before a command's effect, e.g. to hold it "in flight". */
  beforeCommand: ((command: string, args: string[]) => Promise<void>) | undefined;

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.commands.push({ command, args });
    if (this.beforeCommand) await this.beforeCommand(command, args);
    return this.execute(command, args);
  }

  runSync(command: string, args: string[]): CommandResult {
    this.syncCommands.push({ command, args });
    return this.execute(command, args);
  }

  private execute(command: string, args: string[]): CommandResult {
    const w = this.world;
    const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
    if (command === "where" || command === "which") {
      return w.ollamaOnPath ? ok(`${w.ollamaOnPath}\r\n`) : { code: 1, stdout: "", stderr: "not found" };
    }
    if (command !== "docker") return { code: null, stdout: "", stderr: "", error: `spawn ${command} ENOENT` };
    if (!w.dockerCli) return { code: null, stdout: "", stderr: "", error: "spawn docker ENOENT" };
    if (args[0] === "info") {
      if (!w.dockerReady && this.launched.length > 0) {
        this.dockerPollsSinceLaunch += 1;
        if (this.dockerPollsSinceLaunch >= w.dockerReadyAfterPolls) w.dockerReady = true;
      }
      return w.dockerReady
        ? ok("29.0.0")
        : { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    }
    if (args[0] === "compose") {
      const sub = args.slice(7); // after --project-name P --project-directory D --file F
      if (sub[0] === "ps") {
        if (w.mongo.state === "none") return ok("");
        return ok(JSON.stringify({ Service: "mongo", State: w.mongo.state, Health: w.mongo.health }) + "\n");
      }
      if (sub[0] === "up") {
        if (w.composeUpFails) return { code: 1, stdout: "", stderr: "port is already allocated" };
        w.mongo = { state: "running", health: "healthy" };
        return ok();
      }
      if (sub[0] === "down") {
        // What a regression to "down" would do: remove the container, and with -v the data.
        if (sub.includes("-v") || sub.includes("--volumes")) w.volumes.delete("devflow-mongo-data");
        w.mongo = { state: "none", health: "" };
        return ok();
      }
      if (sub[0] === "stop") {
        w.mongo = { state: "exited", health: "" };
        return ok();
      }
    }
    return { code: 1, stdout: "", stderr: `unexpected docker ${args.join(" ")}` };
  }

  spawn(label: string, command: string, args: string[], options: SpawnOptions = {}): ChildHandle {
    const w = this.world;
    const child = new FakeChild(label, this.nextPid++, command, args, options, () => {
      if (label === "ollama") w.ollamaUp = false;
      if (label === "api") w.apiUp = false;
      if (label === "web") w.webUp = false;
    });
    this.children.push(child);
    if (label === "ollama") {
      if (w.ollamaSpawnDies) child.exit(1);
      else w.ollamaUp = true;
    }
    if (label === "api") w.apiUp = true;
    if (label === "web") w.webUp = true;
    return child;
  }

  launchDetached(command: string, args: string[]) {
    this.launched.push({ command, args });
  }

  async httpGet(url: string): Promise<HttpResponse | null> {
    const w = this.world;
    if (url.endsWith("/api/tags")) {
      return w.ollamaUp
        ? { status: 200, body: JSON.stringify({ models: w.ollamaModels.map((name) => ({ name })) }) }
        : null;
    }
    if (url.endsWith("/api/health")) {
      if (w.apiUp) {
        return {
          status: 200,
          body: JSON.stringify({ status: "ok", uptimeSeconds: 5, timestamp: "2026-01-01T00:00:00Z" }),
        };
      }
      // An unrelated web server that happens to answer 200 on this path.
      return w.apiPortForeign === "http" ? { status: 200, body: "OK" } : null;
    }
    if (/:5173\/$/.test(url)) {
      if (w.webUp) return { status: 200, body: "<html><head><title>DevFlow AI</title></head></html>" };
      return w.webPortForeign === "http"
        ? { status: 200, body: "<html><title>Other app</title></html>" }
        : null;
    }
    return null;
  }

  async portInUse(port: number) {
    const w = this.world;
    if (port === 4000) return w.apiUp || w.apiPortForeign !== undefined;
    if (port === 5173) return w.webUp || w.webPortForeign !== undefined;
    return false;
  }

  fileExists(p: string) {
    return this.world.files.has(p);
  }
  async sleep(ms: number) {
    this.clock += ms;
  }
  now() {
    return this.clock;
  }
  log(m: string) {
    this.logs.push(m);
  }
  warn(m: string) {
    this.logs.push(`WARN ${m}`);
  }
  error(m: string) {
    this.logs.push(`ERROR ${m}`);
  }

  child(label: string): FakeChild | undefined {
    return this.children.find((c) => c.label === label);
  }
}

export function testConfig(overrides: Record<string, string> = {}): LauncherConfig {
  return loadLauncherConfig(
    "C:\\work\\DevFlow",
    { OLLAMA_MODEL: "qwen2.5:7b", OLLAMA_BASE_URL: "http://localhost:11434", PORT: "4000", ...overrides },
    {},
  );
}
