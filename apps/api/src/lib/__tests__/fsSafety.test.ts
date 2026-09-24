import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  FsSafetyError,
  isPathInsideRoot,
  resolveSafeChild,
  resolveScanRoot,
  revalidateScanRoot,
} from "../fsSafety.js";

const scratchBase = path.join(os.tmpdir(), `devflow-fssafety-${randomUUID()}`);

// Probed once, for real, on this machine — not assumed. Creating a *file*
// symlink on Windows requires Administrator or Developer Mode; creating a
// directory *junction* does not (a genuinely different NTFS feature). See
// docs/IMPLEMENTATION_LOG.md's Batch C1 entry for what this means for
// coverage: file-symlink-escape tests are real but conditional on the
// environment; junction-escape tests always run on Windows.
let canCreateFileSymlinks = false;

beforeAll(async () => {
  await fs.mkdir(scratchBase, { recursive: true });
  const probeDir = path.join(scratchBase, "probe");
  await fs.mkdir(probeDir, { recursive: true });
  const probeTarget = path.join(probeDir, "target.txt");
  await fs.writeFile(probeTarget, "x");
  try {
    await fs.symlink(probeTarget, path.join(probeDir, "link.txt"), "file");
    canCreateFileSymlinks = true;
  } catch {
    canCreateFileSymlinks = false;
  }
});

afterAll(async () => {
  await fs.rm(scratchBase, { recursive: true, force: true });
});

