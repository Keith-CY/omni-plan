import {
  defaultFirebaseSyncSettings,
  type AppSettings,
  type FirebaseSyncSettings
} from "./settings";

export interface DeploymentClientConfig {
  firebaseSync: Pick<
    FirebaseSyncSettings,
    "projectId" | "apiKey" | "databaseId" | "collectionPath" | "workspaceId"
  > | null;
}

export async function loadDeploymentClientConfig(
  fetcher: typeof fetch = fetch
): Promise<DeploymentClientConfig | undefined> {
  try {
    const response = await fetcher("/api/client-config", {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (!response.ok) return undefined;
    const value = await response.json() as Partial<DeploymentClientConfig>;
    if (!value.firebaseSync || !validFirebaseConfig(value.firebaseSync)) {
      return { firebaseSync: null };
    }
    return {
      firebaseSync: {
        projectId: value.firebaseSync.projectId.trim(),
        apiKey: value.firebaseSync.apiKey.trim(),
        databaseId: value.firebaseSync.databaseId?.trim() || defaultFirebaseSyncSettings.databaseId,
        collectionPath: value.firebaseSync.collectionPath?.trim() || defaultFirebaseSyncSettings.collectionPath,
        workspaceId: value.firebaseSync.workspaceId?.trim() || defaultFirebaseSyncSettings.workspaceId
      }
    };
  } catch {
    return undefined;
  }
}

export function applyDeploymentClientConfig(
  settings: AppSettings,
  config: DeploymentClientConfig | undefined,
  deviceId: string
): AppSettings {
  const deployment = config?.firebaseSync;
  if (!deployment) return settings;

  const current = settings.firebaseSync;
  const nextFirebase: FirebaseSyncSettings = {
    ...current,
    projectId: current.projectId.trim() || deployment.projectId,
    apiKey: current.apiKey.trim() || deployment.apiKey,
    databaseId: current.databaseId.trim() || deployment.databaseId,
    collectionPath: current.collectionPath.trim() || deployment.collectionPath,
    workspaceId: current.workspaceId.trim() || deployment.workspaceId,
    deviceId: current.deviceId.trim() && current.deviceId !== "current-device"
      ? current.deviceId
      : deviceId
  };

  if (firebaseConfigEqual(current, nextFirebase)) return settings;
  return { ...settings, firebaseSync: nextFirebase };
}

export function browserDeviceId(userAgent: string, randomId: string): string {
  const family = /iphone/i.test(userAgent)
    ? "iphone"
    : /ipad/i.test(userAgent)
      ? "ipad"
      : /macintosh|mac os/i.test(userAgent)
        ? "mac"
        : "browser";
  const suffix = randomId.replace(/[^a-z0-9]/gi, "").slice(0, 10).toLowerCase() || "device";
  return `${family}-${suffix}`;
}

export function friendlyWorkspaceSyncError(error: unknown): string {
  if (error instanceof DOMException && (error.name === "OperationError" || error.name === "DataError")) {
    return "工作区口令不正确；本地数据没有被修改。";
  }
  const message = error instanceof Error ? error.message : "未知错误";
  if (/operationerror|decrypt|decryption|cipher/i.test(message)) {
    return "工作区口令不正确；本地数据没有被修改。";
  }
  return `连接失败：${message}`;
}

function validFirebaseConfig(value: unknown): value is NonNullable<DeploymentClientConfig["firebaseSync"]> {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return typeof config.projectId === "string" && Boolean(config.projectId.trim())
    && typeof config.apiKey === "string" && Boolean(config.apiKey.trim());
}

function firebaseConfigEqual(left: FirebaseSyncSettings, right: FirebaseSyncSettings) {
  return left.projectId === right.projectId
    && left.apiKey === right.apiKey
    && left.databaseId === right.databaseId
    && left.collectionPath === right.collectionPath
    && left.workspaceId === right.workspaceId
    && left.deviceId === right.deviceId;
}
