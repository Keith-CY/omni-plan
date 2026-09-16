import { isIosBrowser, isStandaloneWebApp } from "../pwa";
import type { ExternalServiceSettings } from "./settings";
import type { CaptureSource, WorkspaceSnapshot } from "./types";
import { zonedDateKey } from "./time";

export type PushCapability =
  | { state: "unsupported"; message: string }
  | { state: "install-required"; message: string }
  | { state: "denied"; message: string }
  | { state: "available"; message: string }
  | { state: "subscribed"; message: string; endpoint: string };

export interface RemoteCapture {
  id: string;
  title: string;
  note?: string;
  estimateSeconds?: number;
  plannedForDate?: string;
  localStartTime?: string;
  plannedStart?: string;
  plannedFinish?: string;
  source: CaptureSource;
  idempotencyKey: string;
  receivedAt: string;
  expiresAt: string;
}

export interface ExternalCaptureToken {
  id: string;
  name: string;
  scope: "capture";
  token?: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export async function getPushCapability(): Promise<PushCapability> {
  if (!window.isSecureContext) return { state: "unsupported", message: "通知要求 HTTPS 安全连接。" };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { state: "unsupported", message: "当前浏览器不支持标准 Web Push。" };
  }
  if (isIosBrowser() && !isStandaloneWebApp()) {
    return { state: "install-required", message: "iPhone 需要先用 Safari 添加到主屏幕，再从主屏幕打开。" };
  }
  if (Notification.permission === "denied") {
    return { state: "denied", message: "通知已被系统拒绝，请在系统设置中重新开启。" };
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription
    ? { state: "subscribed", message: "这台设备已开启通知。", endpoint: subscription.endpoint }
    : { state: "available", message: "这台设备可以开启通知。" };
}

export async function subscribeToPush(settings: ExternalServiceSettings, ownerToken: string): Promise<PushCapability> {
  const current = await getPushCapability();
  if (current.state === "unsupported" || current.state === "install-required" || current.state === "denied") {
    throw new Error(current.message);
  }
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") throw new Error("通知权限没有开启。");
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await apiJson<{ publicKey: string }>(settings, ownerToken, "/api/push/public-key");
  const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey)
  });
  await apiJson(settings, ownerToken, "/api/push/subscriptions", {
    method: "POST",
    body: JSON.stringify(subscription.toJSON())
  });
  return { state: "subscribed", message: "这台设备已开启通知。", endpoint: subscription.endpoint };
}

export async function unsubscribeFromPush(settings: ExternalServiceSettings, ownerToken: string): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await apiJson(settings, ownerToken, "/api/push/subscriptions", {
    method: "DELETE",
    body: JSON.stringify({ endpoint: subscription.endpoint })
  });
  await subscription.unsubscribe();
}

export async function sendTestPush(settings: ExternalServiceSettings, ownerToken: string): Promise<void> {
  await apiJson(settings, ownerToken, "/api/push/test", { method: "POST", body: "{}" });
}

export async function pullRemoteCaptures(settings: ExternalServiceSettings, ownerToken: string): Promise<RemoteCapture[]> {
  const result = await apiJson<{ captures: RemoteCapture[] }>(settings, ownerToken, "/api/captures?limit=100");
  return result.captures ?? [];
}

export async function acknowledgeRemoteCaptures(settings: ExternalServiceSettings, ownerToken: string, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  await apiJson(settings, ownerToken, "/api/captures/ack", {
    method: "POST",
    body: JSON.stringify({ ids })
  });
}

export async function createExternalCaptureToken(
  settings: ExternalServiceSettings,
  ownerToken: string,
  name: string
): Promise<ExternalCaptureToken & { token: string }> {
  return apiJson(settings, ownerToken, "/api/capture-tokens", {
    method: "POST",
    body: JSON.stringify({ name })
  });
}

export async function listExternalCaptureTokens(settings: ExternalServiceSettings, ownerToken: string): Promise<ExternalCaptureToken[]> {
  const result = await apiJson<{ tokens: ExternalCaptureToken[] }>(settings, ownerToken, "/api/capture-tokens");
  return result.tokens ?? [];
}

