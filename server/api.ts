import { timingSafeEqual } from "node:crypto";
import type { CapturePayload, CaptureStore, ReminderEnvelope, StoredSubscription, TokenScope } from "./store";
import { parseCaptureText } from "./captureText";

export interface PushSender {
  send(subscription: StoredSubscription, payload: string): Promise<{ statusCode?: number }>;
}

export interface ApiOptions {
  store: CaptureStore;
  adminToken?: string;
  cronToken?: string;
  vapidPublicKey?: string;
  pushSender?: PushSender;
  now?: () => Date;
  rateLimitPerMinute?: number;
}

export function createApi(options: ApiOptions) {
  const now = options.now ?? (() => new Date());

  return async function handleApi(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return undefined;

    try {
      if (request.method === "OPTIONS") return response(null, 204);
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({ ok: true, service: "omni-plan-personal", time: now().toISOString() });
      }
      if (request.method === "GET" && url.pathname === "/api/push/public-key") {
        if (!options.vapidPublicKey) return problem(503, "push_not_configured", "Web Push is not configured on this server.");
        return json({ publicKey: options.vapidPublicKey });
      }

      if (url.pathname === "/api/tokens" && request.method === "POST") {
        if (!adminAuthorized(request, options.adminToken)) return unauthorized();
        const body = await jsonBody(request, 4_096) as { name?: unknown; scope?: unknown };
        const scope = body.scope === "owner" ? "owner" : body.scope === "capture" ? "capture" : undefined;
        if (!scope) return problem(400, "invalid_scope", "Token scope must be capture or owner.");
        const created = options.store.createToken(text(body.name, 80) || "Unnamed device", scope, now().toISOString());
        return json({ ...created, warning: "This token is shown once. Store it in the device keychain." }, 201);
      }
      if (url.pathname === "/api/tokens" && request.method === "GET") {
        if (!adminAuthorized(request, options.adminToken)) return unauthorized();
        return json({ tokens: options.store.listTokens() });
      }
      if (url.pathname === "/api/tokens" && request.method === "DELETE") {
        if (!adminAuthorized(request, options.adminToken)) return unauthorized();
        return json({ revoked: options.store.revokeAllCaptureTokens(now().toISOString()) });
      }
      const tokenId = /^\/api\/tokens\/([^/]+)$/.exec(url.pathname)?.[1];
      if (tokenId && request.method === "DELETE") {
        if (!adminAuthorized(request, options.adminToken)) return unauthorized();
        return json({ revoked: options.store.revokeToken(decodeURIComponent(tokenId), now().toISOString()) });
      }

      if (url.pathname === "/api/capture-tokens" && request.method === "POST") {
        const auth = deviceAuthorized(request, options.store, ["owner"], now().toISOString());
        if (!auth) return unauthorized();
        const body = await jsonBody(request, 4_096) as { name?: unknown };
        const created = options.store.createToken(text(body.name, 80) || "External capture", "capture", now().toISOString());
        return json({ ...created, warning: "This token is shown once. Store it in the device keychain." }, 201);
      }
      if (url.pathname === "/api/capture-tokens" && request.method === "GET") {
        const auth = deviceAuthorized(request, options.store, ["owner"], now().toISOString());
        if (!auth) return unauthorized();
        return json({ tokens: options.store.listTokens().filter((token) => token.scope === "capture") });
      }
      if (url.pathname === "/api/capture-tokens" && request.method === "DELETE") {
        const auth = deviceAuthorized(request, options.store, ["owner"], now().toISOString());
        if (!auth) return unauthorized();
        return json({ revoked: options.store.revokeAllCaptureTokens(now().toISOString()) });
      }
      const captureTokenId = /^\/api\/capture-tokens\/([^/]+)$/.exec(url.pathname)?.[1];
      if (captureTokenId && request.method === "DELETE") {
        const auth = deviceAuthorized(request, options.store, ["owner"], now().toISOString());
        if (!auth) return unauthorized();
        const target = options.store.listTokens().find((token) => token.id === decodeURIComponent(captureTokenId) && token.scope === "capture");
        return json({ revoked: target ? options.store.revokeToken(target.id, now().toISOString()) : false });
      }

      if (url.pathname === "/api/captures" && request.method === "POST") {
        const auth = deviceAuthorized(request, options.store, ["capture", "owner"], now().toISOString());
        if (!auth) return unauthorized();
        if (!options.store.takeRateLimit(auth.id, options.rateLimitPerMinute ?? 30, now())) {
          return problem(429, "rate_limited", "Too many captures. Retry after one minute.", { "Retry-After": "60" });
        }
        const body = await jsonBody(request, 16_384) as Record<string, unknown>;
        const idempotencyKey = text(request.headers.get("Idempotency-Key") ?? body.idempotencyKey, 200);
        if (!idempotencyKey) return problem(400, "idempotency_required", "Send a stable Idempotency-Key header.");
        const payload = capturePayload(body);
        if (!payload) return problem(400, "invalid_capture", "A non-empty title is required and optional fields must be valid.");
        const result = options.store.storeCapture(auth.id, idempotencyKey, payload, now());
        return json({
          status: result.status,
          captureId: result.capture.id,
          receivedAt: result.capture.receivedAt,
          expiresAt: result.capture.expiresAt,
          idempotencyKey: result.capture.idempotencyKey
        }, result.status === "captured" ? 201 : 200);
      }

      if (url.pathname === "/api/captures" && request.method === "GET") {
        const auth = deviceAuthorized(request, options.store, ["owner"], now().toISOString());
        if (!auth) return unauthorized();
        const limit = Number(url.searchParams.get("limit") || 100);
        return json({ captures: options.store.listCaptures(limit, now().toISOString()) });
      }

      if (url.pathname === "/api/captures/ack" && request.method === "POST") {
        const auth = deviceAuthorized(request, options.store, ["owner"], now().toISOString());
        if (!auth) return unauthorized();
        const body = await jsonBody(request, 16_384) as { ids?: unknown };
        const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string").slice(0, 200) : [];
        if (!ids.length) return problem(400, "capture_ids_required", "Provide at least one capture id.");
        return json({ acknowledged: options.store.acknowledgeCaptures(ids) });
      }

      if (url.pathname === "/api/push/subscriptions" && request.method === "POST") {
        const auth = deviceAuthorized(request, options.store, ["owner"], now().toISOString());
        if (!auth) return unauthorized();
        const body = await jsonBody(request, 16_384) as Record<string, unknown>;
        const subscription = subscriptionPayload(body);
        if (!subscription) return problem(400, "invalid_subscription", "A valid PushSubscription is required.");
        return json({ subscription: options.store.upsertSubscription(subscription, now().toISOString()) }, 201);
      }

      if (url.pathname === "/api/push/subscriptions" && request.method === "DELETE") {
        const auth = deviceAuthorized(request, options.store, ["owner"], now().toISOString());
        if (!auth) return unauthorized();
        const body = await jsonBody(request, 8_192) as { endpoint?: unknown };
        const endpoint = text(body.endpoint, 4_000);
        if (!endpoint) return problem(400, "endpoint_required", "Push endpoint is required.");
        return json({ removed: options.store.removeSubscriptionByEndpoint(endpoint) });
      }

      if (url.pathname === "/api/push/test" && request.method === "POST") {
        const auth = deviceAuthorized(request, options.store, ["owner"], now().toISOString());
        if (!auth) return unauthorized();
        if (!options.pushSender) return problem(503, "push_not_configured", "Web Push is not configured on this server.");
        const reminder: ReminderEnvelope = {
          id: `test-${now().getTime()}`,
          revision: 1,
          dueAt: now().toISOString(),
          route: "/#/today/p-omni",
          showTitle: false,
          cancelled: false
        };
        options.store.upsertReminder(reminder, now().toISOString());
        return json(await dispatchDueReminders(options.store, options.pushSender, now()));
      }

      const reminderId = /^\/api\/reminders\/([^/]+)$/.exec(url.pathname)?.[1];
      if (reminderId && (request.method === "PUT" || request.method === "DELETE")) {
        const auth = deviceAuthorized(request, options.store, ["owner"], now().toISOString());
        if (!auth) return unauthorized();
        const id = decodeURIComponent(reminderId);
        const body = request.method === "PUT" ? await jsonBody(request, 16_384) as Record<string, unknown> : {};
        const envelope = reminderPayload(id, body, request.method === "DELETE");
        if (!envelope) return problem(400, "invalid_reminder", "Reminder revision, due time, and app route are required.");
        const status = options.store.upsertReminder(envelope, now().toISOString());
        return json({ status, reminderId: id, revision: envelope.revision }, status === "stored" ? 200 : 409);
      }

      if (url.pathname === "/api/push/dispatch" && request.method === "POST") {
        if (!adminAuthorized(request, options.cronToken)) return unauthorized();
        if (!options.pushSender) return problem(503, "push_not_configured", "Web Push is not configured on this server.");
        return json(await dispatchDueReminders(options.store, options.pushSender, now()));
      }

      return problem(404, "not_found", "API route not found.");
    } catch (error) {
      if (error instanceof RequestProblem) return problem(error.status, error.code, error.message);
      return problem(500, "internal_error", "The request could not be completed.");
    }
  };
}

