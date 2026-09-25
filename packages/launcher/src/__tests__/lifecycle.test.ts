import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Launcher, modelInstalled, parseComposePs } from "../lifecycle.js";
import { FakeSystem, makeWorld, testConfig, type World } from "./fakeSystem.js";

function setup(world: Partial<World> = {}, config: Record<string, string> = {}) {
  const sys = new FakeSystem(makeWorld(world));
  const launcher = new Launcher(testConfig(config), sys);
  return { sys, launcher };
}

/** Starts, then stops as Ctrl+C would; returns the run() exit code. */
async function startThenStop(launcher: Launcher) {
  const running = launcher.run();
  await new Promise((r) => setImmediate(r));
  expect(launcher.state.startupComplete).toBe(true);
  const report = await launcher.shutdown("SIGINT");
  return { code: await running, report };
}

const composeCalls = (sys: FakeSystem, sub: string) =>
  sys.commands.filter((c) => c.command === "docker" && c.args[0] === "compose" && c.args[7] === sub);

describe("Docker", () => {
  it("does not launch Docker Desktop when Docker is already ready", async () => {
    const { sys, launcher } = setup({ dockerReady: true });
    await launcher.ensureDocker();
    expect(sys.launched).toEqual([]);
    expect(launcher.state.docker).toBe("external");
  });

  it("launches Docker Desktop from the standard location when Docker is not running, and waits for it", async () => {
    const { sys, launcher } = setup({ dockerReady: false, dockerReadyAfterPolls: 3 });
    await launcher.ensureDocker();
    expect(sys.launched).toEqual([
      { command: "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe", args: [] },
    ]);
    expect(launcher.state.docker).toBe("owned");
    expect(sys.clock).toBeGreaterThan(0); // it polled
  });

  it("uses DEVFLOW_DOCKER_DESKTOP_PATH when set, and fails clearly if it does not exist", async () => {
    const { sys, launcher } = setup(
      { dockerReady: false, files: new Set(["D:\\Apps\\Docker Desktop.exe"]) },
      { DEVFLOW_DOCKER_DESKTOP_PATH: "D:\\Apps\\Docker Desktop.exe" },
    );
    await launcher.ensureDocker();
    expect(sys.launched[0]?.command).toBe("D:\\Apps\\Docker Desktop.exe");

    const missing = setup({ dockerReady: false }, { DEVFLOW_DOCKER_DESKTOP_PATH: "D:\\Nope.exe" });
    await expect(missing.launcher.ensureDocker()).rejects.toThrow(
      /DEVFLOW_DOCKER_DESKTOP_PATH \(D:\\Nope\.exe\) does not exist/,
    );
  });

  it("times out with an actionable message when Docker never becomes ready", async () => {
    const { sys, launcher } = setup(
      { dockerReady: false, dockerReadyAfterPolls: Infinity },
      { DEVFLOW_STARTUP_TIMEOUT_MS: "10000", DEVFLOW_POLL_INTERVAL_MS: "1000" },
    );
    await expect(launcher.ensureDocker()).rejects.toThrow(
      /Docker did not become ready within 10 s\. Open Docker Desktop.*DEVFLOW_STARTUP_TIMEOUT_MS/,
    );
    expect(sys.clock).toBeGreaterThanOrEqual(10_000);
  });

  it("explains a missing Docker CLI", async () => {
    const { launcher } = setup({ dockerCli: false, dockerReady: false });
    await expect(launcher.ensureDocker()).rejects.toThrow(
      /Docker CLI was not found.*DEVFLOW_AUTOSTART_DEPENDENCIES=false/,
    );
  });
});