export async function revokeAllExternalCaptureTokens(settings: ExternalServiceSettings, ownerToken: string): Promise<number> {
  const result = await apiJson<{ revoked: number }>(settings, ownerToken, "/api/capture-tokens", { method: "DELETE" });
  return result.revoked;
}

export async function syncWorkspaceReminders(
  workspace: WorkspaceSnapshot,
  settings: ExternalServiceSettings,
  ownerToken: string
): Promise<{ stored: number; cancelled: number }> {
  const next = reminderEnvelopes(workspace, settings.showNotificationTitles);
  const previousIds = readSyncedReminderIds();
  let stored = 0;
  for (const reminder of next) {
    await apiJson(settings, ownerToken, `/api/reminders/${encodeURIComponent(reminder.id)}`, {
      method: "PUT",
      body: JSON.stringify(reminder)
    });
    stored += 1;
  }
  const nextIds = new Set(next.map((reminder) => reminder.id));
  let cancelled = 0;
  for (const id of previousIds.filter((candidate) => !nextIds.has(candidate))) {
    await apiJson(settings, ownerToken, `/api/reminders/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ revision: Date.now() })
    });
    cancelled += 1;
  }
  window.localStorage.setItem(SYNCED_REMINDER_IDS_KEY, JSON.stringify([...nextIds]));
  return { stored, cancelled };
}

export function applicationServerKey(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function reminderEnvelopes(workspace: WorkspaceSnapshot, showTitle: boolean) {
  const fallbackProjectId = workspace.projects[0]?.id ?? "p-omni";
  const todos = workspace.todos.flatMap((todo) => {
    if (todo.status !== "open") return [];
    const dueAt = todo.plannedStart ?? todo.dueAt;
    if (!dueAt || !Number.isFinite(new Date(dueAt).getTime())) return [];
    return [{
      id: `todo-${todo.id}`,
      revision: revision(todo.updatedAt),
      dueAt,
      route: reminderRoute(fallbackProjectId, todo.id, dueAt, workspace.timeZone),
      taskId: todo.id,
      ...(showTitle ? { title: todo.title } : {}),
      showTitle,
      cancelled: false
    }];
  });
  const workItems = workspace.workItems.flatMap((item) => {
    if (item.kind === "phase" || item.percentComplete >= 100 || !item.constraint?.fixedStart) return [];
    return [{
      id: `work-${item.id}`,
      revision: revision(item.updatedAt ?? item.capturedAt ?? item.constraint.fixedStart),
      dueAt: item.constraint.fixedStart,
      route: reminderRoute(item.projectId, item.id, item.constraint.fixedStart, workspace.timeZone),
      taskId: item.id,
      ...(showTitle ? { title: item.title } : {}),
      showTitle,
      cancelled: false
    }];
  });
  const occurrences = workspace.recurringOccurrences.flatMap((occurrence) => {
    if (occurrence.status !== "scheduled") return [];
    return [{
      id: `occurrence-${occurrence.id}`,
      revision: revision(occurrence.updatedAt),
      dueAt: occurrence.start,
      route: reminderRoute(occurrence.projectId, occurrence.workItemId, occurrence.start, workspace.timeZone),
      taskId: occurrence.workItemId,
      ...(showTitle ? { title: occurrence.title } : {}),
      showTitle,
      cancelled: false
    }];
  });
  return [...todos, ...workItems, ...occurrences];
}

function reminderRoute(projectId: string, taskId: string, dueAt: string, timeZone: string) {
  const target = `day:${zonedDateKey(dueAt, timeZone)}:${taskId}`;
  return `/#/today/${encodeURIComponent(projectId)}/${encodeURIComponent(target)}`;
}

const SYNCED_REMINDER_IDS_KEY = "omni-plan-personal.synced-reminder-ids.v1";

function readSyncedReminderIds(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SYNCED_REMINDER_IDS_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function revision(value: string) {
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? Math.max(0, Math.round(milliseconds)) : 0;
}

async function apiJson<T = unknown>(
  settings: ExternalServiceSettings,
  ownerToken: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, "") || window.location.origin;
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    },
    cache: "no-store"
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
    throw new Error(body?.error?.message || `Service request failed (${response.status}).`);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}