export async function dispatchDueReminders(store: CaptureStore, sender: PushSender, now = new Date()) {
  const subscriptions = store.listSubscriptions();
  const reminders = store.dueReminders(now.toISOString());
  let sent = 0;
  let failed = 0;
  let removed = 0;

  for (const reminder of reminders) {
    if (!subscriptions.length) continue;
    let allTerminal = true;
    for (const subscription of subscriptions) {
      if (store.deliveryAlreadyRecorded(reminder.id, reminder.revision, subscription.id)) continue;
      const payload = JSON.stringify({
        title: "OmniPlan 提醒",
        body: reminder.showTitle && reminder.title ? reminder.title : "你有一项计划需要关注。打开后可查看详情。",
        url: reminder.route,
        taskId: reminder.taskId,
        reminderId: reminder.id,
        tag: `reminder-${reminder.id}`
      });
      try {
        const result = await sender.send(subscription, payload);
        store.recordDelivery(reminder.id, reminder.revision, subscription.id, "sent", String(result.statusCode ?? 201), now.toISOString());
        sent += 1;
      } catch (error) {
        const statusCode = pushStatusCode(error);
        const permanent = statusCode === 404 || statusCode === 410;
        store.recordDelivery(reminder.id, reminder.revision, subscription.id, "failed", statusCode ? String(statusCode) : "send_error", now.toISOString());
        failed += 1;
        if (permanent) {
          store.removeSubscription(subscription.id);
          removed += 1;
        } else {
          allTerminal = false;
        }
      }
    }
    if (allTerminal) store.markReminderSent(reminder.id, reminder.revision);
  }

  return { reminders: reminders.length, subscriptions: subscriptions.length, sent, failed, removed };
}

