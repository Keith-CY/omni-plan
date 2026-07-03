import type { ProviderSecret } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BROWSER_SECRET_STORAGE_KEY = "omni-plan-personal.provider-secrets.v1";
const PASSPHRASE_DB_NAME = "omni-plan-personal.passphrase.v1";
const PASSPHRASE_STORE_NAME = "remembered-passphrases";
const WORKSPACE_PASSPHRASE_KEY = "workspace";

export interface SecretVaultStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredSecretVault {
  schemaVersion: 1;
  secrets: Record<string, ProviderSecret>;
}

export interface RememberedPassphraseRecord {
  schemaVersion: 1;
  id: "workspace";
  passphrase: string;
  savedAt: string;
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

export class BrowserRememberedPassphraseVault {
  async read(): Promise<RememberedPassphraseRecord | undefined> {
    const database = await this.openDatabase();
    return this.transaction<RememberedPassphraseRecord | undefined>(database, "readonly", (store, resolve, reject) => {
      const request = store.get(WORKSPACE_PASSPHRASE_KEY);
      request.onsuccess = () => resolve(request.result as RememberedPassphraseRecord | undefined);
      request.onerror = () => reject(request.error ?? new Error("Could not read remembered workspace passphrase."));
    });
  }

  async save(passphrase: string, savedAt: string): Promise<RememberedPassphraseRecord> {
    const record: RememberedPassphraseRecord = {
      schemaVersion: 1,
      id: WORKSPACE_PASSPHRASE_KEY,
      passphrase,
      savedAt
    };
    const database = await this.openDatabase();
    await this.transaction<void>(database, "readwrite", (store, resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Could not remember workspace passphrase."));
    });
    return record;
  }

  async clear(): Promise<void> {
    const database = await this.openDatabase();
    await this.transaction<void>(database, "readwrite", (store, resolve, reject) => {
      const request = store.delete(WORKSPACE_PASSPHRASE_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Could not forget remembered workspace passphrase."));
    });
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new Error("IndexedDB is not available in this browser."));
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(PASSPHRASE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(PASSPHRASE_STORE_NAME)) {
          database.createObjectStore(PASSPHRASE_STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open remembered passphrase store."));
    });
  }

  private transaction<T>(
    database: IDBDatabase,
    mode: IDBTransactionMode,
    callback: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(PASSPHRASE_STORE_NAME, mode);
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => {
        database.close();
        reject(transaction.error ?? new Error("Remembered passphrase transaction failed."));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error ?? new Error("Remembered passphrase transaction was aborted."));
      };
      const store = transaction.objectStore(PASSPHRASE_STORE_NAME);
      callback(store, resolve, reject);
    });
  }
}

export const browserSecretVaultStatus = {
  inputSource: "Apple Passwords, browser password manager autofill, or remembered browser passphrase",
  localProtection: "Provider secrets are encrypted locally with the workspace passphrase",
  passphrasePolicy: "Workspace passphrase can be remembered in this browser IndexedDB when explicitly enabled",
  syncPolicy: "Secrets are excluded from workspace files, GitHub ChangeSet sync, Firebase snapshots, and evidence exports",
  nativeUpgrade: "Native builds can replace this adapter with Keychain storage later"
};
