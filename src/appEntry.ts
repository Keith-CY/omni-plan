export type AppGeneration = "v1" | "v2";

export const SOURCE_DEFAULT_APP_GENERATION: AppGeneration = "v1";

export interface AppEntryModule {
  renderApp(rootElement: HTMLElement): void;
}

export function resolveAppGeneration(
  envValue: string | undefined,
  sourceDefault: AppGeneration,
): AppGeneration {
  if (envValue === undefined || envValue === "") return sourceDefault;
  if (envValue === "v1" || envValue === "v2") return envValue;
  throw new Error(`Unsupported OmniPlan generation: ${envValue}`);
}

export async function loadGeneration(
  generation: AppGeneration,
): Promise<AppEntryModule> {
  if (generation !== __OMNIPLAN_BUNDLED_GENERATION__) {
    throw new Error(
      `Requested OmniPlan generation ${generation} does not match the bundled ${__OMNIPLAN_BUNDLED_GENERATION__} entry.`,
    );
  }
  return import("virtual:omniplan-generation-entry");
}
