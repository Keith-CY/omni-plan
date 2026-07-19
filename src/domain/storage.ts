import type { WorkspaceSnapshot } from "./types";
import { normalizeWorkspaceSnapshot } from "./projectLifecycle";

export interface WorkspaceRepository {
  load(): Promise<WorkspaceSnapshot | undefined>;
  save(snapshot: WorkspaceSnapshot): Promise<void>;
  exportWorkspace(snapshot: WorkspaceSnapshot): string;
  importWorkspace(payload: string): WorkspaceSnapshot;
  subscribe(
    getCurrentSnapshot: () => WorkspaceSnapshot | undefined,
    listener: (change: IncomingWorkspaceChange) => void
  ): () => void;
}

export const WORKSPACE_STORAGE_KEY = "omni-plan-personal.workspace.v1";

export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WorkspaceStorageEventLike {
  key: string | null;
  oldValue: string | null;
  newValue: string | null;
}

export interface WorkspaceStorageEventSource {
  addEventListener(type: "storage", listener: (event: WorkspaceStorageEventLike) => void): void;
  removeEventListener(type: "storage", listener: (event: WorkspaceStorageEventLike) => void): void;
}

export interface BrowserWorkspaceRepositoryOptions {
  storage?: WorkspaceStorage;
  eventSource?: WorkspaceStorageEventSource;
}

export type IncomingWorkspaceChange =
  | {
      decision: "apply";
      snapshot: WorkspaceSnapshot;
      fingerprint: string;
      baseFingerprint?: string;
    }
  | {
      decision: "ignore";
      reason: "unrelated-key" | "missing-payload" | "invalid-payload" | "same-content";
    }
  | {
      decision: "conflict";
      reason: "diverged" | "unverifiable-base";
      incomingSnapshot: WorkspaceSnapshot;
      currentFingerprint: string;
      incomingFingerprint: string;
      baseFingerprint?: string;
    };

