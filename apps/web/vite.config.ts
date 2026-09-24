import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Read the single monorepo-root .env instead of requiring a duplicate apps/web/.env.
  envDir: path.resolve(dirname, "../.."),
  server: {
    port: 5173,
  },
});
