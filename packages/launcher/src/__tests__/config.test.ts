import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, defaultComposeProject, loadLauncherConfig, parseEnvFile } from "../config.js";

describe("parseEnvFile", () => {
  it("reads KEY=VALUE lines, skipping comments and blanks, honouring quotes", () => {
    expect(
      parseEnvFile(
        [
          "# comment",
          "",
          "OLLAMA_MODEL=qwen2.5:7b",
          'QUOTED="a # not a comment"',
          "TRAILING=value # comment",
          "EMPTY=",
          "URI=mongodb://u:p@localhost:27017/devflow?authSource=admin",
          "export EXPORTED=1",
        ].join("\r\n"),
      ),
    ).toEqual({
      OLLAMA_MODEL: "qwen2.5:7b",
      QUOTED: "a # not a comment",
      TRAILING: "value",
      EMPTY: "",
      URI: "mongodb://u:p@localhost:27017/devflow?authSource=admin",
      EXPORTED: "1",
    });
  });
});

describe("loadLauncherConfig", () => {
  const root = path.resolve("/work/DevFlow");

  it("uses the API's existing settings and safe defaults", () => {
    const c = loadLauncherConfig(
      root,
      { OLLAMA_MODEL: "qwen2.5:7b", OLLAMA_BASE_URL: "http://localhost:11434/", PORT: "4100" },
      {},
    );
    expect(c).toMatchObject({
      autostartDependencies: true,
      composeProject: "devflow",
      composeFile: path.join(root, "docker-compose.yml"),
      mongoService: "mongo",
      stopOwnedMongo: true,
      stopOwnedOllama: true,
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "qwen2.5:7b",
      apiPort: 4100,
      webPort: 5173,
    });
  });

  it("lets the process environment override .env, like dotenv in the API", () => {
    const c = loadLauncherConfig(
      root,
      { OLLAMA_MODEL: "a" },
      { OLLAMA_MODEL: "b", DEVFLOW_AUTOSTART_DEPENDENCIES: "false" },
    );
    expect(c.ollamaModel).toBe("b");
    expect(c.autostartDependencies).toBe(false);
  });

  it("requires OLLAMA_MODEL rather than inventing one", () => {
    expect(() => loadLauncherConfig(root, {}, {})).toThrow(ConfigError);
  });

  it("rejects malformed values with the variable's name", () => {
    expect(() =>
      loadLauncherConfig(root, { OLLAMA_MODEL: "m", DEVFLOW_STOP_OWNED_OLLAMA: "maybe" }, {}),
    ).toThrow(/DEVFLOW_STOP_OWNED_OLLAMA must be true or false/);
    expect(() =>
      loadLauncherConfig(root, { OLLAMA_MODEL: "m", DEVFLOW_STARTUP_TIMEOUT_MS: "5" }, {}),
    ).toThrow(/DEVFLOW_STARTUP_TIMEOUT_MS must be an integer >= 1000/);
  });

  it("derives the project name the way Docker Compose does", () => {
    expect(defaultComposeProject(path.resolve("/x/DevFlow"))).toBe("devflow");
    expect(defaultComposeProject(path.resolve("/x/My Dev.Flow"))).toBe("mydevflow");
  });
});
