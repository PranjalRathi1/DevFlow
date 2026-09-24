import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fsReal } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Deterministic fault injection, not a race condition: real `fs` calls are
// used for everything except the exact path(s) a given test targets, which
// are made to fail on demand. This is what the batch's own instructions
// call for — "mid-traversal failures using deterministic mocks... do not
// rely only on a whole-root failure test" and "do not create flaky
// race-condition tests unless there is no reliable alternative."
const failingLstatPaths = new Set<string>();
const failingReaddirPaths = new Set<string>();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      lstat: vi.fn((p: string, ...rest: unknown[]) => {
        if (failingLstatPaths.has(p)) {
          return Promise.reject(Object.assign(new Error("Injected lstat failure"), { code: "EACCES" }));
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (actual.promises.lstat as any)(p, ...rest);
      }),
      readdir: vi.fn((p: string, ...rest: unknown[]) => {
        if (failingReaddirPaths.has(p)) {
          return Promise.reject(Object.assign(new Error("Injected readdir failure"), { code: "EACCES" }));
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (actual.promises.readdir as any)(p, ...rest);
      }),
    },
  };
});

const { scanDirectory } = await import("../scanner.service.js");

const DEFAULT_LIMITS = {
  maxFileSizeBytes: 2_000_000,
  maxFiles: 2_000,
  maxDepth: 12,
  maxDirectories: 2_000,
  maxDurationMs: 30_000,
};

const scratchBase = path.join(os.tmpdir(), `devflow-scanner-errors-${randomUUID()}`);

beforeAll(async () => {
  await fsReal.mkdir(scratchBase, { recursive: true });
});

afterEach(() => {
  failingLstatPaths.clear();
  failingReaddirPaths.clear();
});

afterAll(async () => {
  await fsReal.rm(scratchBase, { recursive: true, force: true });
});

async function newRoot(prefix: string): Promise<string> {
  const root = path.join(scratchBase, `${prefix}-${randomUUID()}`);
  await fsReal.mkdir(root, { recursive: true });
  return root;
}

async function writeIn(root: string, relative: string, content = ""): Promise<string> {
  const full = path.join(root, relative);
  await fsReal.mkdir(path.dirname(full), { recursive: true });
  await fsReal.writeFile(full, content);
  return full;
}

describe("scanDirectory — mid-traversal failures (deterministically injected)", () => {
  it("records one file's lstat failure as an error item and still scans its siblings", async () => {
    const root = await newRoot("lstat-fail");
    await writeIn(root, "a.txt", "a");
    const vanished = await writeIn(root, "b.txt", "b");
    await writeIn(root, "c.txt", "c");

    failingLstatPaths.add(vanished);

    const result = await scanDirectory(root, DEFAULT_LIMITS);

    const bItem = result.items.find((i) => i.relativePath === "b.txt");
    expect(bItem).toMatchObject({ status: "error", errorCategory: "read_error" });
    expect(bItem?.errorMessage).toBe("Permission denied");
    // Siblings were not aborted by b.txt's failure.
    expect(result.items.find((i) => i.relativePath === "a.txt")).toMatchObject({ status: "scanned" });
    expect(result.items.find((i) => i.relativePath === "c.txt")).toMatchObject({ status: "scanned" });
    expect(result.summary.totalErrors).toBe(1);
    expect(result.outcome).toBe("completed_with_warnings");
  });

  it("never leaks the injected error's raw message or path into the recorded item", async () => {
    const root = await newRoot("lstat-safe-msg");
    const target = await writeIn(root, "secret.txt", "x");
    failingLstatPaths.add(target);

    const result = await scanDirectory(root, DEFAULT_LIMITS);
    const item = result.items.find((i) => i.relativePath === "secret.txt");
    expect(item?.errorMessage ?? "").not.toContain("Injected");
    expect(item?.errorMessage ?? "").not.toContain(root);
  });

  it("records a nested directory becoming inaccessible as an error and still scans sibling directories", async () => {
    const root = await newRoot("readdir-fail");
    await writeIn(root, "inaccessible/deep.txt", "x");
    await writeIn(root, "accessible/fine.txt", "x");
    const inaccessibleDir = path.join(root, "inaccessible");
    failingReaddirPaths.add(inaccessibleDir);

    const result = await scanDirectory(root, DEFAULT_LIMITS);

    const dirItem = result.items.find((i) => i.relativePath === "inaccessible");
    expect(dirItem).toMatchObject({ status: "error", errorCategory: "read_error", type: "directory" });
    // Its contents were never discovered, but that's not the same as the
    // whole scan failing — the sibling directory's contents are still
    // reported normally.
    expect(result.items.some((i) => i.relativePath === "inaccessible/deep.txt")).toBe(false);
    expect(result.items.find((i) => i.relativePath === "accessible/fine.txt")).toMatchObject({
      status: "scanned",
    });
    expect(result.summary.totalErrors).toBe(1);
    expect(result.outcome).toBe("completed_with_warnings");
    // Exactly one record for "inaccessible" — never a "scanned" item
    // followed by a second "error" item for the same path.
    expect(result.items.filter((i) => i.relativePath === "inaccessible")).toHaveLength(1);
  });

  it("a scan with only mid-traversal errors is never reported as a clean 'completed' outcome", async () => {
    const root = await newRoot("outcome-check");
    const target = await writeIn(root, "only-file.txt", "x");
    failingLstatPaths.add(target);

    const result = await scanDirectory(root, DEFAULT_LIMITS);
    expect(result.outcome).not.toBe("completed");
    expect(result.outcome).toBe("completed_with_warnings");
  });
});