describe("MongoDB", () => {
  it("leaves an already-running service alone: external, never started, never stopped", async () => {
    const { sys, launcher } = setup({ mongo: { state: "running", health: "healthy" } });
    const { code, report } = await startThenStop(launcher);
    expect(code).toBe(0);
    expect(launcher.state.mongo).toBe("external");
    expect(composeCalls(sys, "up")).toEqual([]);
    expect(composeCalls(sys, "stop")).toEqual([]);
    expect(sys.world.mongo.state).toBe("running");
    expect(report.actions).toContain("mongo: left running (was already running)");
  });

  it("starts only the DevFlow service when stopped, and stops only that service on exit", async () => {
    const { sys, launcher } = setup({ mongo: { state: "exited", health: "" } });
    await startThenStop(launcher);
    expect(launcher.state.mongo).toBe("owned");
    const [up] = composeCalls(sys, "up");
    const [stop] = composeCalls(sys, "stop");
    // Explicit project, directory and file: no other Compose project can be touched.
    expect(up?.args).toEqual([
      "compose",
      "--project-name",
      "devflow",
      "--project-directory",
      "C:\\work\\DevFlow",
      "--file",
      path.resolve("C:\\work\\DevFlow", "docker-compose.yml"),
      "up",
      "--detach",
      "--no-recreate",
      "mongo",
    ]);
    expect(stop?.args.slice(0, 7)).toEqual(up?.args.slice(0, 7));
    expect(stop?.args.slice(7)).toEqual(["stop", "mongo"]);
    expect(sys.world.mongo.state).toBe("exited");
  });

  it("waits for an already-running but still-starting service to become healthy", async () => {
    const { sys, launcher } = setup({ mongo: { state: "running", health: "starting" } });
    // Becomes healthy during the first wait between polls.
    sys.sleep = async (ms) => {
      sys.clock += ms;
      sys.world.mongo.health = "healthy";
    };
    const pending = launcher.ensureMongo();
    await pending;
    expect(launcher.state.mongo).toBe("external");
  });

  it("reports a failed start with guidance and marks nothing owned", async () => {
    const { launcher } = setup({ mongo: { state: "none", health: "" }, composeUpFails: true });
    await expect(launcher.ensureMongo()).rejects.toThrow(
      /Could not start MongoDB: port is already allocated\nCheck that \.env/,
    );
    expect(launcher.state.mongo).toBe("unknown");
  });

  it("respects DEVFLOW_STOP_OWNED_MONGO=false", async () => {
    const { sys, launcher } = setup(
      { mongo: { state: "exited", health: "" } },
      { DEVFLOW_STOP_OWNED_MONGO: "false" },
    );
    await startThenStop(launcher);
    expect(composeCalls(sys, "stop")).toEqual([]);
    expect(sys.world.mongo.state).toBe("running");
  });

  it("uses a configured project and service name", async () => {
    const { sys, launcher } = setup(
      { mongo: { state: "exited", health: "" } },
      { DEVFLOW_COMPOSE_PROJECT: "myflow", DEVFLOW_MONGO_SERVICE: "mongo" },
    );
    await launcher.ensureMongo();
    expect(composeCalls(sys, "up")[0]?.args.slice(1, 3)).toEqual(["--project-name", "myflow"]);
  });
});

