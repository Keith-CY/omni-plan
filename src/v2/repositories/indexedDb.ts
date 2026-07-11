export const V2_DATABASE_NAME = "omni-plan-personal-v2";
export const V2_DATABASE_VERSION = 1;

export const V2_OBJECT_STORES = {
  workspace: "workspace",
  outbox: "outbox",
  receipts: "receipts",
  backups: "backups",
  migrationRuns: "migrationRuns",
} as const;

export type V2ObjectStoreName =
  (typeof V2_OBJECT_STORES)[keyof typeof V2_OBJECT_STORES];

export interface IndexedDbOptions {
  databaseName?: string;
  indexedDB?: IDBFactory;
}

function resolveIndexedDb(factory: IDBFactory | undefined): IDBFactory {
  if (factory !== undefined) return factory;
  if (typeof globalThis.indexedDB === "undefined") {
    throw new Error("IndexedDB is unavailable in this environment.");
  }
  return globalThis.indexedDB;
}

function createSchema(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains(V2_OBJECT_STORES.workspace)) {
    database.createObjectStore(V2_OBJECT_STORES.workspace);
  }
  if (!database.objectStoreNames.contains(V2_OBJECT_STORES.outbox)) {
    const outbox = database.createObjectStore(V2_OBJECT_STORES.outbox, {
      keyPath: "id",
    });
    outbox.createIndex("commandId", "commandId", { unique: true });
    outbox.createIndex("status", "status", { unique: false });
  }
  if (!database.objectStoreNames.contains(V2_OBJECT_STORES.receipts)) {
    const receipts = database.createObjectStore(V2_OBJECT_STORES.receipts, {
      keyPath: "id",
    });
    receipts.createIndex("commandId", "commandId", { unique: true });
  }
  if (!database.objectStoreNames.contains(V2_OBJECT_STORES.backups)) {
    database.createObjectStore(V2_OBJECT_STORES.backups, { keyPath: "id" });
  }
  if (!database.objectStoreNames.contains(V2_OBJECT_STORES.migrationRuns)) {
    database.createObjectStore(V2_OBJECT_STORES.migrationRuns, {
      keyPath: "sourceChecksum",
    });
  }
}

export function openV2Database(
  options: IndexedDbOptions = {},
): Promise<IDBDatabase> {
  const factory = resolveIndexedDb(options.indexedDB);
  const databaseName = options.databaseName ?? V2_DATABASE_NAME;

  return new Promise((resolve, reject) => {
    let settled = false;
    const request = factory.open(databaseName, V2_DATABASE_VERSION);
    request.onupgradeneeded = () => createSchema(request.result);
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error(`Failed to open ${databaseName}.`));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error(`Opening ${databaseName} was blocked by another tab.`));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

export function deleteV2Database(
  options: IndexedDbOptions = {},
): Promise<void> {
  const factory = resolveIndexedDb(options.indexedDB);
  const databaseName = options.databaseName ?? V2_DATABASE_NAME;

  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(databaseName);
    request.onerror = () => {
      reject(request.error ?? new Error(`Failed to delete ${databaseName}.`));
    };
    request.onblocked = () => {
      reject(new Error(`Deleting ${databaseName} was blocked by another tab.`));
    };
    request.onsuccess = () => resolve();
  });
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB request failed."));
    };
  });
}

export function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => {
      reject(
        transaction.error ??
          new DOMException("IndexedDB transaction aborted.", "AbortError"),
      );
    };
    transaction.onerror = () => {
      // The transaction's abort event is the authoritative completion signal.
    };
  });
}
