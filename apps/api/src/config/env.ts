import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

// A single .env at the monorepo root covers both apps. Load it explicitly
// (rather than relying on dotenv/config's cwd guess) so `npm run dev
// --workspace apps/api` — which sets cwd to apps/api — still finds it.
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z
    .string()
    .min(1)
    .regex(/^mongodb(\+srv)?:\/\//, "MONGODB_URI must start with mongodb:// or mongodb+srv://")
    .default("mongodb://localhost:27017/devflow"),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  // Required, no default: the app must refuse to boot with a missing or
  // weak signing secret rather than silently signing tokens with something
  // guessable. See docs/DECISIONS.md ADR-007.
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_ACCESS_TTL: z.string().default("1h"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  // Auth-specific brute-force protection for /api/auth/register and
  // /api/auth/login — not a general API rate limit (that's a Phase 10
  // concern if/when it's needed).
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AI_PROVIDER: z.enum(["ollama"]).default("ollama"),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("qwen2.5:7b"),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Read-only project scanner limits (Batch C1) — see
  // apps/api/src/services/scanner.service.ts and docs/DECISIONS.md.
  // Deliberately bounded defaults, not "large enough to make tests pass":
  // a synchronous, single-request scan must finish in reasonable time.
  SCAN_MAX_FILE_SIZE_BYTES: z.coerce.number().int().positive().default(2_000_000),
  SCAN_MAX_FILES: z.coerce.number().int().positive().default(2_000),
  SCAN_MAX_DEPTH: z.coerce.number().int().positive().default(12),
  SCAN_MAX_DIRECTORIES: z.coerce.number().int().positive().default(2_000),
  SCAN_MAX_DURATION_MS: z.coerce.number().int().positive().default(30_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error("Environment validation failed — see errors above.");
}

export const env = parsed.data;
export type Env = typeof env;
