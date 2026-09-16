import { describe, expect, it } from "vitest";
import { applyDeploymentClientConfig, browserDeviceId, friendlyWorkspaceSyncError, loadDeploymentClientConfig } from "./clientConfig";
import { defaultAppSettings } from "./settings";

describe("deployment client config", () => {
  it("adopts same-origin Firebase transport config on a new browser without enabling sync", async () => {
    const config = await loadDeploymentClientConfig((async () => new Response(JSON.stringify({
      firebaseSync: {
        projectId: "project-from-server",
        apiKey: "public-web-key",
        databaseId: "(default)",
        collectionPath: "omniPlanSync",
        workspaceId: "personal"
      }
    }), { status: 200 })) as unknown as typeof fetch);

    const next = applyDeploymentClientConfig(defaultAppSettings, config, "iphone-1234");

    expect(next.firebaseSync).toMatchObject({
      projectId: "project-from-server",
      apiKey: "public-web-key",
      workspaceId: "personal",
      deviceId: "iphone-1234",
      autoSyncEnabled: false
    });
  });

  it("does not replace an existing browser's Firebase connection", () => {
    const current = {
      ...defaultAppSettings,
      firebaseSync: {
        ...defaultAppSettings.firebaseSync,
        projectId: "existing-project",
        apiKey: "existing-key",
        deviceId: "mac-existing"
      }
    };
    const next = applyDeploymentClientConfig(current, {
      firebaseSync: {
        projectId: "deployment-project",
        apiKey: "deployment-key",
        databaseId: "(default)",
        collectionPath: "omniPlanSync",
        workspaceId: "personal"
      }
    }, "mac-new");

    expect(next).toBe(current);
  });

  it("creates readable per-device identifiers", () => {
    expect(browserDeviceId("Mozilla/5.0 (iPhone)", "ABC-123_DEF")).toBe("iphone-abc123def");
    expect(browserDeviceId("Mozilla/5.0 (Macintosh)", "9f8e7d6c-5b4a")).toBe("mac-9f8e7d6c5b");
  });

  it("turns opaque crypto failures into a useful onboarding error", () => {
    expect(friendlyWorkspaceSyncError(new DOMException("The operation failed", "OperationError"))).toBe("工作区口令不正确；本地数据没有被修改。");
  });
});
