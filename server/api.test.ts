import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createApi, dispatchDueReminders, type PushSender } from "./api";
import { CaptureStore } from "./store";

const fixedNow = new Date("2026-09-16T03:00:00.000Z");
let store: CaptureStore;

beforeEach(() => {
  store = new CaptureStore(":memory:");
});

afterEach(() => {
  store.close();
});

describe("private capture API", () => {
  it("accepts once per idempotency key, then lets the owner acknowledge it", async () => {
    const captureToken = store.createToken("Alfred", "capture", fixedNow.toISOString());
    const ownerToken = store.createToken("Web app", "owner", fixedNow.toISOString());
    const api = createApi({ store, now: () => fixedNow });

    const first = await api(request("/api/captures", "POST", captureToken.token, {
      title: "Record from Alfred",
      source: "alfred"
    }, { "Idempotency-Key": "alfred-1" }));
    const duplicate = await api(request("/api/captures", "POST", captureToken.token, {
      title: "Record from Alfred",
      source: "alfred"
    }, { "Idempotency-Key": "alfred-1" }));

    expect(first?.status).toBe(201);
    expect((await first?.json())?.status).toBe("captured");
    expect(duplicate?.status).toBe(200);
    expect((await duplicate?.json())?.status).toBe("duplicate");

    const pending = await api(request("/api/captures", "GET", ownerToken.token));
    const pendingBody = await pending?.json() as { captures: Array<{ id: string; title: string; source: string }> };
    expect(pendingBody.captures).toHaveLength(1);
    expect(pendingBody.captures[0]).toMatchObject({ title: "Record from Alfred", source: "alfred" });

    const acknowledged = await api(request("/api/captures/ack", "POST", ownerToken.token, { ids: [pendingBody.captures[0].id] }));
    expect(await acknowledged?.json()).toEqual({ acknowledged: 1 });
    expect(store.listCaptures()).toEqual([]);
  });

  it("hashes and revokes per-device tokens", async () => {
    const created = store.createToken("Shortcut", "capture", fixedNow.toISOString());
    const api = createApi({ store, adminToken: "admin-secret", now: () => fixedNow });
    expect(JSON.stringify(store.listTokens())).not.toContain(created.token);

    const revoked = await api(request(`/api/tokens/${created.id}`, "DELETE", "admin-secret"));
    expect(await revoked?.json()).toEqual({ revoked: true });
    const rejected = await api(request("/api/captures", "POST", created.token, { title: "Should fail" }, { "Idempotency-Key": "revoked" }));
    expect(rejected?.status).toBe(401);
  });

  it("enforces body and per-minute limits", async () => {
    const token = store.createToken("Shortcut", "capture", fixedNow.toISOString());
    const api = createApi({ store, now: () => fixedNow, rateLimitPerMinute: 1 });
    expect((await api(request("/api/captures", "POST", token.token, { title: "First" }, { "Idempotency-Key": "one" })))?.status).toBe(201);
    expect((await api(request("/api/captures", "POST", token.token, { title: "Second" }, { "Idempotency-Key": "two" })))?.status).toBe(429);
  });

  it("parses optional local time and effort without teaching the service the workspace time zone", async () => {
    const captureToken = store.createToken("Shortcut", "capture", fixedNow.toISOString());
    const ownerToken = store.createToken("Web app", "owner", fixedNow.toISOString());
    const api = createApi({ store, now: () => fixedNow });

    const stored = await api(request("/api/captures", "POST", captureToken.token, {
      title: "整理报税资料 | 带上去年收据 | 2026-09-18 09:30 | 45m"
    }, { "Idempotency-Key": "shortcut-inline" }));
    expect(stored?.status).toBe(201);

    const pending = await api(request("/api/captures", "GET", ownerToken.token));
    const body = await pending?.json() as { captures: Array<Record<string, unknown>> };
    expect(body.captures[0]).toMatchObject({
      title: "整理报税资料",
      note: "带上去年收据",
      plannedForDate: "2026-09-18",
      localStartTime: "09:30",
      estimateSeconds: 2700,
      source: "shortcut"
    });
    expect(body.captures[0].plannedStart).toBeUndefined();
  });

  it("lets an owner create, inspect, and revoke capture-only device tokens", async () => {
    const owner = store.createToken("Web app", "owner", fixedNow.toISOString());
    const api = createApi({ store, now: () => fixedNow });

    const created = await api(request("/api/capture-tokens", "POST", owner.token, { name: "iPhone Shortcut" }));
    expect(created?.status).toBe(201);
    const createdBody = await created?.json() as { id: string; token: string; scope: string };
    expect(createdBody).toMatchObject({ scope: "capture" });
    expect(createdBody.token).toStartWith("op_capture_");

    const listed = await api(request("/api/capture-tokens", "GET", owner.token));
    const listedBody = await listed?.json() as { tokens: Array<Record<string, unknown>> };
    expect(listedBody.tokens).toHaveLength(1);
    expect(JSON.stringify(listedBody)).not.toContain(createdBody.token);

    const revoked = await api(request(`/api/capture-tokens/${createdBody.id}`, "DELETE", owner.token));
    expect(await revoked?.json()).toEqual({ revoked: true });
    const rejected = await api(request("/api/captures", "POST", createdBody.token, { title: "已撤销" }, { "Idempotency-Key": "revoked-owner-route" }));
    expect(rejected?.status).toBe(401);
  });
});

