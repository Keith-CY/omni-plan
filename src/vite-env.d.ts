/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OMNIPLAN_GENERATION?: "v1" | "v2";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __OMNIPLAN_BUNDLED_GENERATION__: "v1" | "v2";

declare module "virtual:omniplan-generation-entry" {
  export function renderApp(rootElement: HTMLElement): void;
}
