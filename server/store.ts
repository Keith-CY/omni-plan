import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export type TokenScope = "capture" | "owner";

export interface CapturePayload {
  title: string;
  note?: string;
  estimateSeconds?: number;
  plannedForDate?: string;
  localStartTime?: string;
  plannedStart?: string;
  plannedFinish?: string;
  source: "shortcut" | "alfred" | "share" | "agent";
}

export interface StoredCapture extends CapturePayload {
  id: string;
  idempotencyKey: string;
  receivedAt: string;
  expiresAt: string;
}

export interface StoredSubscription {
  id: string;
  endpoint: string;
  expirationTime?: number;
  keys: { p256dh: string; auth: string };
  createdAt: string;
  updatedAt: string;
}

export interface ReminderEnvelope {
  id: string;
  revision: number;
  dueAt: string;
  route: string;
  taskId?: string;
  title?: string;
  showTitle: boolean;
  cancelled: boolean;
}

export interface TokenRecord {
  id: string;
  name: string;
  scope: TokenScope;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export class CaptureStore {
  readonly db: Database;

  constructor(path = process.env.OMNIPLAN_DB_PATH || ".data/omni-plan.sqlite") {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(schema);
  }

  close() {
    this.db.close();
  }

  createToken(name: string, scope: TokenScope, now = new Date().toISOString()) {
    const id = randomUUID();
    const token = `op_${scope}_${randomBytes(32).toString("base64url")}`;
    this.db.query(`INSERT INTO tokens (id, name, scope, token_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, name.trim().slice(0, 80) || "Unnamed device", scope, tokenHash(token), now);
    return { id, token, name: name.trim().slice(0, 80) || "Unnamed device", scope, createdAt: now };
  }

  authenticate(token: string, allowedScopes: readonly TokenScope[], now = new Date().toISOString()): TokenRecord | undefined {
    const row = this.db.query(`
      SELECT id, name, scope, created_at, last_used_at, revoked_at
      FROM tokens WHERE token_hash = ? AND revoked_at IS NULL
    `).get(tokenHash(token)) as TokenRow | null;
    if (!row || !allowedScopes.includes(row.scope)) return undefined;
    this.db.query(`UPDATE tokens SET last_used_at = ? WHERE id = ?`).run(now, row.id);
    return tokenFromRow({ ...row, last_used_at: now });
  }

  listTokens(): TokenRecord[] {
    const rows = this.db.query(`SELECT id, name, scope, created_at, last_used_at, revoked_at FROM tokens ORDER BY created_at DESC`).all() as TokenRow[];
    return rows.map(tokenFromRow);
  }

  revokeToken(id: string, now = new Date().toISOString()): boolean {
    this.db.query(`UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now, id);
    return this.changeCount() > 0;
  }

  revokeAllCaptureTokens(now = new Date().toISOString()): number {
    this.db.query(`UPDATE tokens SET revoked_at = ? WHERE scope = 'capture' AND revoked_at IS NULL`).run(now);
    return this.changeCount();
  }

  takeRateLimit(tokenId: string, maxPerMinute = 30, now = new Date()): boolean {
    const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
    const transaction = this.db.transaction(() => {
      const row = this.db.query(`SELECT count FROM rate_limits WHERE token_id = ? AND window_start = ?`).get(tokenId, windowStart) as { count: number } | null;
      if ((row?.count ?? 0) >= maxPerMinute) return false;
      this.db.query(`
        INSERT INTO rate_limits (token_id, window_start, count) VALUES (?, ?, 1)
        ON CONFLICT(token_id, window_start) DO UPDATE SET count = count + 1
      `).run(tokenId, windowStart);
      return true;
    });
    const allowed = transaction();
    this.db.query(`DELETE FROM rate_limits WHERE window_start < ?`).run(new Date(now.getTime() - 120_000).toISOString());
    return allowed;
  }

  storeCapture(
    tokenId: string,
    idempotencyKey: string,
    payload: CapturePayload,
    now = new Date(),
    retentionDays = 7
  ): { status: "captured" | "duplicate"; capture: StoredCapture } {
    const id = randomUUID();
    const receivedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + retentionDays * 86_400_000).toISOString();
    this.db.query(`
      INSERT OR IGNORE INTO captures
        (id, token_id, idempotency_key, payload_json, received_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, tokenId, idempotencyKey, JSON.stringify(payload), receivedAt, expiresAt);
    const inserted = this.changeCount() > 0;
    const row = this.db.query(`
      SELECT id, idempotency_key, payload_json, received_at, expires_at
      FROM captures WHERE token_id = ? AND idempotency_key = ?
    `).get(tokenId, idempotencyKey) as CaptureRow;
    return { status: inserted ? "captured" : "duplicate", capture: captureFromRow(row) };
  }

  listCaptures(limit = 100, now = new Date().toISOString()): StoredCapture[] {
    this.cleanupExpiredCaptures(now);
    const rows = this.db.query(`
      SELECT id, idempotency_key, payload_json, received_at, expires_at
      FROM captures ORDER BY received_at ASC LIMIT ?
    `).all(Math.max(1, Math.min(200, Math.round(limit)))) as CaptureRow[];
    return rows.map(captureFromRow);
  }

  acknowledgeCaptures(ids: readonly string[]): number {
    if (!ids.length) return 0;
    const remove = this.db.query(`DELETE FROM captures WHERE id = ?`);
    return this.db.transaction(() => {
      let total = 0;
      for (const id of ids.slice(0, 200)) {
        remove.run(id);
        total += this.changeCount();
      }
      return total;
    })();
  }

  cleanupExpiredCaptures(now = new Date().toISOString()): number {
    this.db.query(`DELETE FROM captures WHERE expires_at <= ?`).run(now);
    return this.changeCount();
  }

  upsertSubscription(input: Omit<StoredSubscription, "id" | "createdAt" | "updatedAt">, now = new Date().toISOString()): StoredSubscription {
    const id = endpointId(input.endpoint);
    this.db.query(`
      INSERT INTO push_subscriptions (id, endpoint, expiration_time, p256dh, auth, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET endpoint = excluded.endpoint, expiration_time = excluded.expiration_time,
        p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at
    `).run(id, input.endpoint, input.expirationTime ?? null, input.keys.p256dh, input.keys.auth, now, now);
    return this.subscription(id)!;
  }

  subscription(id: string): StoredSubscription | undefined {
    const row = this.db.query(`
      SELECT id, endpoint, expiration_time, p256dh, auth, created_at, updated_at
      FROM push_subscriptions WHERE id = ?
    `).get(id) as SubscriptionRow | null;
    return row ? subscriptionFromRow(row) : undefined;
  }

  listSubscriptions(): StoredSubscription[] {
    return (this.db.query(`
      SELECT id, endpoint, expiration_time, p256dh, auth, created_at, updated_at
      FROM push_subscriptions ORDER BY created_at ASC
    `).all() as SubscriptionRow[]).map(subscriptionFromRow);
  }

  removeSubscriptionByEndpoint(endpoint: string): boolean {
    this.db.query(`DELETE FROM push_subscriptions WHERE id = ?`).run(endpointId(endpoint));
    return this.changeCount() > 0;
  }

  removeSubscription(id: string): boolean {
    this.db.query(`DELETE FROM push_subscriptions WHERE id = ?`).run(id);
    return this.changeCount() > 0;
  }

  upsertReminder(input: ReminderEnvelope, now = new Date().toISOString()): "stored" | "stale" {
    const existing = this.db.query(`SELECT revision FROM reminders WHERE id = ?`).get(input.id) as { revision: number } | null;
    if (existing && existing.revision > input.revision) return "stale";
    this.db.query(`
      INSERT INTO reminders (id, revision, due_at, route, task_id, title, show_title, cancelled, sent_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, -1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, due_at = excluded.due_at,
        route = excluded.route, task_id = excluded.task_id, title = excluded.title,
        show_title = excluded.show_title, cancelled = excluded.cancelled, updated_at = excluded.updated_at
    `).run(
      input.id,
      input.revision,
      input.dueAt,
      input.route,
      input.taskId ?? null,
      input.title ?? null,
      input.showTitle ? 1 : 0,
      input.cancelled ? 1 : 0,
      now,
      now
    );
    return "stored";
  }

  dueReminders(now = new Date().toISOString(), limit = 100): ReminderEnvelope[] {
    const rows = this.db.query(`
      SELECT id, revision, due_at, route, task_id, title, show_title, cancelled
      FROM reminders
      WHERE cancelled = 0 AND due_at <= ? AND sent_revision < revision
      ORDER BY due_at ASC LIMIT ?
    `).all(now, Math.max(1, Math.min(500, limit))) as ReminderRow[];
    return rows.map(reminderFromRow);
  }

  deliveryAlreadyRecorded(reminderId: string, revision: number, subscriptionId: string): boolean {
    return Boolean(this.db.query(`
      SELECT 1 AS present FROM push_deliveries
      WHERE reminder_id = ? AND revision = ? AND subscription_id = ? AND status = 'sent'
    `).get(reminderId, revision, subscriptionId));
  }

  recordDelivery(reminderId: string, revision: number, subscriptionId: string, status: "sent" | "failed", detail: string, now = new Date().toISOString()) {
    this.db.query(`
      INSERT OR REPLACE INTO push_deliveries
        (reminder_id, revision, subscription_id, status, detail, attempted_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(reminderId, revision, subscriptionId, status, detail.slice(0, 500), now);
  }

  markReminderSent(id: string, revision: number) {
    this.db.query(`UPDATE reminders SET sent_revision = MAX(sent_revision, ?) WHERE id = ?`).run(revision, id);
  }

  private changeCount(): number {
    const row = this.db.query(`SELECT changes() AS count`).get() as { count: number };
    return Number(row.count);
  }
}

interface TokenRow { id: string; name: string; scope: TokenScope; created_at: string; last_used_at: string | null; revoked_at: string | null }
interface CaptureRow { id: string; idempotency_key: string; payload_json: string; received_at: string; expires_at: string }
interface SubscriptionRow { id: string; endpoint: string; expiration_time: number | null; p256dh: string; auth: string; created_at: string; updated_at: string }
interface ReminderRow { id: string; revision: number; due_at: string; route: string; task_id: string | null; title: string | null; show_title: number; cancelled: number }

function tokenFromRow(row: TokenRow): TokenRecord {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    createdAt: row.created_at,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {})
  };
}

function captureFromRow(row: CaptureRow): StoredCapture {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    ...(JSON.parse(row.payload_json) as CapturePayload),
    receivedAt: row.received_at,
    expiresAt: row.expires_at
  };
}

function subscriptionFromRow(row: SubscriptionRow): StoredSubscription {
  return {
    id: row.id,
    endpoint: row.endpoint,
    ...(row.expiration_time === null ? {} : { expirationTime: row.expiration_time }),
    keys: { p256dh: row.p256dh, auth: row.auth },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function reminderFromRow(row: ReminderRow): ReminderEnvelope {
  return {
    id: row.id,
    revision: row.revision,
    dueAt: row.due_at,
    route: row.route,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.title ? { title: row.title } : {}),
    showTitle: row.show_title === 1,
    cancelled: row.cancelled === 1
  };
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function endpointId(endpoint: string) {
  return createHash("sha256").update(endpoint).digest("hex");
}

const schema = `
  CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('capture', 'owner')),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS captures (
    id TEXT PRIMARY KEY,
    token_id TEXT NOT NULL REFERENCES tokens(id),
    idempotency_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE(token_id, idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS rate_limits (
    token_id TEXT NOT NULL,
    window_start TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY(token_id, window_start)
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    expiration_time INTEGER,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    due_at TEXT NOT NULL,
    route TEXT NOT NULL,
    task_id TEXT,
    title TEXT,
    show_title INTEGER NOT NULL DEFAULT 0,
    cancelled INTEGER NOT NULL DEFAULT 0,
    sent_revision INTEGER NOT NULL DEFAULT -1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_deliveries (
    reminder_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    subscription_id TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT NOT NULL,
    attempted_at TEXT NOT NULL,
    PRIMARY KEY(reminder_id, revision, subscription_id)
  );
`;
