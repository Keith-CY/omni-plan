import { Download, RefreshCw, Share2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { activateWaitingServiceWorker, isIosBrowser, isStandaloneWebApp, PWA_UPDATE_READY_EVENT } from "../../pwa";
import "./pwa-notice.css";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const installDismissedKey = "omni-plan-personal.install-guide-dismissed.v1";

export function PwaNotice() {
  const [updateReady, setUpdateReady] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent>();
  const [showIosGuide, setShowIosGuide] = useState(() => (
    isIosBrowser()
    && !isStandaloneWebApp()
    && window.localStorage.getItem(installDismissedKey) !== "true"
  ));

  useEffect(() => {
    const onUpdate = () => setUpdateReady(true);
    const onInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener(PWA_UPDATE_READY_EVENT, onUpdate);
    window.addEventListener("beforeinstallprompt", onInstall);
    return () => {
      window.removeEventListener(PWA_UPDATE_READY_EVENT, onUpdate);
      window.removeEventListener("beforeinstallprompt", onInstall);
    };
  }, []);

  if (!updateReady && !installPrompt && !showIosGuide) return null;

  const dismissIos = () => {
    window.localStorage.setItem(installDismissedKey, "true");
    setShowIosGuide(false);
  };

  return (
    <aside className="pwaNotice" aria-live="polite">
      {updateReady ? (
        <>
          <RefreshCw aria-hidden="true" />
          <span><strong>新版本已准备好</strong><small>刷新后启用，当前编辑已经保存在本机。</small></span>
          <button
            type="button"
            onClick={async () => {
              await activateWaitingServiceWorker();
              window.location.reload();
            }}
          >刷新</button>
        </>
      ) : installPrompt ? (
        <>
          <Download aria-hidden="true" />
          <span><strong>安装到这台设备</strong><small>像普通应用一样打开，离线也能进入。</small></span>
          <button
            type="button"
            onClick={async () => {
              await installPrompt.prompt();
              await installPrompt.userChoice;
              setInstallPrompt(undefined);
            }}
          >安装</button>
        </>
      ) : (
        <>
          <Share2 aria-hidden="true" />
          <span><strong>在 iPhone 上添加到主屏幕</strong><small>点 Safari 的分享按钮，再选“添加到主屏幕”；安装后才能开启 Web Push。</small></span>
          <button type="button" onClick={dismissIos}>知道了</button>
          <button type="button" className="pwaNoticeClose" aria-label="关闭安装提示" onClick={dismissIos}><X /></button>
        </>
      )}
    </aside>
  );
}
