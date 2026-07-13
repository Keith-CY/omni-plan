import {
  SOURCE_DEFAULT_APP_GENERATION,
  loadGeneration,
  resolveAppGeneration,
} from "./appEntry";

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline support is progressive; the app remains usable without SW registration.
    });
  });
} else if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.unregister();
    }
  });
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("OmniPlan root element is missing.");

const generation = resolveAppGeneration(
  import.meta.env.VITE_OMNIPLAN_GENERATION,
  SOURCE_DEFAULT_APP_GENERATION,
);
void loadGeneration(generation).then(({ renderApp }) => {
  renderApp(rootElement);
});
