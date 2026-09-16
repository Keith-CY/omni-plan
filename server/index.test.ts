import { describe, expect, it } from "bun:test";
import { createServerRuntime, publicClientConfig } from "./index";

describe("server transport guard", () => {
  it("derives browser defaults without exposing server secrets", () => {
    expect(publicClientConfig({
      OMNIPLAN_API_ADMIN_TOKEN: "must-not-leak",
      OMNIPLAN_FIREBASE_PROJECT_ID: "project-id",
      OMNIPLAN_FIREBASE_WEB_API_KEY: "public-web-key"
    })).toEqual({
      firebaseSync: {
        projectId: "project-id",
        apiKey: "public-web-key",
        databaseId: "(default)",
        collectionPath: "omniPlanSync",
        workspaceId: "personal"
      }
    });
  });

  it("rejects plaintext requests when HTTPS is required", async () => {
    const runtime = createServerRuntime({ OMNIPLAN_DB_PATH: ":memory:", OMNIPLAN_REQUIRE_HTTPS: "1" });
    try {
      const response = await runtime.fetch(new Request("http://planner.test/api/push/public-key"));
      expect(response.status).toBe(426);
      expect(await response.json()).toEqual({ error: { code: "https_required", message: "Use HTTPS for this service." } });
    } finally {
      runtime.store.close();
    }
  });

  it("allows the unauthenticated health endpoint over container-local HTTP", async () => {
    const runtime = createServerRuntime({ OMNIPLAN_DB_PATH: ":memory:", OMNIPLAN_REQUIRE_HTTPS: "1" });
    try {
      const response = await runtime.fetch(new Request("http://localhost:8787/api/health"));
      expect(response.status).toBe(200);
      expect((await response.json()).ok).toBe(true);
    } finally {
      runtime.store.close();
    }
  });

  it("trusts the first HTTPS proxy protocol value", async () => {
    const runtime = createServerRuntime({
      OMNIPLAN_DB_PATH: ":memory:",
      OMNIPLAN_REQUIRE_HTTPS: "1",
      VAPID_PUBLIC_KEY: "public-key"
    });
    try {
      const response = await runtime.fetch(new Request("http://internal:8787/api/push/public-key", {
        headers: { "X-Forwarded-Proto": "https, http" }
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ publicKey: "public-key" });
    } finally {
      runtime.store.close();
    }
  });
});
