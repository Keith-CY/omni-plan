import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { queueShareTarget } from "./domain/externalCapture";
import { registerPwaServiceWorker } from "./pwa";
import "./styles.css";

const App = lazy(() => import("./App").then((module) => ({ default: module.App })));
const AgentApp = lazy(() => import("./AgentApp").then((module) => ({ default: module.AgentApp })));
const agentPath = window.location.pathname === "/agent" || window.location.pathname.startsWith("/agent/");

if (window.location.pathname === "/capture") {
  queueShareTarget(window.location, window.localStorage);
  window.history.replaceState(null, "", "/#/today/p-omni");
}

window.addEventListener("load", () => {
  void registerPwaServiceWorker().catch(() => {
    // Offline support is progressive; the app remains usable without SW registration.
  });
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<main className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">Opening OmniPlan…</main>}>
      {agentPath ? (
        <AgentApp />
      ) : (
        <HashRouter>
          <App />
        </HashRouter>
      )}
    </Suspense>
  </React.StrictMode>
);