function capturePayload(body: Record<string, unknown>): CapturePayload | undefined {
  const rawTitle = text(body.title, 500);
  if (!rawTitle) return undefined;
  const parsed = parseCaptureText(rawTitle);
  if (!parsed) return undefined;
  const explicitEstimateSeconds = optionalNonNegativeNumber(body.estimateSeconds);
  const estimateSeconds = explicitEstimateSeconds ?? parsed.estimateSeconds;
  if (body.estimateSeconds !== undefined && estimateSeconds === undefined) return undefined;
  const source = body.source === "alfred" || body.source === "share" || body.source === "agent" ? body.source : "shortcut";
  const plannedForDate = dateText(body.plannedForDate) ?? parsed.plannedForDate;
  const localStartTime = timeText(body.localStartTime) ?? parsed.localStartTime;
  return {
    title: parsed.title,
    ...(text(body.note, 4_000) ?? parsed.note ? { note: text(body.note, 4_000) ?? parsed.note } : {}),
    ...(estimateSeconds === undefined ? {} : { estimateSeconds }),
    ...(plannedForDate ? { plannedForDate } : {}),
    ...(localStartTime ? { localStartTime } : {}),
    ...(isoText(body.plannedStart) ? { plannedStart: isoText(body.plannedStart) } : {}),
    ...(isoText(body.plannedFinish) ? { plannedFinish: isoText(body.plannedFinish) } : {}),
    source
  };
}

