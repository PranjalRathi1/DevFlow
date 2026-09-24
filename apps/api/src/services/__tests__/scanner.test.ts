import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { scanDirectory, type ScanLimits } from "../scanner.service.js";

const DEFAULT_LIMITS: ScanLimits = {
  maxFileSizeBytes: 2_000_000,
  maxFiles: 2_000,
  maxDepth: 12,
  maxDirectories: 2_000,
  maxDurationMs: 30_000,
};

const scratchBase = path.join(os.tmpdir(), `devflow-scanner-${randomUUID()}`);

async function write(relative: string, content = ""): Promise<string> {
  const full = path.join(scratchBase, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return full;
}

let canCreateFileSymlinks = false;

beforeAll(async () => {
  await fs.mkdir(scratchBase, { recursive: true });

  // A representative fixture tree — not the user's real project directory.
  await write("main/README.md", "# Fixture project\n");
  await write("main/package.json", '{"name":"fixture"}');
  await write("main/src/index.ts", "export const x = 1;\n");
  await write("main/src/utils/helper.js", "module.exports = {};\n");
  await write("main/src/__tests__/helper.test.ts", "test('x', () => {});\n");
  await write("main/assets/logo.png", "not-a-real-png-but-fine-for-classification");
  await write("main/binary.exe", "not-a-real-binary");
  await write("main/node_modules/somepkg/index.js", "module.exports = {};\n");
  await write("main/.git/HEAD", "ref: refs/heads/main\n");
  await fs.mkdir(path.join(scratchBase, "main/empty-dir"), { recursive: true });

  const probeTarget = await write("probe/target.txt", "x");
  try {
    await fs.symlink(probeTarget, path.join(scratchBase, "probe", "link.txt"), "file");
    canCreateFileSymlinks = true;
  } catch {
    canCreateFileSymlinks = false;
  }
});

afterAll(async () => {
  await fs.rm(scratchBase, { recursive: true, force: true });
});

describe("scanDirectory — classification, ignore policy, determinism", () => {
  it("produces deterministic output across repeated runs", async () => {
    const root = path.join(scratchBase, "main");
    const first = await scanDirectory(root, DEFAULT_LIMITS);
    const second = await scanDirectory(root, DEFAULT_LIMITS);
    // durationMs will differ run to run — compare everything else.
    expect(second.items).toEqual(first.items);
    expect(second.outcome).toEqual(first.outcome);
    expect({ ...second.summary, durationMs: 0 }).toEqual({ ...first.summary, durationMs: 0 });
  });

  it("generates forward-slash root-relative paths regardless of platform", async () => {
    const root = path.join(scratchBase, "main");
    const result = await scanDirectory(root, DEFAULT_LIMITS);
    const helper = result.items.find((i) => i.relativePath === "src/utils/helper.js");
    expect(helper).toBeDefined();
    expect(result.items.some((i) => i.relativePath.includes("\\"))).toBe(false);
  });

  it("classifies files by category and language", async () => {
    const root = path.join(scratchBase, "main");
    const result = await scanDirectory(root, DEFAULT_LIMITS);
    const byPath = new Map(result.items.map((i) => [i.relativePath, i]));

    expect(byPath.get("README.md")).toMatchObject({ category: "documentation", language: "markdown" });
    expect(byPath.get("package.json")).toMatchObject({ category: "configuration", language: "json" });
    expect(byPath.get("src/index.ts")).toMatchObject({ category: "source", language: "typescript" });
    expect(byPath.get("src/utils/helper.js")).toMatchObject({ category: "source", language: "javascript" });
    expect(byPath.get("src/__tests__/helper.test.ts")).toMatchObject({ category: "test" });
    expect(byPath.get("assets/logo.png")).toMatchObject({ category: "asset" });
    expect(byPath.get("binary.exe")).toMatchObject({ category: "binary", language: "unknown" });
  });

  it("ignores node_modules and .git entirely, without descending into them", async () => {
    const root = path.join(scratchBase, "main");
    const result = await scanDirectory(root, DEFAULT_LIMITS);

    const nodeModules = result.items.find((i) => i.relativePath === "node_modules");
    expect(nodeModules).toMatchObject({ status: "skipped", skipReason: "ignored" });
    expect(result.items.some((i) => i.relativePath.startsWith("node_modules/"))).toBe(false);

    const gitDir = result.items.find((i) => i.relativePath === ".git");
    expect(gitDir).toMatchObject({ status: "skipped", skipReason: "ignored" });
    expect(result.items.some((i) => i.relativePath.startsWith(".git/"))).toBe(false);
  });

  it("records an empty directory as scanned, not skipped", async () => {
    const root = path.join(scratchBase, "main");
    const result = await scanDirectory(root, DEFAULT_LIMITS);
    const emptyDir = result.items.find((i) => i.relativePath === "empty-dir");
    expect(emptyDir).toMatchObject({ type: "directory", status: "scanned" });
  });

  it("reports 'completed' outcome only when nothing was skipped or limited", async () => {
    const root = path.join(scratchBase, "main/src/utils");
    const result = await scanDirectory(root, DEFAULT_LIMITS);
    expect(result.outcome).toBe("completed");
    expect(result.summary.totalSkipped).toBe(0);
  });

  it("reports 'completed_with_warnings' when ignored directories were skipped", async () => {
    const root = path.join(scratchBase, "main");
    const result = await scanDirectory(root, DEFAULT_LIMITS);
    expect(result.outcome).toBe("completed_with_warnings");
    expect(result.summary.totalSkipped).toBeGreaterThan(0);
  });

  it("scans a genuinely empty directory as just the root item", async () => {
    const root = path.join(scratchBase, "totally-empty");
    await fs.mkdir(root, { recursive: true });
    const result = await scanDirectory(root, DEFAULT_LIMITS);
    expect(result.items).toEqual([{ relativePath: ".", type: "directory", status: "scanned" }]);
    expect(result.summary.totalScanned).toBe(1);
    expect(result.outcome).toBe("completed");
  });

  it("does not modify any fixture file (read-only guarantee)", async () => {
    const root = path.join(scratchBase, "main");
    const before = await fs.readFile(path.join(root, "src/index.ts"), "utf-8");
    const beforeStat = await fs.stat(path.join(root, "src/index.ts"));
    await scanDirectory(root, DEFAULT_LIMITS);
    const after = await fs.readFile(path.join(root, "src/index.ts"), "utf-8");
    const afterStat = await fs.stat(path.join(root, "src/index.ts"));
    expect(after).toBe(before);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterStat.size).toBe(beforeStat.size);
  });
});

