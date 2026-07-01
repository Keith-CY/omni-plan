import type { ProviderSecret } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BROWSER_SECRET_STORAGE_KEY = "omni-plan-personal.provider-secrets.v1";

export interface SecretVaultStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredSecretVault {
  schemaVersion: 1;
  secrets: Record<string, ProviderSecret>;
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: toArrayBuffer(salt), iterations: 210_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptProviderSecret(
  provider: ProviderSecret["provider"],
  label: string,
  secretValue: string,
  passphrase: string,
  now: string
): Promise<ProviderSecret> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(encoder.encode(secretValue)))
  );

  return {
    id: `secret-${provider}-${label.toLowerCase().replace(/\s+/g, "-")}`,
    provider,
    label,
    encryptedValue: bytesToBase64(encrypted),
    iv: bytesToBase64(iv),
    salt: bytesToBase64(salt),
    createdAt: now
  };
}

export async function decryptProviderSecret(secret: ProviderSecret, passphrase: string): Promise<string> {
  const salt = base64ToBytes(secret.salt);
  const iv = base64ToBytes(secret.iv);
  const key = await deriveKey(passphrase, salt);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(base64ToBytes(secret.encryptedValue))
  );
  return decoder.decode(decrypted);
}

export class BrowserEncryptedSecretVault {
  constructor(private readonly storage: SecretVaultStorage = localStorage) {}

  listEncrypted(): ProviderSecret[] {
    return Object.values(this.load().secrets);
  }

  readEncrypted(id: string): ProviderSecret | undefined {
    return this.load().secrets[id];
  }

  saveEncrypted(secret: ProviderSecret): void {
    const vault = this.load();
    vault.secrets[secret.id] = secret;
    this.save(vault);
  }

  async unlock(id: string, passphrase: string): Promise<string | undefined> {
    const secret = this.readEncrypted(id);
    return secret ? decryptProviderSecret(secret, passphrase) : undefined;
  }

  delete(id: string): void {
    const vault = this.load();
    delete vault.secrets[id];
    this.save(vault);
  }

  clear(): void {
    this.storage.removeItem(BROWSER_SECRET_STORAGE_KEY);
  }

  private load(): StoredSecretVault {
    const raw = this.storage.getItem(BROWSER_SECRET_STORAGE_KEY);
    if (!raw) return { schemaVersion: 1, secrets: {} };
    const parsed = JSON.parse(raw) as StoredSecretVault;
    if (parsed.schemaVersion !== 1) {
      throw new Error(`Unsupported secret vault schema version ${parsed.schemaVersion}`);
    }
    return parsed;
  }

  private save(vault: StoredSecretVault): void {
    this.storage.setItem(BROWSER_SECRET_STORAGE_KEY, JSON.stringify(vault));
  }
}

export const browserSecretVaultStatus = {
  inputSource: "Apple Passwords or browser password manager autofill",
  localProtection: "Provider secrets are encrypted locally with the workspace passphrase",
  passphrasePolicy: "Workspace passphrase may be autofilled but is not persisted by the app",
  syncPolicy: "Secrets are excluded from workspace files, GitHub ChangeSet sync, and evidence exports",
  nativeUpgrade: "Native builds can replace this adapter with Keychain storage later"
};
