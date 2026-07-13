import path from "path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

import {
  SOURCE_DEFAULT_APP_GENERATION,
  resolveAppGeneration,
} from "./src/appEntry";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "VITE_OMNIPLAN_");
  const generation = resolveAppGeneration(
    env.VITE_OMNIPLAN_GENERATION,
    SOURCE_DEFAULT_APP_GENERATION,
  );
  const generationEntry =
    generation === "v2" ? "./src/v2/app/entry.tsx" : "./src/V1Entry.tsx";

  return {
    define: {
      __OMNIPLAN_BUNDLED_GENERATION__: JSON.stringify(generation),
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "virtual:omniplan-generation-entry": path.resolve(
          __dirname,
          generationEntry,
        ),
      },
    },
    test: {
      environment: "node",
      globals: true,
      include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
      setupFiles: ["src/v2/app/test/setup.ts"],
    },
  };
});