describe("scanDirectory — resource limits", () => {
  it("skips a file exceeding maxFileSizeBytes and records the reason, without adding it to limitsReached", async () => {
    const root = path.join(scratchBase, "size-limit");
    await write("size-limit/big.txt", "x".repeat(100));
    await write("size-limit/small.txt", "x");
    const result = await scanDirectory(root, { ...DEFAULT_LIMITS, maxFileSizeBytes: 10 });
    const big = result.items.find((i) => i.relativePath === "big.txt");
    const small = result.items.find((i) => i.relativePath === "small.txt");
    expect(big).toMatchObject({ status: "skipped", skipReason: "too_large" });
    expect(small).toMatchObject({ status: "scanned" });
    expect(result.summary.limitsReached).not.toContain("maxFileSizeBytes");
  });

  it("stops traversal at maxFiles and records the limit", async () => {
    const root = path.join(scratchBase, "file-limit");
    await write("file-limit/a.txt", "a");
    await write("file-limit/b.txt", "b");
    await write("file-limit/c.txt", "c");
    const result = await scanDirectory(root, { ...DEFAULT_LIMITS, maxFiles: 2 });
    expect(result.items.length).toBe(2);
    expect(result.summary.limitsReached).toContain("maxFiles");
    expect(result.outcome).toBe("completed_with_warnings");
  });

  it("stops descending beyond maxDepth and records the limit", async () => {
    const root = path.join(scratchBase, "depth-limit");
    await write("depth-limit/a/b/c/deep.txt", "x");
    // maxDepth counts directory levels below root, starting at 1 for
    // root's direct children: with maxDepth=1, "a" itself (depth 1) is
    // reached and recorded, but is never descended into, so nothing
    // beneath it is ever discovered.
    const result = await scanDirectory(root, { ...DEFAULT_LIMITS, maxDepth: 1 });
    expect(result.summary.limitsReached).toContain("maxDepth");
    expect(result.items.some((i) => i.relativePath.startsWith("a/"))).toBe(false);
    const aDir = result.items.find((i) => i.relativePath === "a");
    expect(aDir).toMatchObject({ status: "skipped", skipReason: "limit_reached" });
  });

  it("stops visiting further directories at maxDirectories and records the limit", async () => {
    const root = path.join(scratchBase, "dir-limit");
    await write("dir-limit/a/file.txt", "x");
    await write("dir-limit/b/file.txt", "x");
    // The root itself counts as the first "visited" directory, so
    // maxDirectories: 1 means no child directory is ever descended into.
    const result = await scanDirectory(root, { ...DEFAULT_LIMITS, maxDirectories: 1 });
    expect(result.summary.limitsReached).toContain("maxDirectories");
    const aDir = result.items.find((i) => i.relativePath === "a");
    const bDir = result.items.find((i) => i.relativePath === "b");
    expect(aDir).toMatchObject({ status: "skipped", skipReason: "limit_reached" });
    expect(bDir).toMatchObject({ status: "skipped", skipReason: "limit_reached" });
    expect(result.items.some((i) => i.relativePath.includes("file.txt"))).toBe(false);
  });

  it("stops traversal at maxDurationMs and records the limit, without falsely reporting a clean scan", async () => {
    const root = path.join(scratchBase, "duration-limit");
    await write("duration-limit/a.txt", "a");
    await write("duration-limit/b.txt", "b");
    // -1 makes the cooperative check ("elapsed > maxDurationMs") trip
    // deterministically on the very first loop iteration regardless of
    // actual timing (elapsed is always >= 0, and 0 > -1 is always true) —
    // avoids a flaky "hope the fixture is slow enough" test.
    const result = await scanDirectory(root, { ...DEFAULT_LIMITS, maxDurationMs: -1 });
    expect(result.summary.limitsReached).toContain("maxDurationMs");
    expect(result.outcome).toBe("completed_with_warnings");
    // Nothing beyond the root itself was processed before the limit hit.
    expect(result.items).toEqual([{ relativePath: ".", type: "directory", status: "scanned" }]);
  });

  it("reports a failed scan when the root itself cannot be read", async () => {
    const root = path.join(scratchBase, "vanished-root");
    await fs.mkdir(root, { recursive: true });
    await fs.rm(root, { recursive: true, force: true });
    const result = await scanDirectory(root, DEFAULT_LIMITS);
    expect(result.outcome).toBe("failed");
    expect(result.items).toEqual([]);
    expect(result.errorMessage).toBeTruthy();
  });
});

