export const PWA_UPDATE_READY_EVENT = "omni-plan:pwa-update-ready";

export async function registerPwaServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!("serviceWorker" in navigator)) return undefined;
  if (!import.meta.env.PROD) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    return undefined;
  }

  const registration = await navigator.serviceWorker.register("/sw.js");
  if (registration.waiting) announceUpdate(registration);
  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    installing?.addEventListener("statechange", () => {
      if (installing.state === "installed" && navigator.serviceWorker.controller) announceUpdate(registration);
    });
  });
  return registration;
}

export async function activateWaitingServiceWorker(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration?.waiting) return false;
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, 3_000);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
    registration.waiting?.postMessage({ type: "SKIP_WAITING" });
  });
  return true;
}

export function isStandaloneWebApp(): boolean {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.("(display-mode: standalone)").matches === true || navigatorWithStandalone.standalone === true;
}

export function isIosBrowser(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

function announceUpdate(registration: ServiceWorkerRegistration) {
  window.dispatchEvent(new CustomEvent(PWA_UPDATE_READY_EVENT, { detail: registration }));
}
