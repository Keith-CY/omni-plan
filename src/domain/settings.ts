import type { ProviderSecret } from "./types";
import type { SecretVaultStorage } from "./secrets";

const SETTINGS_STORAGE_KEY = "omni-plan-personal.settings.v1";

export interface GitHubSyncSettings {
  owner: string;
  repo: string;
  branch: string;
  rootPath: string;
  workspaceId: string;
  deviceId: string;
  tokenSecretId?: string;
  updatedAt?: string;
}

export interface AiProviderSettings {
  id: string;
  provider: "custom-openai-compatible";
  label: string;
  baseUrl: string;
  model: string;
  apiKeySecretId?: string;
  updatedAt?: string;
}

export interface AppSettings {
  schemaVersion: 1;
  githubSync: GitHubSyncSettings;
  aiProviders: AiProviderSettings[];
}

export const defaultGitHubSyncSettings: GitHubSyncSettings = {
  owner: "",
  repo: "",
  branch: "main",
  rootPath: ".omni-plan",
  workspaceId: "personal",
  deviceId: "current-device"
};

export const defaultCustomAiProviderSettings: AiProviderSettings = {
  id: "custom-openai-compatible",
  provider: "custom-openai-compatible",
  label: "Custom OpenAI-compatible",
  baseUrl: "",
  model: ""
};

export const defaultAppSettings: AppSettings = {
  schemaVersion: 1,
  githubSync: defaultGitHubSyncSettings,
  aiProviders: [defaultCustomAiProviderSettings]
};

export class BrowserAppSettingsRepository {
  constructor(private readonly storage: SecretVaultStorage = localStorage) {}

  load(): AppSettings {
    const raw = this.storage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaultAppSettings;
    const parsed = JSON.parse(raw) as AppSettings;
    if (parsed.schemaVersion !== 1) {
      throw new Error(`Unsupported settings schema version ${parsed.schemaVersion}`);
    }
    return {
      schemaVersion: 1,
      githubSync: { ...defaultGitHubSyncSettings, ...parsed.githubSync },
      aiProviders: parsed.aiProviders.length ? parsed.aiProviders : [defaultCustomAiProviderSettings]
    };
  }

  save(settings: AppSettings): void {
    this.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }
}

export function providerSecretSummary(secret?: ProviderSecret): string {
  return secret ? `saved locally as ${secret.id} on ${secret.createdAt.slice(0, 10)}` : "not saved";
}
