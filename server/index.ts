import { resolve, sep } from "node:path";
import webpush from "web-push";
import { createApi, dispatchDueReminders, type PushSender } from "./api";
import { CaptureStore } from "./store";

export interface ServerEnvironment {
  OMNIPLAN_DB_PATH?: string;
  OMNIPLAN_API_ADMIN_TOKEN?: string;
  OMNIPLAN_CRON_TOKEN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  OMNIPLAN_FIREBASE_PROJECT_ID?: string;
  OMNIPLAN_FIREBASE_WEB_API_KEY?: string;
  OMNIPLAN_FIREBASE_DATABASE_ID?: string;
  OMNIPLAN_FIREBASE_COLLECTION_PATH?: string;
  OMNIPLAN_FIREBASE_WORKSPACE_ID?: string;
  PORT?: string;
  OMNIPLAN_REQUIRE_HTTPS?: string;
}

export function createServerRuntime(environment: ServerEnvironment = process.env as ServerEnvironment) {
  const store = new CaptureStore(environment.OMNIPLAN_DB_PATH);
  const pushSender = createWebPushSender(environment);
  const api = createApi({
    store,
    adminToken: environment.OMNIPLAN_API_ADMIN_TOKEN,
    cronToken: environment.OMNIPLAN_CRON_TOKEN,
    vapidPublicKey: environment.VAPID_PUBLIC_KEY,
    clientConfig: publicClientConfig(environment),
    pushSender
  });
  const distRoot = resolve(process.cwd(), "dist");

  const fetch = async (request: Request) => {
    if (environment.OMNIPLAN_REQUIRE_HTTPS === "1") {
      const url = new URL(request.url);
      const isHealthCheck = request.method === "GET" && url.pathname === "/api/health";
      const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
      const directProtocol = url.protocol.replace(/:$/, "").toLowerCase();
      if (!isHealthCheck && (forwarded || directProtocol) !== "https") {
        return Response.json({ error: { code: "https_required", message: "Use HTTPS for this service." } }, { status: 426 });
      }
    }
    const apiResponse = await api(request);
    if (apiResponse) return apiResponse;
    return staticResponse(request, distRoot);
  };

  return { store, pushSender, fetch };
}

export function publicClientConfig(environment: ServerEnvironment) {
  const projectId = environment.OMNIPLAN_FIREBASE_PROJECT_ID?.trim();
  const apiKey = environment.OMNIPLAN_FIREBASE_WEB_API_KEY?.trim();
  return {
    firebaseSync: projectId && apiKey
      ? {
          projectId,
          apiKey,
          databaseId: environment.OMNIPLAN_FIREBASE_DATABASE_ID?.trim() || "(default)",
          collectionPath: environment.OMNIPLAN_FIREBASE_COLLECTION_PATH?.trim() || "omniPlanSync",
          workspaceId: environment.OMNIPLAN_FIREBASE_WORKSPACE_ID?.trim() || "personal"
        }
      : null
  };
}

function createWebPushSender(environment: ServerEnvironment): PushSender | undefined {
  if (!environment.VAPID_PUBLIC_KEY || !environment.VAPID_PRIVATE_KEY || !environment.VAPID_SUBJECT) return undefined;
  webpush.setVapidDetails(environment.VAPID_SUBJECT, environment.VAPID_PUBLIC_KEY, environment.VAPID_PRIVATE_KEY);
  return {
    async send(subscription, payload) {
      const result = await webpush.sendNotification({
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime ?? null,
        keys: subscription.keys
      }, payload, { TTL: 300, urgency: "normal" });
      return { statusCode: result.statusCode };
    }
  };
}

async function staticResponse(request: Request, distRoot: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const url = new URL(request.url);
  const pathname = decodeURIComponent(url.pathname);
  const requestedPath = pathname === "/" || pathname === "/capture" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolvedPath = resolve(distRoot, requestedPath);
  if (!resolvedPath.startsWith(`${distRoot}${sep}`) && resolvedPath !== distRoot) return new Response("Not found", { status: 404 });
  let file = Bun.file(resolvedPath);
  if (!await file.exists() && !requestedPath.includes(".")) file = Bun.file(resolve(distRoot, "index.html"));
  if (!await file.exists()) return new Response("Not found", { status: 404 });
  return new Response(request.method === "HEAD" ? null : file, {
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "Cache-Control": requestedPath === "index.html" ? "no-cache" : requestedPath.includes("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin"
    }
  });
}

if (import.meta.main) {
  const runtime = createServerRuntime();
  const port = Number(process.env.PORT || 8787);
  const server = Bun.serve({ port, fetch: runtime.fetch });
  if (runtime.pushSender) {
    setInterval(() => {
      void dispatchDueReminders(runtime.store, runtime.pushSender!).catch(() => undefined);
    }, 60_000);
  }
  process.stdout.write(`OmniPlan server listening on ${server.url}\n`);
}
