import type { ProviderSecret } from "./types";
import type { SecretVaultStorage } from "./secrets";

export const APP_SETTINGS_STORAGE_KEY = "omni-plan-personal.settings.v1";

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

export interface FirebaseSyncSettings {
  projectId: string;
  apiKey: string;
  databaseId: string;
  collectionPath: string;
  workspaceId: string;
  deviceId: string;
  autoSyncEnabled: boolean;
  autoSyncIntervalSeconds: number;
  autoPushDebounceSeconds: number;
  lastSyncedRevision?: string;
  lastSyncedChecksum?: string;
  lastPulledAt?: string;
  lastPushedAt?: string;
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
  firebaseSync: FirebaseSyncSettings;
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

export const defaultFirebaseSyncSettings: FirebaseSyncSettings = {
  projectId: "",
  apiKey: "",
  databaseId: "(default)",
  collectionPath: "omniPlanSync",
  workspaceId: "personal",
  deviceId: "current-device",
  autoSyncEnabled: false,
  autoSyncIntervalSeconds: 45,
  autoPushDebounceSeconds: 8
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
  firebaseSync: defaultFirebaseSyncSettings,
  aiProviders: [defaultCustomAiProviderSettings]
};

export class BrowserAppSettingsRepository {
  constructor(private readonly storage: SecretVaultStorage = localStorage) {}

  load(): AppSettings {
    const raw = this.storage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!raw) return defaultAppSettings;
    const parsed = JSON.parse(raw) as AppSettings;
    if (parsed.schemaVersion !== 1) {
      throw new Error(`Unsupported settings schema version ${parsed.schemaVersion}`);
    }
    return {
      schemaVersion: 1,
      githubSync: { ...defaultGitHubSyncSettings, ...parsed.githubSync },
      firebaseSync: { ...defaultFirebaseSyncSettings, ...parsed.firebaseSync },
      aiProviders: parsed.aiProviders?.length ? parsed.aiProviders : [defaultCustomAiProviderSettings]
    };
  }

  save(settings: AppSettings): void {
    this.storage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }
}

export function providerSecretSummary(secret?: ProviderSecret): string {
  return secret ? `saved locally as ${secret.id} on ${secret.createdAt.slice(0, 10)}` : "not saved";
}