describe("minimal Web Push service", () => {
  it("stores a minimal reminder and sends a generic notification by default", async () => {
    const owner = store.createToken("Web app", "owner", fixedNow.toISOString());
    const sentPayloads: string[] = [];
    const sender: PushSender = {
      async send(_subscription, payload) {
        sentPayloads.push(payload);
        return { statusCode: 201 };
      }
    };
    const api = createApi({
      store,
      now: () => fixedNow,
      vapidPublicKey: "public-key",
      pushSender: sender
    });

    const subscribed = await api(request("/api/push/subscriptions", "POST", owner.token, {
      endpoint: "https://push.example.test/device",
      expirationTime: null,
      keys: { p256dh: "public-device-key", auth: "auth-secret" }
    }));
    expect(subscribed?.status).toBe(201);

    const reminder = await api(request("/api/reminders/reminder-1", "PUT", owner.token, {
      revision: 2,
      dueAt: "2026-09-16T02:59:00.000Z",
      route: "/#/today/p-omni/task-1",
      taskId: "task-1",
      title: "Private title must stay out",
      showTitle: false
    }));
    expect(reminder?.status).toBe(200);

    const result = await dispatchDueReminders(store, sender, fixedNow);
    expect(result).toMatchObject({ reminders: 1, subscriptions: 1, sent: 1, failed: 0 });
    expect(JSON.parse(sentPayloads[0])).toMatchObject({
      body: "你有一项计划需要关注。打开后可查看详情。",
      taskId: "task-1"
    });
    expect(sentPayloads[0]).not.toContain("Private title must stay out");
    expect((await dispatchDueReminders(store, sender, fixedNow)).sent).toBe(0);
  });

  it("drops expired endpoints and does not expose task descriptions", async () => {
    store.upsertSubscription({ endpoint: "https://push.example.test/gone", keys: { p256dh: "p", auth: "a" } }, fixedNow.toISOString());
    store.upsertReminder({
      id: "reminder-gone",
      revision: 1,
      dueAt: fixedNow.toISOString(),
      route: "/#/today/p-omni",
      showTitle: false,
      cancelled: false
    }, fixedNow.toISOString());
    const sender: PushSender = {
      async send() {
        throw Object.assign(new Error("Gone"), { statusCode: 410 });
      }
    };
    expect(await dispatchDueReminders(store, sender, fixedNow)).toMatchObject({ failed: 1, removed: 1 });
    expect(store.listSubscriptions()).toEqual([]);
  });
});

function request(
  path: string,
  method: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  return new Request(`https://omni.example${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}
