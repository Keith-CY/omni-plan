import { Bell, BellOff, Check, Clipboard, KeyRound, Link2, Plus, RefreshCw, Send, ShieldOff } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createExternalCaptureToken,
  getPushCapability,
  revokeAllExternalCaptureTokens,
  sendTestPush,
  subscribeToPush,
  unsubscribeFromPush,
  type PushCapability
} from "../../domain/connectivity";
import { BrowserEncryptedSecretVault, encryptProviderSecret } from "../../domain/secrets";
import type { ExternalServiceSettings } from "../../domain/settings";
import "./connectivity-settings.css";

export function ConnectivitySettingsPanel({
  settings,
  sessionPassphrase,
  onSave,
  onPullCaptures
}: {
  settings: ExternalServiceSettings;
  sessionPassphrase: string;
  onSave: (settings: ExternalServiceSettings) => void;
  onPullCaptures: () => Promise<number>;
}) {
  const secretVault = useMemo(() => new BrowserEncryptedSecretVault(), []);
  const [draft, setDraft] = useState(settings);
  const [ownerToken, setOwnerToken] = useState("");
  const [deviceName, setDeviceName] = useState("My Shortcut");
  const [createdToken, setCreatedToken] = useState<string>();
  const [capability, setCapability] = useState<PushCapability>({ state: "unsupported", message: "正在检查这台设备…" });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(settings), [settings]);
  useEffect(() => {
    void getPushCapability().then(setCapability).catch((error) => {
      setCapability({ state: "unsupported", message: error instanceof Error ? error.message : "无法检查通知能力。" });
    });
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      let ownerTokenSecretId = draft.ownerTokenSecretId;
      if (ownerToken.trim()) {
        if (!sessionPassphrase.trim()) throw new Error("先在上方输入工作区口令，才能加密保存 Owner Token。");
        const secret = await encryptProviderSecret(
          "custom",
          "External Service Owner Token",
          ownerToken.trim(),
          sessionPassphrase.trim(),
          new Date().toISOString()
        );
        secretVault.saveEncrypted(secret);
        ownerTokenSecretId = secret.id;
        setOwnerToken("");
      }
      if (!ownerTokenSecretId) throw new Error("请输入服务的 Owner Token。");
      const next = {
        ...draft,
        baseUrl: draft.baseUrl.trim().replace(/\/+$/, "") || window.location.origin,
        ownerTokenSecretId,
        pollIntervalSeconds: Math.max(15, Math.round(draft.pollIntervalSeconds || 30)),
        updatedAt: new Date().toISOString()
      };
      onSave(next);
      setDraft(next);
      setNotice("私人服务设置已保存；Token 只以加密形式留在这台浏览器。 ");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  };

  const unlockedToken = async () => {
    if (!draft.ownerTokenSecretId) throw new Error("先保存 Owner Token。");
    if (!sessionPassphrase.trim()) throw new Error("先输入工作区口令来解锁 Owner Token。");
    const token = await secretVault.unlock(draft.ownerTokenSecretId, sessionPassphrase.trim());
    if (!token) throw new Error("Owner Token 无法解锁，请检查口令。");
    return token;
  };

  const run = async (action: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const result = await action();
      if (result) setNotice(result);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="connectivitySettings" aria-labelledby="connectivity-settings-title">
      <div className="connectivitySettingsHeader">
        <div>
          <p>WEB APP CONNECTIONS</p>
          <h3 id="connectivity-settings-title">通知与外部快速记录</h3>
          <span>服务端只保存待消费 Capture、设备订阅和最小提醒信封，不保存或解密工作区。</span>
        </div>
        <i data-state={capability.state}>{capability.state === "subscribed" ? <Bell /> : <BellOff />}{capability.message}</i>
      </div>

      {notice && <div className="connectivityNotice" role="status">{notice}</div>}

      <form className="connectivityServiceForm" onSubmit={(event) => void save(event)}>
        <label>
          <span>私人服务地址</span>
          <input type="url" value={draft.baseUrl} onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))} placeholder={window.location.origin} />
        </label>
        <label>
          <span>Owner Token {draft.ownerTokenSecretId ? "（已保存，可留空）" : ""}</span>
          <input type="password" value={ownerToken} onChange={(event) => setOwnerToken(event.target.value)} autoComplete="new-password" placeholder="op_owner_…" />
        </label>
        <label className="connectivityPollInterval">
          <span>拉取间隔（秒）</span>
          <input type="number" min="15" max="3600" value={draft.pollIntervalSeconds} onChange={(event) => setDraft((current) => ({ ...current, pollIntervalSeconds: Number(event.target.value) }))} />
        </label>
        <label className="connectivityCheck"><input type="checkbox" checked={draft.autoPullEnabled} onChange={(event) => setDraft((current) => ({ ...current, autoPullEnabled: event.target.checked }))} /><span>自动拉取 Shortcut / Alfred Capture</span></label>
        <label className="connectivityCheck"><input type="checkbox" checked={draft.showNotificationTitles} onChange={(event) => setDraft((current) => ({ ...current, showNotificationTitles: event.target.checked }))} /><span>允许通知正文显示任务标题</span></label>
        <button type="submit" disabled={busy}><Check />保存连接</button>
      </form>

      <div className="connectivityActions">
        <button type="button" disabled={busy || !draft.ownerTokenSecretId} onClick={() => void run(async () => {
          const count = await onPullCaptures();
          return count ? `已导入 ${count} 个外部 Capture。` : "没有等待导入的 Capture。";
        })}><RefreshCw />立即拉取</button>
        {capability.state === "subscribed" ? (
          <button type="button" disabled={busy || !draft.ownerTokenSecretId} onClick={() => void run(async () => {
            const token = await unlockedToken();
            await unsubscribeFromPush(draft, token);
            setCapability(await getPushCapability());
            return "这台设备的通知已关闭。";
          })}><BellOff />关闭通知</button>
        ) : (
          <button type="button" disabled={busy || !draft.ownerTokenSecretId || capability.state === "unsupported" || capability.state === "install-required" || capability.state === "denied"} onClick={() => void run(async () => {
            const token = await unlockedToken();
            const next = await subscribeToPush(draft, token);
            setCapability(next);
            const updated = { ...draft, updatedAt: new Date().toISOString() };
            onSave(updated);
            setDraft(updated);
            return "通知已开启；提醒正文默认不含任务标题。";
          })}><Bell />开启通知</button>
        )}
        <button type="button" disabled={busy || capability.state !== "subscribed"} onClick={() => void run(async () => {
          const token = await unlockedToken();
          await sendTestPush(draft, token);
          return "测试通知已交给推送服务。";
        })}><Send />发送测试通知</button>
      </div>

      <div className="connectivityTokenMaker">
        <div>
          <KeyRound aria-hidden="true" />
          <span><strong>为 Shortcut 或 Alfred 生成独立 Token</strong><small>每台设备单独撤销；原始 Token 只显示一次。</small></span>
        </div>
        <form onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const token = await unlockedToken();
            const created = await createExternalCaptureToken(draft, token, deviceName);
            setCreatedToken(created.token);
            return `${created.name} Token 已生成，请现在保存。`;
          });
        }}>
          <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} aria-label="外部设备名称" required />
          <button type="submit" disabled={busy || !draft.ownerTokenSecretId}><Plus />生成 Token</button>
        </form>
        {createdToken && (
          <div className="connectivityCreatedToken">
            <code>{createdToken}</code>
            <button type="button" onClick={() => void navigator.clipboard.writeText(createdToken)}><Clipboard />复制</button>
          </div>
        )}
        <button type="button" className="connectivityRevoke" disabled={busy || !draft.ownerTokenSecretId} onClick={() => {
          if (!window.confirm("撤销全部 Shortcut / Alfred Token？现有外部入口会立刻失效。")) return;
          void run(async () => {
            const token = await unlockedToken();
            const count = await revokeAllExternalCaptureTokens(draft, token);
            setCreatedToken(undefined);
            return `已撤销 ${count} 个外部 Capture Token。`;
          });
        }}><ShieldOff />撤销全部外部 Token</button>
      </div>

      <div className="connectivityPrivacy"><Link2 /><span>在 iPhone 普通 Safari 标签中不会宣称可推送；只有添加到主屏幕后，开启按钮才会可用。拒绝权限后需到系统设置恢复。</span></div>
    </section>
  );
}
