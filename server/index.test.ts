import { describe, expect, it } from "bun:test";
import { createServerRuntime } from "./index";

describe("server transport guard", () => {
  it("rejects plaintext requests when HTTPS is required", async () => {
    const runtime = createServerRuntime({ OMNIPLAN_DB_PATH: ":memory:", OMNIPLAN_REQUIRE_HTTPS: "1" });
    try {
      const response = await runtime.fetch(new Request("http://planner.test/api/health"));
      expect(response.status).toBe(426);
      expect(await response.json()).toEqual({ error: { code: "https_required", message: "Use HTTPS for this service." } });
    } finally {
      runtime.store.close();
    }
  });

  it("trusts the first HTTPS proxy protocol value", async () => {
    const runtime = createServerRuntime({ OMNIPLAN_DB_PATH: ":memory:", OMNIPLAN_REQUIRE_HTTPS: "1" });
    try {
      const response = await runtime.fetch(new Request("http://internal:8787/api/health", {
        headers: { "X-Forwarded-Proto": "https, http" }
      }));
      expect(response.status).toBe(200);
      expect((await response.json()).ok).toBe(true);
    } finally {
      runtime.store.close();
    }
  });
});
