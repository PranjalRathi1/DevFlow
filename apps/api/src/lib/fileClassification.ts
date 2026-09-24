import path from "node:path";

/**
 * Deterministic, extension/path-based classification — no file-content
 * inspection, no semantic understanding of what a file actually does.
 * This is a conservative first pass: good enough to group an inventory for
 * human review, not a claim that classification is always correct (a
 * `.json` file classified "configuration" could just as easily be a data
 * fixture — see docs/DEPENDENCY_ENGINE.md-style honesty in
 * docs/IMPLEMENTATION_LOG.md's Batch C1 entry for the documented limits).
 */
export const FILE_CATEGORIES = [
  "source",
  "test",
  "configuration",
  "documentation",
  "asset",
  "generated",
  "dependency",
  "binary",
  "unknown",
] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

// Minimum explicit set per spec — extension-based, not a language-server-
// grade detector. Anything not listed here is "unknown", not guessed.
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".md": "markdown",
  ".mdx": "markdown",
  ".css": "css",
  ".scss": "scss",
};

const DOCUMENTATION_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);
const DOCUMENTATION_BASENAMES = new Set([
  "readme",
  "license",
  "changelog",
  "contributing",
  "authors",
  "notice",
]);

const ASSET_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp4",
  ".mp3",
  ".wav",
  ".pdf",
]);

// Binary-format archives/executables detected by extension only — no
// magic-byte/content sniffing, so a renamed file will be misclassified.
const BINARY_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".class",
  ".jar",
  ".wasm",
  ".node",
]);

const CONFIG_BASENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierignore",
  ".gitignore",
  ".gitattributes",
  ".env.example",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
]);
const CONFIG_EXTENSIONS = new Set([".yml", ".yaml", ".toml", ".ini", ".cfg"]);

const LOCKFILE_BASENAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const GENERATED_DIR_SEGMENTS = new Set(["dist", "build", "coverage", ".next", "out"]);

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".py",
  ".java",
  ".go",
  ".rb",
  ".php",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".rs",
  ".swift",
  ".kt",
  ".css",
  ".scss",
  ".html",
]);

function isTestPath(relativePath: string, basename: string): boolean {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(basename)) return true;
  const segments = relativePath.split(/[\\/]/);
  return segments.some((s) => s === "__tests__" || s === "test" || s === "tests");
}

export interface FileClassification {
  category: FileCategory;
  language: string;
}

/**
 * `relativePath` must already be root-relative (forward or backward
 * slashes both accepted) — this function makes no filesystem calls and
 * doesn't need to.
 */
export function classifyFile(relativePath: string): FileClassification {
  const basename = path.basename(relativePath).toLowerCase();
  const ext = path.extname(basename);
  const language = LANGUAGE_BY_EXTENSION[ext] ?? "unknown";

  if (LOCKFILE_BASENAMES.has(basename)) return { category: "generated", language };
  const segments = relativePath.toLowerCase().split(/[\\/]/);
  if (segments.some((s) => GENERATED_DIR_SEGMENTS.has(s))) return { category: "generated", language };
  if (segments.some((s) => s === "node_modules" || s === "vendor"))
    return { category: "dependency", language };

  if (isTestPath(relativePath, basename)) return { category: "test", language };
  if (
    CONFIG_BASENAMES.has(basename) ||
    CONFIG_EXTENSIONS.has(ext) ||
    /\.config\.[cm]?[jt]s$/.test(basename)
  ) {
    return { category: "configuration", language };
  }
  if (DOCUMENTATION_EXTENSIONS.has(ext) || DOCUMENTATION_BASENAMES.has(path.parse(basename).name)) {
    return { category: "documentation", language };
  }
  if (ASSET_EXTENSIONS.has(ext)) return { category: "asset", language };
  if (BINARY_EXTENSIONS.has(ext)) return { category: "binary", language };
  if (ext === ".json") return { category: "configuration", language };
  if (SOURCE_EXTENSIONS.has(ext)) return { category: "source", language };

  return { category: "unknown", language };
}

const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "vendor",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
]);

/**
 * Name-based (not full-relative-path, not glob) and deliberately
 * case-insensitive — the underlying filesystems this runs against
 * (NTFS, APFS, most real-world usage) are case-insensitive or
 * case-preserving, and a case-sensitive check would silently fail to
 * ignore e.g. a differently-cased `Node_Modules`. This is a documented
 * policy choice, not an oversight.
 */
export function shouldIgnoreDirectory(dirName: string): boolean {
  return IGNORED_DIR_NAMES.has(dirName.toLowerCase());
}
