const CACHE_VERSION = "task-first-v3";
const STATIC_CACHE = `omni-plan-static-${CACHE_VERSION}`;
const PAGE_CACHE = `omni-plan-pages-${CACHE_VERSION}`;
const APP_SHELL = [
  "/",
  "/index.html",
  "/offline.html",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith("omni-plan-") && key !== STATIC_CACHE && key !== PAGE_CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(networkFirstPage(event.request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event.request));
  }
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json?.() ?? {};
  } catch {
    payload = { body: event.data?.text?.() };
  }
  const title = typeof payload.title === "string" && payload.title.trim()
    ? payload.title.trim()
    : "OmniPlan 提醒";
  const body = typeof payload.body === "string" && payload.body.trim()
    ? payload.body.trim()
    : "你有一项计划需要关注。打开后可查看详情。";
  const data = {
    url: safeAppUrl(payload.url),
    reminderId: typeof payload.reminderId === "string" ? payload.reminderId : undefined,
    taskId: typeof payload.taskId === "string" ? payload.taskId : undefined
  };
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: typeof payload.tag === "string" ? payload.tag : data.reminderId,
    renotify: false,
    data,
    actions: [{ action: "open", title: "打开安排" }]
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = safeAppUrl(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows[0];
    if (existing) {
      await existing.focus();
      if ("navigate" in existing) await existing.navigate(targetUrl);
      return;
    }
    await self.clients.openWindow(targetUrl);
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: "PUSH_SUBSCRIPTION_CHANGED" });
  })());
});

async function networkFirstPage(request) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put("/index.html", response.clone());
    return response;
  } catch {
    return await cache.match("/index.html")
      || await caches.match("/index.html")
      || await caches.match("/offline.html");
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const update = fetch(request).then(async (response) => {
    if (response.ok) await cache.put(request, response.clone());
    return response;
  }).catch(() => undefined);
  return cached || await update || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
}

function safeAppUrl(value) {
  try {
    const url = new URL(typeof value === "string" ? value : "/", self.location.origin);
    return url.origin === self.location.origin ? url.href : new URL("/", self.location.origin).href;
  } catch {
    return new URL("/", self.location.origin).href;
  }
}