interface WorkspaceEnvelope {
  schemaVersion: number;
  exportedAt?: string;
  baseFingerprint?: string;
  snapshot: WorkspaceSnapshot;
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

const sha256Constants = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

function sha256(value: string): string {
  const input = new TextEncoder().encode(value);
  const byteLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(byteLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const bitLength = input.length * 8;
  view.setUint32(byteLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(byteLength - 4, bitLength >>> 0);

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const words = new Uint32Array(64);

  for (let offset = 0; offset < byteLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + sha256Constants[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function parseWorkspaceEnvelope(payload: string): WorkspaceEnvelope {
  const parsed = JSON.parse(payload) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid workspace payload");
  const envelope = parsed as Partial<WorkspaceEnvelope>;
  if (envelope.schemaVersion !== 1 && envelope.schemaVersion !== 2) {
    throw new Error(`Unsupported workspace schema version ${String(envelope.schemaVersion)}`);
  }
  if (envelope.baseFingerprint !== undefined && typeof envelope.baseFingerprint !== "string") {
    throw new Error("Workspace base fingerprint is invalid");
  }
  if (!envelope.snapshot || typeof envelope.snapshot !== "object") throw new Error("Workspace snapshot is missing");
  return envelope as WorkspaceEnvelope;
}

function importWorkspacePayload(payload: string): WorkspaceSnapshot {
  return normalizeWorkspaceSnapshot(parseWorkspaceEnvelope(payload).snapshot);
}

/**
 * Returns a canonical SHA-256 comparison value for workspace content.
 * Envelope metadata such as exportedAt is intentionally excluded.
 */
export function workspaceFingerprint(snapshot: WorkspaceSnapshot): string {
  return sha256(stableJson(normalizeWorkspaceSnapshot(snapshot)));
}

export function workspacePayloadFingerprint(payload: string): string {
  return workspaceFingerprint(importWorkspacePayload(payload));
}

export function resolveIncomingWorkspaceChange(
  currentSnapshot: WorkspaceSnapshot | undefined,
  event: WorkspaceStorageEventLike
): IncomingWorkspaceChange {
  if (event.key !== WORKSPACE_STORAGE_KEY) return { decision: "ignore", reason: "unrelated-key" };
  if (!event.newValue) return { decision: "ignore", reason: "missing-payload" };

  let incomingEnvelope: WorkspaceEnvelope;
  let incomingSnapshot: WorkspaceSnapshot;
  let incomingFingerprint: string;
  try {
    incomingEnvelope = parseWorkspaceEnvelope(event.newValue);
    incomingSnapshot = normalizeWorkspaceSnapshot(incomingEnvelope.snapshot);
    incomingFingerprint = workspaceFingerprint(incomingSnapshot);
  } catch {
    return { decision: "ignore", reason: "invalid-payload" };
  }

  if (!currentSnapshot) {
    return {
      decision: "apply",
      snapshot: incomingSnapshot,
      fingerprint: incomingFingerprint,
      baseFingerprint: incomingEnvelope.baseFingerprint
    };
  }

  const currentFingerprint = workspaceFingerprint(currentSnapshot);
  if (currentFingerprint === incomingFingerprint) return { decision: "ignore", reason: "same-content" };

  if (incomingEnvelope.baseFingerprint === currentFingerprint) {
    return {
      decision: "apply",
      snapshot: incomingSnapshot,
      fingerprint: incomingFingerprint,
      baseFingerprint: incomingEnvelope.baseFingerprint
    };
  }

  return {
    decision: "conflict",
    reason: incomingEnvelope.baseFingerprint ? "diverged" : "unverifiable-base",
    incomingSnapshot,
    currentFingerprint,
    incomingFingerprint,
    baseFingerprint: incomingEnvelope.baseFingerprint
  };
}

function browserStorage(): WorkspaceStorage {
  if (typeof localStorage === "undefined") throw new Error("Browser workspace storage is unavailable");
  return localStorage;
}

function browserStorageEvents(): WorkspaceStorageEventSource | undefined {
  if (typeof window === "undefined") return undefined;
  return {
    addEventListener: (_type, listener) => window.addEventListener("storage", listener as unknown as EventListener),
    removeEventListener: (_type, listener) => window.removeEventListener("storage", listener as unknown as EventListener)
  };
}

export class BrowserWorkspaceRepository implements WorkspaceRepository {
  private readonly injectedStorage?: WorkspaceStorage;
  private readonly injectedEventSource?: WorkspaceStorageEventSource;
  private lastKnownFingerprint?: string;

  constructor(options: BrowserWorkspaceRepositoryOptions = {}) {
    this.injectedStorage = options.storage;
    this.injectedEventSource = options.eventSource;
  }

  async load(): Promise<WorkspaceSnapshot | undefined> {
    const raw = (this.injectedStorage ?? browserStorage()).getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return undefined;
    const snapshot = this.importWorkspace(raw);
    this.lastKnownFingerprint = workspaceFingerprint(snapshot);
    return snapshot;
  }

  async save(snapshot: WorkspaceSnapshot): Promise<void> {
    const fingerprint = workspaceFingerprint(snapshot);
    (this.injectedStorage ?? browserStorage()).setItem(WORKSPACE_STORAGE_KEY, this.exportWorkspace(snapshot));
    this.lastKnownFingerprint = fingerprint;
  }

  exportWorkspace(snapshot: WorkspaceSnapshot): string {
    return JSON.stringify({
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      baseFingerprint: this.lastKnownFingerprint,
      snapshot: normalizeWorkspaceSnapshot(snapshot)
    }, null, 2);
  }

  importWorkspace(payload: string): WorkspaceSnapshot {
    return importWorkspacePayload(payload);
  }

  subscribe(
    getCurrentSnapshot: () => WorkspaceSnapshot | undefined,
    listener: (change: IncomingWorkspaceChange) => void
  ): () => void {
    const eventSource = this.injectedEventSource ?? browserStorageEvents();
    if (!eventSource) return () => undefined;
    const handleStorage = (event: WorkspaceStorageEventLike) => {
      const change = resolveIncomingWorkspaceChange(getCurrentSnapshot(), event);
      listener(change);
      if (change.decision === "apply") this.lastKnownFingerprint = change.fingerprint;
      if (change.decision === "ignore" && change.reason === "same-content") {
        const currentSnapshot = getCurrentSnapshot();
        if (currentSnapshot) this.lastKnownFingerprint = workspaceFingerprint(currentSnapshot);
      }
    };
    eventSource.addEventListener("storage", handleStorage);
    return () => eventSource.removeEventListener("storage", handleStorage);
  }
}

export const browserWorkspaceStorageStatus = {
  selected: true,
  implemented: true,
  engine: "Browser local workspace store",
  sourceOfTruth: "Browser local DB for this preview",
  backupPolicy: "Manual encrypted export/import for transfer; GitHub sync handles cross-device ChangeSets",
  persistence: "Automatic save after local workspace edits"
};