async function makeDir(name: string): Promise<string> {
  const dir = path.join(scratchBase, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("resolveScanRoot", () => {
  it("accepts a valid, existing directory", async () => {
    const dir = await makeDir(`valid-${randomUUID()}`);
    const resolved = await resolveScanRoot(dir);
    expect(await fs.realpath(dir)).toBe(resolved);
  });

  it("accepts a relative path and resolves it to the same absolute directory", async () => {
    const dir = await makeDir(`relative-${randomUUID()}`);
    const relative = path.relative(process.cwd(), dir);
    const resolved = await resolveScanRoot(relative);
    expect(resolved).toBe(await fs.realpath(dir));
  });

  it("rejects an empty path", async () => {
    await expect(resolveScanRoot("")).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("rejects a nonexistent path", async () => {
    const missing = path.join(scratchBase, `does-not-exist-${randomUUID()}`);
    await expect(resolveScanRoot(missing)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects a file given where a directory is required", async () => {
    const dir = await makeDir(`file-not-dir-${randomUUID()}`);
    const file = path.join(dir, "file.txt");
    await fs.writeFile(file, "x");
    await expect(resolveScanRoot(file)).rejects.toMatchObject({ code: "not_a_directory" });
  });

  it("rejects a UNC path without touching the filesystem", async () => {
    await expect(resolveScanRoot("\\\\server\\share\\project")).rejects.toMatchObject({
      code: "unc_not_supported",
    });
  });

  it("rejects a forward-slash UNC-style path too", async () => {
    await expect(resolveScanRoot("//server/share/project")).rejects.toMatchObject({
      code: "unc_not_supported",
    });
  });

  it("accepts the root itself (an empty directory)", async () => {
    const dir = await makeDir(`empty-${randomUUID()}`);
    const resolved = await resolveScanRoot(dir);
    expect(resolved).toBe(await fs.realpath(dir));
  });
});

describe("isPathInsideRoot", () => {
  it("treats a nested file as inside the root", () => {
    const root = path.join("C:", "Projects", "App");
    const nested = path.join(root, "src", "index.ts");
    expect(isPathInsideRoot(root, nested)).toBe(true);
  });

  it("treats the root itself as inside the root", () => {
    const root = path.join("C:", "Projects", "App");
    expect(isPathInsideRoot(root, root)).toBe(true);
  });

  it("rejects a similarly-prefixed sibling directory (the App vs App-Outside case)", () => {
    const root = path.join("C:", "Projects", "App");
    const sibling = path.join("C:", "Projects", "App-Outside", "file.txt");
    expect(isPathInsideRoot(root, sibling)).toBe(false);
  });

  it("rejects `..` traversal out of the root", () => {
    const root = path.join("C:", "Projects", "App");
    const escaped = path.resolve(root, "..", "Outside", "file.txt");
    expect(isPathInsideRoot(root, escaped)).toBe(false);
  });

  it("rejects an absolute path on a different Windows drive", () => {
    const root = path.join("C:", "Projects", "App");
    const otherDrive = path.join("D:", "Elsewhere", "file.txt");
    expect(isPathInsideRoot(root, otherDrive)).toBe(false);
  });

  it("handles redundant separators and `.` segments consistently", () => {
    const root = path.join("C:", "Projects", "App");
    const messy = path.resolve(root, ".", "src", ".", "index.ts");
    expect(isPathInsideRoot(root, messy)).toBe(true);
  });
});

describe("resolveSafeChild", () => {
  it("resolves a normal child path", async () => {
    const dir = await makeDir(`child-${randomUUID()}`);
    const child = resolveSafeChild(dir, "src");
    expect(child).toBe(path.join(dir, "src"));
  });

  it("throws when a child path escapes the root via `..`", async () => {
    const dir = await makeDir(`escape-${randomUUID()}`);
    expect(() => resolveSafeChild(dir, "../outside")).toThrow(FsSafetyError);
  });
});

describe("revalidateScanRoot (scan-time re-validation of an already-canonical path)", () => {
  it("accepts a directory that is unchanged since configuration", async () => {
    const dir = await makeDir(`revalidate-ok-${randomUUID()}`);
    const result = await revalidateScanRoot(dir);
    expect(result).toBe(dir);
  });

  it("rejects a path that no longer exists (deleted since configuration)", async () => {
    const dir = await makeDir(`revalidate-deleted-${randomUUID()}`);
    await fs.rm(dir, { recursive: true, force: true });
    await expect(revalidateScanRoot(dir)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects a path that is now a file instead of a directory", async () => {
    const parent = await makeDir(`revalidate-file-${randomUUID()}`);
    const nowAFile = path.join(parent, "was-a-dir");
    await fs.writeFile(nowAFile, "x");
    await expect(revalidateScanRoot(nowAFile)).rejects.toMatchObject({ code: "not_a_directory" });
  });

  it("rejects a path that has been replaced by a directory junction since configuration (does not silently follow it)", async () => {
    const parent = await makeDir(`revalidate-junction-parent-${randomUUID()}`);
    const originalPath = path.join(parent, "configured-root");
    await fs.mkdir(originalPath, { recursive: true });

    // Simulate what "the configured directory was later replaced by a
    // symlink" looks like: remove the real directory and put a junction
    // at the exact same path, pointing somewhere else entirely.
    const elsewhere = await makeDir(`revalidate-junction-target-${randomUUID()}`);
    await fs.writeFile(path.join(elsewhere, "unexpected.txt"), "should never be scanned");
    await fs.rmdir(originalPath);
    await fs.symlink(elsewhere, originalPath, "junction");

    await expect(revalidateScanRoot(originalPath)).rejects.toMatchObject({ code: "root_changed" });
  });
});

describe("symlink and junction escape detection (via lstat, as the scanner uses it)", () => {
  it("a directory junction pointing outside the root is detected as a symlink by lstat", async () => {
    const root = await makeDir(`junction-root-${randomUUID()}`);
    const outside = await makeDir(`junction-outside-${randomUUID()}`);
    const junctionPath = path.join(root, "escape");
    await fs.symlink(outside, junctionPath, "junction");

    const lst = await fs.lstat(junctionPath);
    expect(lst.isSymbolicLink()).toBe(true);
  });

  it.skipIf(!canCreateFileSymlinks)(
    "a file symlink pointing outside the root is detected as a symlink by lstat",
    async () => {
      const root = await makeDir(`filelink-root-${randomUUID()}`);
      const outsideDir = await makeDir(`filelink-outside-${randomUUID()}`);
      const outsideFile = path.join(outsideDir, "secret.txt");
      await fs.writeFile(outsideFile, "outside content");
      const linkPath = path.join(root, "link.txt");
      await fs.symlink(outsideFile, linkPath, "file");

      const lst = await fs.lstat(linkPath);
      expect(lst.isSymbolicLink()).toBe(true);
    },
  );
});