function subscriptionPayload(body: Record<string, unknown>): Omit<StoredSubscription, "id" | "createdAt" | "updatedAt"> | undefined {
  const endpoint = text(body.endpoint, 4_000);
  const keys = body.keys && typeof body.keys === "object" ? body.keys as Record<string, unknown> : undefined;
  const p256dh = text(keys?.p256dh, 1_000);
  const auth = text(keys?.auth, 1_000);
  if (!endpoint?.startsWith("https://") || !p256dh || !auth) return undefined;
  const expirationTime = optionalNonNegativeNumber(body.expirationTime);
  return { endpoint, ...(expirationTime === undefined ? {} : { expirationTime }), keys: { p256dh, auth } };
}

function reminderPayload(id: string, body: Record<string, unknown>, cancelled: boolean): ReminderEnvelope | undefined {
  const revision = optionalNonNegativeNumber(body.revision);
  const dueAt = isoText(body.dueAt);
  const route = text(body.route, 2_000);
  if (revision === undefined || (!cancelled && (!dueAt || !route?.startsWith("/")))) return undefined;
  return {
    id,
    revision: Math.round(revision),
    dueAt: dueAt ?? new Date(0).toISOString(),
    route: route?.startsWith("/") ? route : "/#/today/p-omni",
    ...(text(body.taskId, 200) ? { taskId: text(body.taskId, 200) } : {}),
    ...(text(body.title, 500) ? { title: text(body.title, 500) } : {}),
    showTitle: body.showTitle === true,
    cancelled
  };
}

function deviceAuthorized(request: Request, store: CaptureStore, scopes: readonly TokenScope[], now: string) {
  const token = bearerToken(request);
  return token ? store.authenticate(token, scopes, now) : undefined;
}

function adminAuthorized(request: Request, expected?: string) {
  const supplied = bearerToken(request);
  if (!expected || !supplied) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(request: Request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1]?.trim();
}

async function jsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new RequestProblem(413, "payload_too_large", "Request body is too large.");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new RequestProblem(413, "payload_too_large", "Request body is too large.");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new RequestProblem(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function dateText(value: unknown) {
  const candidate = text(value, 10);
  return candidate && /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : undefined;
}

function timeText(value: unknown) {
  const candidate = text(value, 5);
  return candidate && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(candidate) ? candidate : undefined;
}

function isoText(value: unknown) {
  const candidate = text(value, 40);
  return candidate && Number.isFinite(new Date(candidate).getTime()) ? new Date(candidate).toISOString() : undefined;
}

function pushStatusCode(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

function unauthorized() {
  return problem(401, "unauthorized", "A valid Bearer token is required.");
}

function problem(status: number, code: string, message: string, headers: Record<string, string> = {}) {
  return json({ error: { code, message } }, status, headers);
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return response(JSON.stringify(value), status, { "Content-Type": "application/json; charset=utf-8", ...headers });
}

function response(body: BodyInit | null, status: number, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers
    }
  });
}

class RequestProblem extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
