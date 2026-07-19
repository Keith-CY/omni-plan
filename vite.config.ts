import path from "path";
import { execFileSync } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function resolveBuildCommit(): string {
  const environmentCommit = [
    process.env.SOURCE_COMMIT,
    process.env.COOLIFY_GIT_COMMIT_SHA,
    process.env.GIT_COMMIT_SHA,
    process.env.GITHUB_SHA,
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.CF_PAGES_COMMIT_SHA
  ].find((candidate) => candidate?.trim());
  if (environmentCommit) return environmentCommit.trim();

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const buildCommit = resolveBuildCommit();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(buildCommit)
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"]
  }
});
