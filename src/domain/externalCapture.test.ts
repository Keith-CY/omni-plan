import { describe, expect, it } from "vitest";
import {
  acknowledgePendingCaptures,
  enqueuePendingCapture,
  PENDING_CAPTURE_STORAGE_KEY,
  queueShareTarget,
  readPendingCaptures
} from "./externalCapture";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values
  };
}

describe("external capture queue", () => {
  it("turns a Web Share Target request into a pending task", () => {
    const storage = memoryStorage();
    const capture = queueShareTarget({
      pathname: "/capture",
      search: "?title=Useful%20page&text=Read%20this&url=https%3A%2F%2Fexample.com"
    } as Location, storage, "2026-09-16T00:00:00.000Z");

    expect(capture).toMatchObject({ title: "Useful page", note: "Read this\nhttps://example.com", source: "share" });
    expect(readPendingCaptures(storage)).toHaveLength(1);
  });

  it("deduplicates retries and only removes acknowledged captures", () => {
    const storage = memoryStorage();
    const base = {
      queueId: "queue-1",
      title: "One task",
      source: "alfred" as const,
      idempotencyKey: "same-request",
      receivedAt: "2026-09-16T00:00:00.000Z"
    };
    enqueuePendingCapture(storage, base);
    enqueuePendingCapture(storage, { ...base, queueId: "queue-2" });
    expect(readPendingCaptures(storage).map((capture) => capture.queueId)).toEqual(["queue-1"]);

    acknowledgePendingCaptures(storage, ["queue-1"]);
    expect(storage.values.get(PENDING_CAPTURE_STORAGE_KEY)).toBe("[]");
  });
});