describe("scanDirectory — symlink/junction policy", () => {
  it("skips a directory junction pointing outside the root and does not descend into it", async () => {
    const root = path.join(scratchBase, "junction-fixture");
    const outside = path.join(scratchBase, "junction-outside-target");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "secret.txt"), "should never be reported");
    await fs.symlink(outside, path.join(root, "escape"), "junction");

    const result = await scanDirectory(root, DEFAULT_LIMITS);
    const junctionItem = result.items.find((i) => i.relativePath === "escape");
    expect(junctionItem).toMatchObject({ status: "skipped", skipReason: "symlink" });
    expect(result.items.some((i) => i.relativePath.includes("secret.txt"))).toBe(false);
  });

  it.skipIf(!canCreateFileSymlinks)(
    "skips a file symlink pointing outside the root without reading its target",
    async () => {
      const root = path.join(scratchBase, "filelink-fixture");
      const outside = path.join(scratchBase, "filelink-outside-target");
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      const outsideFile = path.join(outside, "secret.txt");
      await fs.writeFile(outsideFile, "should never be reported");
      await fs.symlink(outsideFile, path.join(root, "link.txt"), "file");

      const result = await scanDirectory(root, DEFAULT_LIMITS);
      const linkItem = result.items.find((i) => i.relativePath === "link.txt");
      expect(linkItem).toMatchObject({ status: "skipped", skipReason: "symlink" });
    },
  );
});
