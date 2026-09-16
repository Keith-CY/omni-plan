import type { CaptureSource, ISODate } from "./types";

export const PENDING_CAPTURE_STORAGE_KEY = "omni-plan-personal.pending-captures.v1";

export interface PendingExternalCapture {
  queueId: string;
  title: string;
  note?: string;
  estimateSeconds?: number;
  plannedForDate?: string;
  plannedStart?: ISODate;
  plannedFinish?: ISODate;
  source: CaptureSource;
  idempotencyKey: string;
  receivedAt: ISODate;
}

interface CaptureStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function queueShareTarget(
  location: Pick<Location, "pathname" | "search">,
  storage: CaptureStorage,
  now = new Date().toISOString()
): PendingExternalCapture | undefined {
  if (location.pathname !== "/capture") return undefined;
  const params = new URLSearchParams(location.search);
  const sharedTitle = cleanText(params.get("title"), 500);
  const sharedText = cleanText(params.get("text"), 4_000);
  const sharedUrl = cleanText(params.get("url"), 2_000);
  const title = sharedTitle || sharedText?.split(/\r?\n/)[0]?.trim() || sharedUrl;
  if (!title) return undefined;
  const noteParts = [sharedTitle ? sharedText : undefined, sharedUrl && sharedUrl !== title ? sharedUrl : undefined].filter(Boolean);
  const queueId = randomId();
  const capture: PendingExternalCapture = {
    queueId,
    title: title.slice(0, 500),
    ...(noteParts.length ? { note: noteParts.join("\n") } : {}),
    source: "share",
    idempotencyKey: `share-${queueId}`,
    receivedAt: now
  };
  enqueuePendingCapture(storage, capture);
  return capture;
}

export function enqueuePendingCapture(storage: CaptureStorage, capture: PendingExternalCapture): void {
  const pending = readPendingCaptures(storage);
  if (pending.some((item) => item.idempotencyKey === capture.idempotencyKey)) return;
  storage.setItem(PENDING_CAPTURE_STORAGE_KEY, JSON.stringify([...pending, capture].slice(-200)));
}

export function readPendingCaptures(storage: CaptureStorage): PendingExternalCapture[] {
  try {
    const parsed = JSON.parse(storage.getItem(PENDING_CAPTURE_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPendingCapture);
  } catch {
    return [];
  }
}

export function acknowledgePendingCaptures(storage: CaptureStorage, queueIds: readonly string[]): void {
  const acknowledged = new Set(queueIds);
  storage.setItem(
    PENDING_CAPTURE_STORAGE_KEY,
    JSON.stringify(readPendingCaptures(storage).filter((capture) => !acknowledged.has(capture.queueId)))
  );
}

function isPendingCapture(value: unknown): value is PendingExternalCapture {
  if (!value || typeof value !== "object") return false;
  const capture = value as Partial<PendingExternalCapture>;
  return typeof capture.queueId === "string"
    && typeof capture.title === "string"
    && typeof capture.source === "string"
    && typeof capture.idempotencyKey === "string"
    && typeof capture.receivedAt === "string";
}

function cleanText(value: string | null, maxLength: number) {
  const cleaned = value?.trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