describe("Ollama", () => {
  it("does not start or stop an Ollama that is already reachable", async () => {
    const { sys, launcher } = setup({ ollamaUp: true });
    const { report } = await startThenStop(launcher);
    expect(launcher.state.ollama).toBe("external");
    expect(sys.child("ollama")).toBeUndefined();
    expect(sys.world.ollamaUp).toBe(true);
    expect(report.actions).toContain("ollama: left running (was already running)");
  });

  it("starts 'ollama serve' when unreachable, owns that exact process, and stops only it", async () => {
    const { sys, launcher } = setup({ ollamaUp: false });
    await launcher.startup();
    const child = sys.child("ollama")!;
    expect(child.command).toBe("C:\\Tools\\Ollama\\ollama.exe");
    expect(child.args).toEqual(["serve"]);
    expect(child.options.env).toEqual({ OLLAMA_HOST: "localhost:11434" });
    expect(child.options.detached).toBe(true);
    expect(launcher.state.ollama).toBe("owned");
    expect(launcher.state.children.get("ollama")).toBe(child);

    await launcher.shutdown("SIGINT");
    expect(child.stopCalls).toBe(1);
    expect(child.running).toBe(false);
  });

  it("never stops an unrelated Ollama: when its own server dies and another answers, it is external", async () => {
    const { sys, launcher } = setup({ ollamaUp: false, ollamaSpawnDies: true });
    // Another Ollama (e.g. the desktop app) comes up on the port meanwhile.
    const original = sys.spawn.bind(sys);
    sys.spawn = (label, command, args, options) => {
      const c = original(label, command, args, options);
      if (label === "ollama") sys.world.ollamaUp = true;
      return c;
    };
    await launcher.ensureOllama();
    expect(launcher.state.ollama).toBe("external");
    expect(launcher.state.children.has("ollama")).toBe(false);
    const report = await launcher.shutdown("SIGINT");
    expect(sys.world.ollamaUp).toBe(true);
    expect(report.actions).toContain("ollama: left running (was already running)");
  });

  it("fails with guidance when the server it started exits before becoming ready", async () => {
    const { launcher } = setup({ ollamaUp: false, ollamaSpawnDies: true });
    await expect(launcher.ensureOllama()).rejects.toThrow(/exited before it became ready/);
  });

  it("fails with 'ollama pull <model>' guidance when the configured model is missing, and never pulls", async () => {
    const { sys, launcher } = setup({ ollamaModels: ["llama3:8b"] }, { OLLAMA_MODEL: "mistral:7b" });
    await expect(launcher.ensureOllama()).rejects.toThrow(
      /"mistral:7b" is not installed.*\n {2}ollama pull mistral:7b/s,
    );
    expect(sys.allCommandLines().some((l) => /\bpull\b/.test(l))).toBe(false);
  });

  it("does not try to start Ollama for a remote OLLAMA_BASE_URL", async () => {
    const { sys, launcher } = setup({ ollamaUp: false }, { OLLAMA_BASE_URL: "http://gpu-box:11434" });
    await expect(launcher.ensureOllama()).rejects.toThrow(/not on this machine/);
    expect(sys.child("ollama")).toBeUndefined();
  });

  it("explains a missing Ollama install", async () => {
    const { launcher } = setup({ ollamaUp: false, ollamaOnPath: undefined });
    await expect(launcher.ensureOllama()).rejects.toThrow(/executable was not found.*DEVFLOW_OLLAMA_PATH/);
  });

  it("leaves its own server running when DEVFLOW_STOP_OWNED_OLLAMA=false", async () => {
    const { sys, launcher } = setup({ ollamaUp: false }, { DEVFLOW_STOP_OWNED_OLLAMA: "false" });
    await startThenStop(launcher);
    const child = sys.child("ollama")!;
    expect(child.stopCalls).toBe(0);
    expect(child.released).toBe(true);
    expect(child.running).toBe(true);
  });

  it("uses the configured host and model, not built-in ones", async () => {
    const { sys, launcher } = setup(
      { ollamaUp: false, ollamaModels: ["phi3:mini"] },
      { OLLAMA_BASE_URL: "http://127.0.0.1:11500", OLLAMA_MODEL: "phi3:mini" },
    );
    await launcher.ensureOllama();
    expect(sys.child("ollama")?.options.env).toEqual({ OLLAMA_HOST: "127.0.0.1:11500" });
  });
});

