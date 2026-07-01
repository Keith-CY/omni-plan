import type { ChangeSet, Id } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const syncKdfIterations = 210_000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/\s/g, "")), (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function joinRepoPath(...parts: string[]): string {
  return parts
    .flatMap((part) => part.split("/"))
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

function encodeRepoPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deriveSyncKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: toArrayBuffer(salt), iterations: syncKdfIterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export interface GitHubSyncConfig {
  owner: string;
  repo: string;
  branch: string;
  rootPath: string;
  workspaceId: Id;
  deviceId: Id;
}

export interface GitHubSyncPaths {
  manifest: string;
  changeSetDirectory: string;
  snapshotDirectory: string;
}

export interface EncryptedSyncPayload {
  algorithm: "AES-GCM";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface SyncChangeEnvelope {
  schemaVersion: 1;
  workspaceId: Id;
  deviceId: Id;
  sequence: number;
  baseRevision: string;
  revision: string;
  createdAt: string;
  plaintextChecksum: string;
  payload: EncryptedSyncPayload;
}

export interface SyncManifest {
  schemaVersion: 1;
  workspaceId: Id;
  provider: "github-private-repo";
  branch: string;
  rootPath: string;
  latestRevision: string;
  heads: Record<Id, { sequence: number; revision: string; updatedAt: string }>;
  updatedAt: string;
}

export interface GitHubRepoTextFile {
  path: string;
  sha: string;
  content: string;
}

export interface GitHubWriteResult {
  path: string;
  contentSha?: string;
  commitSha?: string;
}

export class GitHubSyncConflictError extends Error {
  constructor(path: string) {
    super(`GitHub sync conflict while updating ${path}`);
    this.name = "GitHubSyncConflictError";
  }
}

export function buildGitHubSyncPaths(config: Pick<GitHubSyncConfig, "rootPath" | "workspaceId" | "deviceId">): GitHubSyncPaths {
  const workspaceRoot = joinRepoPath(config.rootPath, "workspaces", config.workspaceId);
  return {
    manifest: joinRepoPath(workspaceRoot, "manifest.json"),
    changeSetDirectory: joinRepoPath(workspaceRoot, "changes", config.deviceId),
    snapshotDirectory: joinRepoPath(workspaceRoot, "snapshots")
  };
}

export function buildChangeEnvelopePath(config: Pick<GitHubSyncConfig, "rootPath" | "workspaceId" | "deviceId">, envelope: SyncChangeEnvelope): string {
  const sequence = String(envelope.sequence).padStart(8, "0");
  return joinRepoPath(buildGitHubSyncPaths(config).changeSetDirectory, `${sequence}-${envelope.revision.slice(0, 12)}.json.enc`);
}

export function createSyncManifest(config: GitHubSyncConfig, envelope: SyncChangeEnvelope, previous?: SyncManifest): SyncManifest {
  return {
    schemaVersion: 1,
    workspaceId: config.workspaceId,
    provider: "github-private-repo",
    branch: config.branch,
    rootPath: config.rootPath,
    latestRevision: envelope.revision,
    heads: {
      ...(previous?.heads ?? {}),
      [config.deviceId]: {
        sequence: envelope.sequence,
        revision: envelope.revision,
        updatedAt: envelope.createdAt
      }
    },
    updatedAt: envelope.createdAt
  };
}

export async function encryptSyncPayload(value: unknown, passphrase: string): Promise<EncryptedSyncPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveSyncKey(passphrase, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(encoder.encode(stableJson(value))))
  );

  return {
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: syncKdfIterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext)
  };
}

export async function decryptSyncPayload<T>(payload: EncryptedSyncPayload, passphrase: string): Promise<T> {
  const key = await deriveSyncKey(passphrase, base64ToBytes(payload.salt));
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(payload.iv)) },
    key,
    toArrayBuffer(base64ToBytes(payload.ciphertext))
  );
  return JSON.parse(decoder.decode(decrypted)) as T;
}

export async function createSyncChangeEnvelope(
  changeSet: ChangeSet,
  config: Pick<GitHubSyncConfig, "workspaceId" | "deviceId">,
  sequence: number,
  baseRevision: string,
  passphrase: string,
  createdAt: string
): Promise<SyncChangeEnvelope> {
  const plaintextChecksum = await sha256Hex(stableJson(changeSet));
  const revision = await sha256Hex(`${baseRevision}\n${config.deviceId}\n${sequence}\n${plaintextChecksum}`);
  return {
    schemaVersion: 1,
    workspaceId: config.workspaceId,
    deviceId: config.deviceId,
    sequence,
    baseRevision,
    revision,
    createdAt,
    plaintextChecksum,
    payload: await encryptSyncPayload(changeSet, passphrase)
  };
}

export function githubSyncCommitMessage(envelope: SyncChangeEnvelope): string {
  return `OmniPlan sync ${envelope.workspaceId} ${envelope.revision.slice(0, 12)}`;
}

export class GitHubPrivateRepoSyncClient {
  constructor(
    private readonly config: GitHubSyncConfig,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async readText(path: string): Promise<GitHubRepoTextFile | undefined> {
    const response = await this.fetcher(this.contentUrl(path, true), {
      headers: this.headers()
    });

    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub sync read failed for ${path}: ${response.status}`);

    const payload = (await response.json()) as { path: string; sha: string; content: string; type: string };
    if (payload.type !== "file") throw new Error(`GitHub sync path is not a file: ${path}`);
    return {
      path: payload.path,
      sha: payload.sha,
      content: decoder.decode(base64ToBytes(payload.content))
    };
  }

  async writeText(path: string, content: string, message: string, sha?: string): Promise<GitHubWriteResult> {
    const response = await this.fetcher(this.contentUrl(path), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({
        message,
        content: bytesToBase64(encoder.encode(content)),
        branch: this.config.branch,
        ...(sha ? { sha } : {})
      })
    });

    if (response.status === 409) throw new GitHubSyncConflictError(path);
    if (!response.ok) throw new Error(`GitHub sync write failed for ${path}: ${response.status}`);

    const payload = (await response.json()) as { content?: { path: string; sha: string }; commit?: { sha: string } };
    return {
      path: payload.content?.path ?? path,
      contentSha: payload.content?.sha,
      commitSha: payload.commit?.sha
    };
  }

  private contentUrl(path: string, withRef = false): string {
    const base = `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}/contents/${encodeRepoPath(path)}`;
    return withRef ? `${base}?ref=${encodeURIComponent(this.config.branch)}` : base;
  }

  private headers(): HeadersInit {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }
}

export const githubPrivateRepoSyncStatus = {
  selected: true,
  provider: "GitHub Private Repo",
  sourceOfTruth: "Browser local DB",
  remoteTruth: "Encrypted ChangeSet log",
  secretBoundary: "Provider keys are never written to workspace files or GitHub sync objects",
  secretSync: "Apple Passwords autofill handles cross-device key entry",
  tokenPermission: "Fine-grained PAT with Contents read/write on one private repo",
  rootPath: ".omni-plan",
  conflictPolicy: "GitHub 409 or divergent device heads become Sync Conflict audit gates"
};
