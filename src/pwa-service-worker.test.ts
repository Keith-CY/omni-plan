import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type ServiceWorkerListener = (event: any) => void;

function serviceWorkerHarness(cacheKeys: string[] = []) {
  const listeners = new Map<string, ServiceWorkerListener>();
  const deleted: string[] = [];
  const cache = {
    addAll: vi.fn(async () => undefined),
    match: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined)
  };
  const windowClient = {
    focus: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    postMessage: vi.fn()
  };
  const self = {
    location: { origin: "https://planner.test" },
    addEventListener: (type: string, listener: ServiceWorkerListener) => listeners.set(type, listener),
    skipWaiting: vi.fn(),
    registration: { showNotification: vi.fn(async () => undefined) },
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => [windowClient]),
      openWindow: vi.fn(async () => undefined)
    }
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => cacheKeys),
    delete: vi.fn(async (key: string) => {
      deleted.push(key);
      return true;
    }),
    match: vi.fn(async () => undefined)
  };
  const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    self,
    caches,
    fetch: vi.fn(async () => new Response("ok")),
    URL,
    Response,
    Promise
  });
  return { listeners, self, caches, cache, deleted, windowClient };
}

describe("PWA service worker", () => {
  it("never intercepts API requests", () => {
    const { listeners } = serviceWorkerHarness();
    const respondWith = vi.fn();

    listeners.get("fetch")?.({
      request: { method: "GET", mode: "cors", url: "https://planner.test/api/captures" },
      respondWith
    });

    expect(respondWith).not.toHaveBeenCalled();
  });

  it("sanitizes a cross-origin notification route", async () => {
    const { listeners, self } = serviceWorkerHarness();
    let completion: Promise<unknown> | undefined;

    listeners.get("push")?.({
      data: { json: () => ({ title: "Task due", body: "Open it", url: "https://attacker.test/steal" }) },
      waitUntil: (promise: Promise<unknown>) => { completion = promise; }
    });
    await completion;

    expect(self.registration.showNotification).toHaveBeenCalledWith("Task due", expect.objectContaining({
      data: expect.objectContaining({ url: "https://planner.test/" })
    }));
  });

  it("focuses an existing app window and navigates to the notification deep link", async () => {
    const { listeners, windowClient } = serviceWorkerHarness();
    let completion: Promise<unknown> | undefined;
    const close = vi.fn();

    listeners.get("notificationclick")?.({
      notification: { close, data: { url: "/#/today/personal/day%3A2026-09-17%3Atodo-1" } },
      waitUntil: (promise: Promise<unknown>) => { completion = promise; }
    });
    await completion;

    expect(close).toHaveBeenCalledTimes(1);
    expect(windowClient.focus).toHaveBeenCalledTimes(1);
    expect(windowClient.navigate).toHaveBeenCalledWith(
      "https://planner.test/#/today/personal/day%3A2026-09-17%3Atodo-1"
    );
  });

  it("removes old app caches and claims clients on activation", async () => {
    const current = ["omni-plan-static-task-first-v3", "omni-plan-pages-task-first-v3"];
    const { listeners, self, deleted } = serviceWorkerHarness([
      ...current,
      "omni-plan-static-task-first-v2",
      "unrelated-cache"
    ]);
    let completion: Promise<unknown> | undefined;

    listeners.get("activate")?.({ waitUntil: (promise: Promise<unknown>) => { completion = promise; } });
    await completion;

    expect(deleted).toEqual(["omni-plan-static-task-first-v2"]);
    expect(self.clients.claim).toHaveBeenCalledTimes(1);
  });
});