describe("app processes", () => {
  it("starts the API and web through the existing npm scripts, and stops them first on exit", async () => {
    const { sys, launcher } = setup();
    const { report } = await startThenStop(launcher);
    expect(sys.child("api")?.args).toEqual(["run", "dev:api"]);
    expect(sys.child("web")?.args).toEqual(["run", "dev:web"]);
    expect(sys.child("api")?.options.shell).toBe(true); // npm.cmd on Windows
    expect(report.actions.slice(0, 2).sort()).toEqual(["api: stopped", "web: stopped"]);
  });

  it("does not start a duplicate API or web server when one is already answering", async () => {
    const { sys, launcher } = setup({ apiUp: true, webUp: true });
    const { report } = await startThenStop(launcher);
    expect(sys.children.filter((c) => c.label === "api" || c.label === "web")).toEqual([]);
    expect(launcher.state.api).toBe("external");
    expect(sys.world.apiUp).toBe(true);
    expect(report.actions).not.toContain("api: stopped");
  });

  it("stops DevFlow when the API exits unexpectedly", async () => {
    const { sys, launcher } = setup({ mongo: { state: "exited", health: "" } });
    const running = launcher.run();
    await new Promise((r) => setImmediate(r));
    sys.child("api")!.exit(1);
    expect(await running).toBe(1);
    expect(sys.child("web")?.running).toBe(false);
    expect(composeCalls(sys, "stop")).toHaveLength(1);
  });

  it("reports a force-stopped child", async () => {
    const { sys, launcher } = setup();
    await launcher.startup();
    sys.child("web")!.exitsGracefully = false;
    const report = await launcher.shutdown("SIGINT");
    expect(report.actions).toContain("web: did not exit in time; force-stopped");
    expect(report.exitCode).toBe(0);
  });

  it("treats a child that already exited as cleanly stopped", async () => {
    const { sys, launcher } = setup();
    await launcher.startup();
    const report = await launcher.shutdown("SIGINT");
    // Pretend the stop is asked for again on an already-exited child.
    expect(await sys.child("api")!.stop()).toBe("already_stopped");
    expect(report.exitCode).toBe(0);
  });
});

describe("partial startup and repeated shutdown", () => {
  it("cleans up only what was already started when a later step fails", async () => {
    // Mongo started by DevFlow, Ollama started by DevFlow, then the model is missing.
    const { sys, launcher } = setup({
      mongo: { state: "exited", health: "" },
      ollamaUp: false,
      ollamaModels: [],
    });
    const code = await launcher.run();
    expect(code).toBe(1);
    expect(sys.logs.some((l) => l.startsWith("ERROR") && /ollama pull qwen2\.5:7b/.test(l))).toBe(true);
    expect(sys.child("ollama")?.running).toBe(false);
    expect(composeCalls(sys, "stop")).toHaveLength(1);
    // Never got as far as the app.
    expect(sys.child("api")).toBeUndefined();
  });

  it("does not stop an external MongoDB when a later step fails", async () => {
    const { sys, launcher } = setup({ ollamaUp: false, ollamaOnPath: undefined });
    expect(await launcher.run()).toBe(1);
    expect(composeCalls(sys, "stop")).toEqual([]);
    expect(sys.world.mongo.state).toBe("running");
  });

  it("runs cleanup exactly once for repeated signals", async () => {
    const { sys, launcher } = setup({ mongo: { state: "exited", health: "" }, ollamaUp: false });
    await launcher.startup();
    const [a, b, c] = [
      launcher.shutdown("SIGINT"),
      launcher.shutdown("SIGINT"),
      launcher.shutdown("SIGTERM"),
    ];
    expect(a).toBe(b);
    expect(b).toBe(c);
    await a;
    expect(composeCalls(sys, "stop")).toHaveLength(1);
    expect(sys.child("ollama")?.stopCalls).toBe(1);
    expect(sys.child("api")?.stopCalls).toBe(1);
    expect(sys.logs.filter((l) => l.startsWith("Shutting down"))).toHaveLength(1);
  });

  it("emergency cleanup force-stops only owned processes and the owned service, once", async () => {
    const { sys, launcher } = setup({ mongo: { state: "exited", health: "" }, ollamaUp: false });
    await launcher.startup();
    launcher.emergencyCleanupSync();
    launcher.emergencyCleanupSync();
    for (const label of ["api", "web", "ollama"]) expect(sys.child(label)?.forceStopSyncCalls).toBe(1);
    expect(sys.syncCommands.map((c) => c.args.slice(7).join(" "))).toEqual(["stop mongo"]);
  });

  it("emergency cleanup never stops an external MongoDB or Ollama", async () => {
    const { sys, launcher } = setup({ mongo: { state: "running", health: "healthy" }, ollamaUp: true });
    await launcher.startup();
    launcher.emergencyCleanupSync();
    expect(sys.syncCommands).toEqual([]);
    expect(sys.world.mongo.state).toBe("running");
    expect(sys.world.ollamaUp).toBe(true);
  });

  it("emergency cleanup does nothing after a completed shutdown", async () => {
    const { sys, launcher } = setup({ mongo: { state: "exited", health: "" } });
    await launcher.startup();
    await launcher.shutdown("SIGINT");
    launcher.emergencyCleanupSync();
    expect(sys.syncCommands).toEqual([]);
  });

  it("leaves Docker Desktop running even when DevFlow launched it", async () => {
    const { sys, launcher } = setup({ dockerReady: false });
    const { report } = await startThenStop(launcher);
    expect(launcher.state.docker).toBe("owned");
    expect(report.actions.some((a) => a.startsWith("docker: left running"))).toBe(true);
    expect(sys.allCommandLines().some((l) => /desktop|quit|taskkill/i.test(l))).toBe(false);
  });

  it("manages nothing when DEVFLOW_AUTOSTART_DEPENDENCIES=false", async () => {
    const { sys, launcher } = setup(
      { dockerReady: false, ollamaUp: false },
      { DEVFLOW_AUTOSTART_DEPENDENCIES: "false" },
    );
    await startThenStop(launcher);
    expect(sys.commands.filter((c) => c.command === "docker")).toEqual([]);
    expect(sys.child("ollama")).toBeUndefined();
    expect(launcher.state.mongo).toBe("disabled");
  });
});

