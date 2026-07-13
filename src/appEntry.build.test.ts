import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { build, loadEnv } from "vite";

import {
  SOURCE_DEFAULT_APP_GENERATION,
  resolveAppGeneration,
  type AppGeneration,
} from "./appEntry";

interface ManifestEntry {
  file: string;
  css?: string[];
}

const temporaryDirectories: string[] = [];

async function readSelectedBuild(mode: AppGeneration) {
  const root = process.cwd();
  const outDir = await mkdtemp(path.join(tmpdir(), `omniplan-${mode}-`));
  temporaryDirectories.push(outDir);
  await build({
    root,
    mode,
    logLevel: "silent",
    build: {
      outDir,
      emptyOutDir: true,
      manifest: true,
    },
  });
  const env = loadEnv(mode, root, "VITE_OMNIPLAN_");
  const generation = resolveAppGeneration(
    env.VITE_OMNIPLAN_GENERATION,
    SOURCE_DEFAULT_APP_GENERATION,
  );
  const manifest = JSON.parse(
    await readFile(path.join(outDir, ".vite", "manifest.json"), "utf8"),
  ) as Record<string, ManifestEntry>;
  const mainEntry = manifest["index.html"];
  if (mainEntry === undefined) throw new Error("Missing index.html build entry");
  const mainJavascript = await readFile(
    path.join(outDir, mainEntry.file),
    "utf8",
  );
  const source = generation === "v1" ? "src/V1Entry.tsx" : "src/v2/app/entry.tsx";
  const entry = manifest[source];
  if (entry === undefined) throw new Error(`Missing ${source} build entry`);
  const javascript = await readFile(path.join(outDir, entry.file), "utf8");
  const css = (
    await Promise.all(
      (entry.css ?? []).map((file) => readFile(path.join(outDir, file), "utf8")),
    )
  ).join("\n");
  const assetNames = await readdir(path.join(outDir, "assets"));
  const allCss = (
    await Promise.all(
      assetNames
        .filter((file) => file.endsWith(".css"))
        .map((file) => readFile(path.join(outDir, "assets", file), "utf8")),
    )
  ).join("\n");
  return { generation, javascript, mainJavascript, css, allCss, manifest };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("generation-specific build smoke", () => {
  it.each(["v1", "v2"] as const)(
    "builds and identifies the selected %s entry",
    async (mode) => {
      const output = await readSelectedBuild(mode);
      expect(output.generation).toBe(mode);
      expect(output.javascript).toContain(`omni-plan-app-generation:${mode}`);
      expect(output.mainJavascript).toContain("renderApp");
      expect(output.mainJavascript).toContain(
        "OmniPlan root element is missing.",
      );
    },
    30_000,
  );

  it("keeps generation-specific styles isolated", async () => {
    const [v1, v2] = await Promise.all([
      readSelectedBuild("v1"),
      readSelectedBuild("v2"),
    ]);
    expect(v1.css).toContain(".sidebarCollapseButton");
    expect(v2.css).toContain(".v2-app-shell");
    expect(v1.allCss).not.toContain(".v2-app-shell");
    expect(v2.allCss).not.toContain(".sidebarCollapseButton");
    expect(v1.manifest).not.toHaveProperty("src/v2/app/entry.tsx");
    expect(v2.manifest).not.toHaveProperty("src/V1Entry.tsx");
  }, 30_000);
});
