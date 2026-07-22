import type { ChangeSet, Id, WorkspaceSnapshot } from "./types";
import { browserFetch } from "./http";
import { normalizeWorkspaceSnapshot } from "./projectLifecycle";
import { CURRENT_WORKSPACE_SCHEMA_VERSION, migrateWorkspaceToSchema3 } from "./workspaceMigration";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const syncKdfIterations = 210_000;

function assertSupportedWorkspaceSchemaVersion(value: unknown, source: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${source} has an invalid workspace schema version.`);
  }
  if (value > CURRENT_WORKSPACE_SCHEMA_VERSION) {
    throw new Error(`${source} uses unsupported future workspace schema ${value}; update OmniPlan before continuing.`);
  }
}

function assertFirebaseManifestCompatible(manifest: FirebaseE2eeManifest | undefined): void {
  if (!manifest) return;
  assertSupportedWorkspaceSchemaVersion(
    manifest.minimumClientWorkspaceSchemaVersion,
    "Firebase manifest minimum client requirement"
  );
  assertSupportedWorkspaceSchemaVersion(manifest.workspaceSchemaVersion, "Firebase manifest");
}

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

export interface FirebaseE2eeSyncConfig {
  projectId: string;
  apiKey: string;
  databaseId: string;
  collectionPath: string;
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

export interface FirebaseWorkspaceSnapshotEnvelope {
  schemaVersion: 1;
  /** Domain schema inside the encrypted payload. Missing means legacy schema 1/2. */
  workspaceSchemaVersion?: number;
  workspaceId: Id;
  deviceId: Id;
  revision: string;
  previousRevision?: string;
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

export interface FirebaseE2eeManifest {
  schemaVersion: 1;
  workspaceSchemaVersion?: number;
  minimumClientWorkspaceSchemaVersion?: number;
  /** Firestore document version used for compare-and-swap; never serialized into manifestJson. */
  firestoreUpdateTime?: string;
  provider: "firebase-firestore-e2ee";
  workspaceId: Id;
  latestRevision: string;
  updatedAt: string;
  updatedByDeviceId: Id;
  snapshotDocumentPath: string;
  heads: Record<Id, { revision: string; updatedAt: string }>;
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

export class FirebaseSyncConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirebaseSyncConflictError";
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

export function buildFirebaseSyncPaths(config: Pick<FirebaseE2eeSyncConfig, "collectionPath" | "workspaceId">) {
  const root = joinRepoPath(config.collectionPath || "omniPlanSync", config.workspaceId);
  return {
    manifest: joinRepoPath(root, "manifest", "current"),
    snapshot: joinRepoPath(root, "snapshots", "latest"),
    opDirectory: joinRepoPath(root, "ops")
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

export async function workspacePlaintextChecksum(snapshot: WorkspaceSnapshot): Promise<string> {
  return sha256Hex(stableJson(normalizeWorkspaceSnapshot(snapshot)));
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

export async function createFirebaseWorkspaceSnapshotEnvelope(
  snapshot: WorkspaceSnapshot,
  config: Pick<FirebaseE2eeSyncConfig, "workspaceId" | "deviceId">,
  previousRevision: string | undefined,
  passphrase: string,
  createdAt: string
): Promise<FirebaseWorkspaceSnapshotEnvelope> {
  const normalizedSnapshot = normalizeWorkspaceSnapshot(snapshot);
  const plaintextChecksum = await workspacePlaintextChecksum(normalizedSnapshot);
  const revision = await sha256Hex(`${previousRevision ?? "root"}\n${config.deviceId}\n${createdAt}\n${plaintextChecksum}`);
  return {
    schemaVersion: 1,
    workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
    workspaceId: config.workspaceId,
    deviceId: config.deviceId,
    revision,
    ...(previousRevision ? { previousRevision } : {}),
    createdAt,
    plaintextChecksum,
    payload: await encryptSyncPayload(normalizedSnapshot, passphrase)
  };
}

export async function decryptFirebaseWorkspaceSnapshotEnvelope(
  envelope: FirebaseWorkspaceSnapshotEnvelope,
  passphrase: string
): Promise<WorkspaceSnapshot> {
  assertSupportedWorkspaceSchemaVersion(envelope.workspaceSchemaVersion, "Firebase snapshot envelope");
  const snapshot = await decryptSyncPayload<unknown>(envelope.payload, passphrase);
  const checksum = await sha256Hex(stableJson(snapshot));
  if (checksum !== envelope.plaintextChecksum) {
    throw new Error("Firebase workspace checksum mismatch after decrypt.");
  }
  const embeddedSchemaVersion = typeof snapshot === "object" && snapshot !== null && "schemaVersion" in snapshot
    ? (snapshot as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  assertSupportedWorkspaceSchemaVersion(embeddedSchemaVersion, "Encrypted Firebase workspace");
  if (
    envelope.workspaceSchemaVersion !== undefined &&
    embeddedSchemaVersion !== undefined &&
    envelope.workspaceSchemaVersion !== embeddedSchemaVersion
  ) {
    throw new Error(
      `Firebase snapshot schema mismatch: envelope declares ${envelope.workspaceSchemaVersion}, payload declares ${String(embeddedSchemaVersion)}.`
    );
  }
  const sourceSchemaVersion = envelope.workspaceSchemaVersion ?? embeddedSchemaVersion ?? 1;
  return migrateWorkspaceToSchema3({ schemaVersion: sourceSchemaVersion, snapshot }).snapshot as WorkspaceSnapshot;
}

export function createFirebaseE2eeManifest(
  config: FirebaseE2eeSyncConfig,
  envelope: FirebaseWorkspaceSnapshotEnvelope,
  previous?: FirebaseE2eeManifest
): FirebaseE2eeManifest {
  assertFirebaseManifestCompatible(previous);
  assertSupportedWorkspaceSchemaVersion(envelope.workspaceSchemaVersion, "Firebase snapshot envelope");
  return {
    schemaVersion: 1,
    workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
    minimumClientWorkspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
    provider: "firebase-firestore-e2ee",
    workspaceId: config.workspaceId,
    latestRevision: envelope.revision,
    updatedAt: envelope.createdAt,
    updatedByDeviceId: config.deviceId,
    snapshotDocumentPath: buildFirebaseSyncPaths(config).snapshot,
    heads: {
      ...(previous?.heads ?? {}),
      [config.deviceId]: {
        revision: envelope.revision,
        updatedAt: envelope.createdAt
      }
    }
  };
}

export function githubSyncCommitMessage(envelope: SyncChangeEnvelope): string {
  return `OmniPlan sync ${envelope.workspaceId} ${envelope.revision.slice(0, 12)}`;
}

export class GitHubPrivateRepoSyncClient {
  constructor(
    private readonly config: GitHubSyncConfig,
    private readonly token: string,
    private readonly fetcher: typeof fetch = browserFetch
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

type FirestoreValue = { stringValue: string } | { integerValue: string } | { booleanValue: boolean };
type FirestoreDocument = {
  name?: string;
  fields?: Record<string, FirestoreValue>;
  createTime?: string;
  updateTime?: string;
};

type FirestorePrecondition = { exists: boolean } | { updateTime: string };
type FirestoreWrite = {
  path: string;
  fields: Record<string, FirestoreValue>;
  currentDocument?: FirestorePrecondition;
};

export interface FirebaseAnonymousSession {
  idToken: string;
  refreshToken?: string;
  localId: string;
  expiresIn?: number;
}

export interface FirebaseWorkspacePushResult {
  manifest: FirebaseE2eeManifest;
  envelope: FirebaseWorkspaceSnapshotEnvelope;
  commitTime?: string;
}

export interface FirebaseWorkspacePullResult {
  manifest: FirebaseE2eeManifest;
  envelope: FirebaseWorkspaceSnapshotEnvelope;
  workspace: WorkspaceSnapshot;
}

export class FirebaseE2eeSyncClient {
  constructor(
    private readonly config: FirebaseE2eeSyncConfig,
    private readonly fetcher: typeof fetch = browserFetch
  ) {}

  async signInAnonymously(): Promise<FirebaseAnonymousSession> {
    const response = await this.fetcher(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(this.config.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true })
    });
    if (!response.ok) throw new Error(`Firebase anonymous sign-in failed: ${response.status}`);
    const payload = await response.json() as { idToken: string; refreshToken?: string; localId: string; expiresIn?: string };
    return {
      idToken: payload.idToken,
      refreshToken: payload.refreshToken,
      localId: payload.localId,
      expiresIn: payload.expiresIn ? Number(payload.expiresIn) : undefined
    };
  }

  async readManifest(session: FirebaseAnonymousSession): Promise<FirebaseE2eeManifest | undefined> {
    const document = await this.readDocument(buildFirebaseSyncPaths(this.config).manifest, session);
    if (!document) return undefined;
    const manifest = this.parseJsonField<FirebaseE2eeManifest>(document, "manifestJson");
    assertFirebaseManifestCompatible(manifest);
    if (document.updateTime) {
      Object.defineProperty(manifest, "firestoreUpdateTime", {
        value: document.updateTime,
        enumerable: false,
        writable: false,
        configurable: false
      });
    }
    return manifest;
  }

  async readLatestSnapshotEnvelope(session: FirebaseAnonymousSession): Promise<FirebaseWorkspaceSnapshotEnvelope | undefined> {
    const document = await this.readDocument(buildFirebaseSyncPaths(this.config).snapshot, session);
    return document ? this.parseJsonField<FirebaseWorkspaceSnapshotEnvelope>(document, "envelopeJson") : undefined;
  }

  async pushWorkspaceSnapshot(
    snapshot: WorkspaceSnapshot,
    passphrase: string,
    session: FirebaseAnonymousSession,
    previousManifest?: FirebaseE2eeManifest
  ): Promise<FirebaseWorkspacePushResult> {
    assertFirebaseManifestCompatible(previousManifest);
    const manifestPrecondition: FirestorePrecondition = previousManifest
      ? previousManifest.firestoreUpdateTime
        ? { updateTime: previousManifest.firestoreUpdateTime }
        : (() => {
            throw new FirebaseSyncConflictError("Firebase manifest version is unavailable. Read the latest manifest before pushing.");
          })()
      : { exists: false };
    const createdAt = new Date().toISOString();
    const envelope = await createFirebaseWorkspaceSnapshotEnvelope(
      snapshot,
      { workspaceId: this.config.workspaceId, deviceId: this.config.deviceId },
      previousManifest?.latestRevision,
      passphrase,
      createdAt
    );
    const manifest = createFirebaseE2eeManifest(this.config, envelope, previousManifest);
    const paths = buildFirebaseSyncPaths(this.config);
    const commit = await this.commitDocuments([
      {
        path: paths.snapshot,
        fields: {
          schemaVersion: { integerValue: "1" },
          workspaceSchemaVersion: { integerValue: String(CURRENT_WORKSPACE_SCHEMA_VERSION) },
          workspaceId: { stringValue: this.config.workspaceId },
          revision: { stringValue: envelope.revision },
          updatedAt: { stringValue: envelope.createdAt },
          envelopeJson: { stringValue: JSON.stringify(envelope) }
        }
      },
      {
        path: joinRepoPath(paths.opDirectory, envelope.revision),
        currentDocument: { exists: false },
        fields: {
          schemaVersion: { integerValue: "1" },
          workspaceSchemaVersion: { integerValue: String(CURRENT_WORKSPACE_SCHEMA_VERSION) },
          workspaceId: { stringValue: this.config.workspaceId },
          deviceId: { stringValue: this.config.deviceId },
          revision: { stringValue: envelope.revision },
          previousRevision: { stringValue: envelope.previousRevision ?? "" },
          createdAt: { stringValue: envelope.createdAt },
          envelopeJson: { stringValue: JSON.stringify(envelope) }
        }
      },
      {
        path: paths.manifest,
        currentDocument: manifestPrecondition,
        fields: {
          schemaVersion: { integerValue: "1" },
          workspaceSchemaVersion: { integerValue: String(CURRENT_WORKSPACE_SCHEMA_VERSION) },
          workspaceId: { stringValue: this.config.workspaceId },
          latestRevision: { stringValue: manifest.latestRevision },
          updatedAt: { stringValue: manifest.updatedAt },
          manifestJson: { stringValue: JSON.stringify(manifest) }
        }
      }
    ], session);
    return { manifest, envelope, commitTime: commit.commitTime };
  }

  async pullWorkspaceSnapshot(passphrase: string, session: FirebaseAnonymousSession): Promise<FirebaseWorkspacePullResult> {
    const manifest = await this.readManifest(session);
    if (!manifest) throw new Error("Firebase workspace manifest does not exist yet.");
    assertFirebaseManifestCompatible(manifest);
    const envelope = await this.readLatestSnapshotEnvelope(session);
    if (!envelope) throw new Error("Firebase latest workspace snapshot does not exist yet.");
    if (envelope.revision !== manifest.latestRevision) {
      throw new FirebaseSyncConflictError("Firebase manifest and latest snapshot revision differ. Push or pull again after the writer finishes.");
    }
    assertSupportedWorkspaceSchemaVersion(envelope.workspaceSchemaVersion, "Firebase snapshot envelope");
    const workspace = await decryptFirebaseWorkspaceSnapshotEnvelope(envelope, passphrase);
    return { manifest, envelope, workspace };
  }

  private async readDocument(path: string, session: FirebaseAnonymousSession): Promise<FirestoreDocument | undefined> {
    const response = await this.fetcher(this.documentUrl(path), {
      headers: this.headers(session)
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Firebase read failed for ${path}: ${response.status}`);
    return await response.json() as FirestoreDocument;
  }

  private async commitDocuments(
    documents: FirestoreWrite[],
    session: FirebaseAnonymousSession
  ): Promise<{ commitTime?: string }> {
    const response = await this.fetcher(this.commitUrl(), {
      method: "POST",
      headers: {
        ...this.headers(session),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        writes: documents.map((document) => ({
          update: {
            name: this.documentName(document.path),
            fields: document.fields
          },
          ...(document.currentDocument ? { currentDocument: document.currentDocument } : {})
        }))
      })
    });
    if (!response.ok) {
      let firestoreStatus = "";
      try {
        const payload = await response.json() as { error?: { status?: string; message?: string } };
        firestoreStatus = `${payload.error?.status ?? ""} ${payload.error?.message ?? ""}`.trim();
      } catch {
        // The HTTP status is still sufficient for a conflict-safe failure.
      }
      if (response.status === 409 || /FAILED_PRECONDITION|ABORTED/.test(firestoreStatus)) {
        throw new FirebaseSyncConflictError("Firebase workspace changed while this device was pushing. Pull the latest workspace before retrying.");
      }
      throw new Error(`Firebase commit failed: ${response.status}${firestoreStatus ? ` (${firestoreStatus})` : ""}`);
    }
    return await response.json() as { commitTime?: string };
  }

  private parseJsonField<T>(document: FirestoreDocument, fieldName: string): T {
    const value = document.fields?.[fieldName];
    if (!value || !("stringValue" in value)) throw new Error(`Firebase document is missing ${fieldName}.`);
    return JSON.parse(value.stringValue) as T;
  }

  private documentUrl(path: string): string {
    return `${this.documentsBaseUrl()}/${this.encodeFirestorePath(path)}`;
  }

  private commitUrl(): string {
    return `${this.documentsBaseUrl()}:commit`;
  }

  private documentName(path: string): string {
    return `projects/${encodeURIComponent(this.config.projectId)}/databases/${encodeURIComponent(this.config.databaseId || "(default)")}/documents/${this.encodeFirestorePath(path)}`;
  }

  private documentsBaseUrl(): string {
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/databases/${encodeURIComponent(this.config.databaseId || "(default)")}/documents`;
  }

  private encodeFirestorePath(path: string): string {
    return joinRepoPath(path).split("/").map(encodeURIComponent).join("/");
  }

  private headers(session: FirebaseAnonymousSession): HeadersInit {
    return {
      Authorization: `Bearer ${session.idToken}`
    };
  }
}

export const githubPrivateRepoSyncStatus = {
  selected: true,
  provider: "GitHub Private Repo",
  sourceOfTruth: "Browser local DB",
  remoteTruth: "Encrypted ChangeSet log",
  secretBoundary: "Provider keys are never written to workspace files or GitHub sync objects",
  secretSync: "Apple Passwords or remembered browser passphrase handles local key entry",
  tokenPermission: "Fine-grained PAT with Contents read/write on one private repo",
  rootPath: ".omni-plan",
  conflictPolicy: "GitHub 409 or divergent device heads become Sync Conflict audit gates"
};

export const firebaseE2eeSyncStatus = {
  selected: true,
  provider: "Firebase Firestore",
  sourceOfTruth: "Browser local DB plus encrypted remote workspace snapshot",
  remoteTruth: "End-to-end encrypted latest snapshot and operation log",
  encryption: "AES-GCM with PBKDF2-SHA256 passphrase-derived key",
  secretBoundary: "Firebase stores ciphertext only; passphrase and provider keys never leave the device",
  authModel: "Firebase anonymous auth for transport access; workspace passphrase controls decryption",
  conflictPolicy: "Manifest compare-and-swap rejects concurrent writers; divergent local and remote changes require review"
};