describe("data safety", () => {
  const destructive =
    /\bdown\b|\bprune\b|\brm\b|--volumes|(^|\s)-v(\s|$)|\bvolume\b|dropDatabase|\bkill\b.*ollama|\/IM\b/i;

  it("no scenario ever runs a destructive command", async () => {
    const scenarios: [Partial<World>, Record<string, string>][] = [
      [{}, {}],
      [{ mongo: { state: "exited", health: "" }, ollamaUp: false, dockerReady: false }, {}],
      [{ mongo: { state: "none", health: "" } }, {}],
      [{ mongo: { state: "exited", health: "" }, ollamaModels: [] }, {}],
    ];
    for (const [world, config] of scenarios) {
      const { sys, launcher } = setup(world, config);
      const running = launcher.run();
      await new Promise((r) => setImmediate(r));
      await launcher.shutdown("SIGINT");
      await running;
      launcher.emergencyCleanupSync();
      for (const line of sys.allCommandLines()) expect(line).not.toMatch(destructive);
    }
  });

  it("the launcher source contains no volume-deleting, pruning or kill-by-name command", () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    for (const file of ["lifecycle.ts", "system.ts", "cli.ts"]) {
      const source = readFileSync(path.join(dir, file), "utf8");
      expect(source, file).not.toMatch(
        /"down"|"prune"|"-v"|"--volumes"|"rm"|dropDatabase|"\/IM"|killall|pkill/,
      );
    }
  });
});

describe("parsers", () => {
  it("reads both compose ps JSON formats", () => {
    const line = '{"Service":"mongo","State":"running","Health":"healthy"}';
    expect(parseComposePs(`${line}\n`)).toEqual([{ Service: "mongo", State: "running", Health: "healthy" }]);
    expect(parseComposePs(`[${line}]`)).toEqual([{ Service: "mongo", State: "running", Health: "healthy" }]);
    expect(parseComposePs("")).toEqual([]);
  });

  it("matches models with and without the implicit :latest tag", () => {
    const tags = JSON.stringify({ models: [{ name: "qwen2.5:7b" }, { name: "llama3:latest" }] });
    expect(modelInstalled(tags, "qwen2.5:7b")).toBe(true);
    expect(modelInstalled(tags, "llama3")).toBe(true);
    expect(modelInstalled(tags, "qwen2.5")).toBe(false);
    expect(modelInstalled("not json", "qwen2.5:7b")).toBe(false);
  });
});
