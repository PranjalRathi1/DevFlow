import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEVFLOW_WEB_TITLE, isDevFlowApiHealth, isDevFlowWebPage, Launcher } from "../lifecycle.js";
import { FakeSystem, makeWorld, testConfig, type World } from "./fakeSystem.js";

// Final-review coverage: port identity, signals during startup, MongoDB
// stop/restart cycles, and the full owned-resource scenario.

function setup(world: Partial<World> = {}, config: Record<string, string> = {}) {
  const sys = new FakeSystem(makeWorld(world));
  return { sys, launcher: new Launcher(testConfig(config), sys) };
}
const compose = (sys: FakeSystem, sub: string) =>
  sys.commands.filter((c) => c.command === "docker" && c.args[0] === "compose" && c.args[7] === sub);
const tick = () => new Promise((r) => setImmediate(r));

describe("port identity: only DevFlow is adopted, nothing unrelated is stopped", () => {
  it("recognises DevFlow's health response and page title, and nothing looser", () => {
    const health = JSON.stringify({ status: "ok", uptimeSeconds: 1, timestamp: "t" });
    expect(isDevFlowApiHealth({ status: 200, body: health })).toBe(true);
    expect(isDevFlowApiHealth({ status: 200, body: "OK" })).toBe(false);
    expect(isDevFlowApiHealth({ status: 200, body: '{"status":"ok"}' })).toBe(false);
    expect(isDevFlowApiHealth({ status: 503, body: health })).toBe(false);
    expect(isDevFlowApiHealth(null)).toBe(false);
    expect(isDevFlowWebPage({ status: 200, body: `<head>${DEVFLOW_WEB_TITLE}</head>` })).toBe(true);
    expect(isDevFlowWebPage({ status: 200, body: "<title>Other</title>" })).toBe(false);
  });

  it("the web marker matches the real apps/web/index.html", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const indexHtml = readFileSync(path.resolve(here, "../../../../apps/web/index.html"), "utf8");
    expect(indexHtml).toContain(DEVFLOW_WEB_TITLE);
  });

  it("an unrelated HTTP server on the API port is neither adopted nor stopped; startup fails clearly", async () => {
    const { sys, launcher } = setup({ apiPortForeign: "http", mongo: { state: "exited", health: "" } });
    expect(await launcher.run()).toBe(1);
    expect(
      sys.logs.some((l) =>
        /Port 4000 is in use by another program that is not DevFlow's API \(it answered .* with HTTP 200\)\. DevFlow will not stop it/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(launcher.state.api).toBe("unknown");
    expect(sys.child("api")).toBeUndefined();
    expect(sys.world.apiPortForeign).toBe("http"); // untouched
    // What DevFlow did start is still cleaned up.
    expect(compose(sys, "stop")).toHaveLength(1);
  });

  it("a non-HTTP program on the API port is detected before starting a colliding server", async () => {
    const { sys, launcher } = setup({ apiPortForeign: "tcp" });
    expect(await launcher.run()).toBe(1);
    expect(sys.logs.some((l) => /Port 4000 .* \(it does not answer HTTP\)/.test(l))).toBe(true);
    expect(sys.child("api")).toBeUndefined();
  });

  it("an unrelated HTTP server on the web port is not treated as the frontend; the owned API is stopped", async () => {
    const { sys, launcher } = setup({ webPortForeign: "http" });
    expect(await launcher.run()).toBe(1);
    expect(
      sys.logs.some((l) => /Port 5173 is in use by another program that is not DevFlow's web app/.test(l)),
    ).toBe(true);
    expect(sys.child("web")).toBeUndefined();
    expect(sys.child("api")?.running).toBe(false);
    expect(sys.world.webPortForeign).toBe("http");
  });

  it("an already-running DevFlow API and web are adopted as external, logged, and never stopped", async () => {
    const { sys, launcher } = setup({ apiUp: true, webUp: true });
    const running = launcher.run();
    await tick();
    await launcher.shutdown("SIGINT");
    expect(await running).toBe(0);
    expect(sys.logs).toContain(
      "DevFlow's API is already running on port 4000; using it, and it will be left running.",
    );
    expect(sys.world.apiUp && sys.world.webUp).toBe(true);
    expect(sys.children).toEqual([]);
  });
});

describe("signals during startup", () => {
  it("a Ctrl+C while 'compose up' is in flight still stops the MongoDB it started, then exits 0", async () => {
    const { sys, launcher } = setup({ mongo: { state: "exited", health: "" } });
    let release!: () => void;
    sys.beforeCommand = async (_c, args) => {
      if (args[7] === "up") await new Promise<void>((r) => (release = r));
    };
    const running = launcher.run();
    await tick();
    expect(compose(sys, "up")).toHaveLength(1); // in flight
    const cleanup = launcher.shutdown("SIGINT");
    await tick();
    expect(compose(sys, "stop")).toEqual([]); // waits for the step to settle
    release();
    const report = await cleanup;
    expect(launcher.state.mongo).toBe("owned");
    expect(compose(sys, "stop")).toHaveLength(1);
    expect(report.actions).toContain("mongo: stopped (data volume kept)");
    expect(await running).toBe(0);
    expect(sys.logs.some((l) => l.startsWith("ERROR"))).toBe(false);
    expect(sys.child("api")).toBeUndefined(); // nothing started after the signal
  });

  it("a Ctrl+C while waiting for Ollama stops the Ollama it spawned and starts nothing more", async () => {
    const { sys, launcher } = setup({ ollamaUp: false });
    // Ollama starts but is not ready yet when the signal arrives.
    const originalSpawn = sys.spawn.bind(sys);
    sys.spawn = (label, command, args, options) => {
      const c = originalSpawn(label, command, args, options);
      if (label === "ollama") sys.world.ollamaUp = false;
      return c;
    };
    sys.sleep = async (ms) => {
      sys.clock += ms;
      void launcher.shutdown("SIGINT");
    };
    const code = await launcher.run();
    expect(code).toBe(0);
    expect(sys.child("ollama")?.running).toBe(false);
    expect(sys.child("api")).toBeUndefined();
  });
});

describe("signal during the API port probe", () => {
  it("does not spawn the API after shutdown has begun", async () => {
    const { sys, launcher } = setup();
    const originalGet = sys.httpGet.bind(sys);
    sys.httpGet = async (url: string) => {
      if (url.endsWith("/api/health") && !launcher.state.shutdownStarted) void launcher.shutdown("SIGINT");
      return originalGet(url);
    };
    expect(await launcher.run()).toBe(0);
    expect(sys.child("api")).toBeUndefined();
  });
});

describe("MongoDB stop / restart cycle (restart: unless-stopped)", () => {
  it("owned: stopped explicitly on exit (Docker keeps an explicitly stopped container stopped), started again next time", async () => {
    const world = makeWorld({ mongo: { state: "exited", health: "" } });
    for (const run of [1, 2]) {
      const sys = new FakeSystem(world);
      const launcher = new Launcher(testConfig(), sys);
      const running = launcher.run();
      await tick();
      expect(launcher.state.mongo, `run ${run}`).toBe("owned");
      await launcher.shutdown("SIGINT");
      expect(await running).toBe(0);
      // Only "stop" — never "kill", "rm", "down", "restart" or a policy change.
      expect(
        sys.commands.filter((c) => c.args[0] === "compose").map((c) => c.args[7]),
        `run ${run}`,
      ).toEqual(["ps", "up", "ps", "stop"]);
      expect(world.mongo.state).toBe("exited");
      expect(world.volumes.has("devflow-mongo-data")).toBe(true);
    }
  });

  it("external: left running across launcher runs, never stopped", async () => {
    const world = makeWorld({ mongo: { state: "running", health: "healthy" } });
    for (const run of [1, 2]) {
      const sys = new FakeSystem(world);
      const launcher = new Launcher(testConfig(), sys);
      const running = launcher.run();
      await tick();
      await launcher.shutdown("SIGINT");
      await running;
      expect(launcher.state.mongo, `run ${run}`).toBe("external");
      expect(compose(sys, "up").concat(compose(sys, "stop")), `run ${run}`).toEqual([]);
      expect(world.mongo.state).toBe("running");
    }
  });

  it("a MongoDB left running by DEVFLOW_STOP_OWNED_MONGO=false is external on the next run", async () => {
    const world = makeWorld({ mongo: { state: "exited", health: "" } });
    const first = new Launcher(testConfig({ DEVFLOW_STOP_OWNED_MONGO: "false" }), new FakeSystem(world));
    const r1 = first.run();
    await tick();
    await first.shutdown("SIGINT");
    await r1;
    const secondSys = new FakeSystem(world);
    const second = new Launcher(testConfig(), secondSys);
    const r2 = second.run();
    await tick();
    await second.shutdown("SIGINT");
    await r2;
    // No ownership carried over: the second run did not start it, so it does not stop it.
    expect(second.state.mongo).toBe("external");
    expect(compose(secondSys, "stop")).toEqual([]);
  });
});

describe("full owned-resource scenario", () => {
  it("starts stopped MongoDB and unavailable Ollama, records ownership only after success, and cleans up only those", async () => {
    const { sys, launcher } = setup({ mongo: { state: "exited", health: "" }, ollamaUp: false });
    const unrelatedBefore = structuredClone(sys.world.unrelatedProcesses);
    const volumesBefore = [...sys.world.volumes];

    // Ownership is not recorded before the start command has succeeded.
    let mongoStateDuringUp: string | undefined;
    sys.beforeCommand = async (_c, args) => {
      if (args[7] === "up") mongoStateDuringUp = launcher.state.mongo;
    };
    let ollamaStateAtSpawn: string | undefined;
    const originalSpawn = sys.spawn.bind(sys);
    sys.spawn = (label, command, args, options) => {
      if (label === "ollama") ollamaStateAtSpawn = launcher.state.ollama;
      return originalSpawn(label, command, args, options);
    };

    const running = launcher.run();
    await tick();
    expect(mongoStateDuringUp).toBe("unknown");
    expect(ollamaStateAtSpawn).toBe("unknown");
    expect(launcher.state).toMatchObject({ mongo: "owned", ollama: "owned", api: "owned", web: "owned" });

    const ollamaChild = sys.child("ollama")!;
    const report = await launcher.shutdown("SIGINT");
    expect(await running).toBe(0);

    expect(compose(sys, "stop").map((c) => c.args.slice(7))).toEqual([["stop", "mongo"]]);
    expect(ollamaChild.stopCalls).toBe(1);
    expect(ollamaChild.running).toBe(false);
    // Unrelated processes and volumes untouched; nothing was stopped by name or PID lookup.
    expect(sys.world.unrelatedProcesses).toEqual(unrelatedBefore);
    expect([...sys.world.volumes]).toEqual(volumesBefore);
    expect(sys.allCommandLines().filter((l) => /taskkill|\bkill\b|pkill|killall/i.test(l))).toEqual([]);
    expect(report.actions).toEqual([
      "web: stopped",
      "api: stopped",
      "mongo: stopped (data volume kept)",
      "ollama: stopped",
    ]);
  });
});
