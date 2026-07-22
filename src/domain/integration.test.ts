import { describe, expect, it } from "vitest";
import { fetchPullRequestEvidence, githubPrToEvidence } from "./github";
import { BrowserAppSettingsRepository, defaultAppSettings } from "./settings";
import { BrowserWorkspaceRepository } from "./storage";
import { sampleWorkspace } from "./sampleData";
import { BrowserEncryptedSecretVault, browserSecretVaultStatus, decryptProviderSecret, encryptProviderSecret, type SecretVaultStorage } from "./secrets";
import {
  buildChangeEnvelopePath,
  createSyncChangeEnvelope,
  createFirebaseE2eeManifest,
  createFirebaseWorkspaceSnapshotEnvelope,
  decryptFirebaseWorkspaceSnapshotEnvelope,
  decryptSyncPayload,
  FirebaseE2eeSyncClient,
  FirebaseSyncConflictError,
  githubSyncCommitMessage,
  GitHubPrivateRepoSyncClient,
  GitHubSyncConflictError
} from "./sync";

describe("workspace, GitHub, and secrets", () => {
  it("exports and imports a workspace snapshot", () => {
    const repository = new BrowserWorkspaceRepository();
    const payload = repository.exportWorkspace(sampleWorkspace);
    const imported = repository.importWorkspace(payload);

    expect(imported.projects).toHaveLength(sampleWorkspace.projects.length);
    expect(imported.workItems).toHaveLength(sampleWorkspace.workItems.length);
    expect(JSON.parse(payload).schemaVersion).toBe(3);
    expect(imported.timeZone).toBe("Asia/Tokyo");
    expect(imported.recurringOccurrences).toEqual([]);
  });

  it("migrates schema-1 recurrence defaults without changing manual behavior", () => {
    const repository = new BrowserWorkspaceRepository();
    const legacy = JSON.parse(JSON.stringify(sampleWorkspace));
    delete legacy.timeZone;
    delete legacy.recurringOccurrences;
    legacy.workItems[1].repeatRule = {
      cadence: "weekly",
      count: 4,
      startMode: "after-previous-finish",
      startAt: "2026-07-10T09:00:00.000Z"
    };

    const imported = repository.importWorkspace(JSON.stringify({ schemaVersion: 1, snapshot: legacy }));
    const rule = imported.workItems[1].repeatRule;

    expect(imported.timeZone).toBe("UTC");
    expect(imported.recurringOccurrences).toEqual([]);
    expect(rule?.executionMode).toBe("manual");
    expect(rule?.endMode).toBe("count");
    expect(rule?.startMode).toBe("after-previous-finish");
    expect(rule?.id).toBe(`repeat-${imported.workItems[1].id}`);
  });

  it("round-trips automatic occurrence history in schema 3", () => {
    const repository = new BrowserWorkspaceRepository();
    const occurrence = {
      id: "occ-repeat-transfer-20260718090000000",
      ruleId: "repeat-transfer",
      workItemId: sampleWorkspace.workItems[1].id,
      projectId: sampleWorkspace.projects[0].id,
      occurrenceIndex: 3,
      scheduledStart: "2026-07-18T09:00:00.000Z",
      scheduledFinish: "2026-07-18T09:00:00.000Z",
      start: "2026-07-18T09:00:00.000Z",
      finish: "2026-07-18T09:00:00.000Z",
      status: "exception" as const,
      title: "Automatic transfer",
      description: "Transfer reserve",
      createdAt: "2026-07-18T09:00:00.000Z",
      updatedAt: "2026-07-18T10:00:00.000Z",
      settledAt: "2026-07-18T09:00:00.000Z",
      settlementSource: "on-time" as const,
      exceptionNote: "Rejected",
      followUpWorkItemId: "w-auto-exception"
    };
    const imported = repository.importWorkspace(repository.exportWorkspace({
      ...sampleWorkspace,
      recurringOccurrences: [occurrence]
    }));

    expect(imported.recurringOccurrences).toEqual([occurrence]);
  });

  it("migrates legacy archived project status into an archive flag", () => {
    const repository = new BrowserWorkspaceRepository();
    const legacy = JSON.parse(JSON.stringify(sampleWorkspace));
    legacy.projects[0].status = "archived";
    const imported = repository.importWorkspace(JSON.stringify({ schemaVersion: 1, snapshot: legacy }));

    expect(imported.projects[0].status).toBe("done");
    expect(imported.projects[0].archived).toBe(true);
  });

  it("maps GitHub pull requests to evidence with a mocked readonly fetcher", async () => {
    const fetcher = async () =>
      ({
        ok: true,
        json: async () => [
          {
            title: "Ship audit gate",
            html_url: "https://github.com/acme/repo/pull/12",
            state: "closed",
            merged_at: "2026-07-07T10:00:00.000Z",
            number: 12
          }
        ]
      }) as Response;
    const prs = await fetchPullRequestEvidence("acme", "repo", "token", fetcher as unknown as typeof fetch);
    const evidence = githubPrToEvidence("p-omni", "w-monte", prs[0], "2026-07-08T00:00:00.000Z");

    expect(prs[0].number).toBe(12);
    expect(evidence.kind).toBe("pr");
    expect(evidence.tags).toContain("github");
  });

  it("follows GitHub pull request pagination when importing evidence", async () => {
    const urls: string[] = [];
    const fetcher = async (url: string) => {
      urls.push(url);
      if (url.includes("page=2")) {
        return {
          ok: true,
          headers: new Headers(),
          json: async () => [
            {
              title: "Second page",
              html_url: "https://github.com/acme/repo/pull/2",
              state: "open",
              number: 2
            }
          ]
        } as Response;
      }
      return {
        ok: true,
        headers: new Headers({ Link: '<https://api.github.com/repos/acme/repo/pulls?state=all&per_page=30&page=2>; rel="next"' }),
        json: async () => [
          {
            title: "First page",
            html_url: "https://github.com/acme/repo/pull/1",
            state: "closed",
            number: 1
          }
        ]
      } as Response;
    };

    const prs = await fetchPullRequestEvidence("acme", "repo", "token", fetcher as unknown as typeof fetch);

    expect(urls).toHaveLength(2);
    expect(prs.map((item) => item.number)).toEqual([1, 2]);
  });

  it("encrypts and decrypts provider secrets with a passphrase", async () => {
    const secret = await encryptProviderSecret("openai", "Personal", "sk-test-value", "correct horse", "2026-07-08T00:00:00.000Z");
    const decrypted = await decryptProviderSecret(secret, "correct horse");

    expect(secret.encryptedValue).not.toContain("sk-test-value");
    expect(decrypted).toBe("sk-test-value");
    await expect(decryptProviderSecret(secret, "wrong horse")).rejects.toThrow();
  });

  it("stores provider keys only in the local encrypted browser vault", async () => {
    const storage = new Map<string, string>();
    const memoryStorage: SecretVaultStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key)
    };
    const vault = new BrowserEncryptedSecretVault(memoryStorage);
    const secret = await encryptProviderSecret("github", "Sync PAT", "github_pat_secret", "correct horse", "2026-07-08T00:00:00.000Z");

    vault.saveEncrypted(secret);
    const rawStorage = Array.from(storage.values()).join("\n");
    const unlocked = await vault.unlock(secret.id, "correct horse");

    expect(rawStorage).not.toContain("github_pat_secret");
    expect(rawStorage).not.toContain("correct horse");
    expect(unlocked).toBe("github_pat_secret");
    expect(browserSecretVaultStatus.syncPolicy).toContain("excluded from workspace files");
  });

  it("keeps sync and AI provider settings separate from secret values", async () => {
    const storage = new Map<string, string>();
    const memoryStorage: SecretVaultStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key)
    };
    const repository = new BrowserAppSettingsRepository(memoryStorage);

    repository.save({
      ...defaultAppSettings,
      githubSync: {
        owner: "acme",
        repo: "private-plan",
        branch: "main",
        rootPath: ".omni-plan",
        workspaceId: "personal",
        deviceId: "iphone",
        tokenSecretId: "secret-github-private-repo-sync-pat",
        updatedAt: "2026-07-08T00:00:00.000Z"
      },
      aiProviders: [
        {
          id: "custom-openai-compatible",
          provider: "custom-openai-compatible",
          label: "Custom OpenAI-compatible",
          baseUrl: "https://api.example.com/v1",
          model: "custom-model",
          apiKeySecretId: "secret-custom-provider-key",
          updatedAt: "2026-07-08T00:00:00.000Z"
        }
      ]
    });
    const rawStorage = Array.from(storage.values()).join("\n");
    const loaded = repository.load();

    expect(loaded.githubSync.repo).toBe("private-plan");
    expect(loaded.firebaseSync.databaseId).toBe("(default)");
    expect(loaded.firebaseSync.autoSyncEnabled).toBe(false);
    expect(loaded.aiProviders[0].baseUrl).toBe("https://api.example.com/v1");
    expect(rawStorage).not.toContain("github_pat_secret");
    expect(rawStorage).not.toContain("sk-secret");
  });

  it("creates encrypted GitHub sync envelopes without leaking change details", async () => {
    const changeSet = sampleWorkspace.changeSets[0];
    const envelope = await createSyncChangeEnvelope(
      changeSet,
      { workspaceId: "workspace-personal", deviceId: "iphone" },
      7,
      "rev-previous",
      "correct horse",
      "2026-07-08T00:00:00.000Z"
    );
    const path = buildChangeEnvelopePath(
      { rootPath: ".omni-plan", workspaceId: "workspace-personal", deviceId: "iphone" },
      envelope
    );
    const decrypted = await decryptSyncPayload<typeof changeSet>(envelope.payload, "correct horse");

    expect(envelope.revision).toHaveLength(64);
    expect(path).toMatch(/^\.omni-plan\/workspaces\/workspace-personal\/changes\/iphone\/00000007-/);
    expect(JSON.stringify(envelope)).not.toContain(changeSet.title);
    expect(decrypted.title).toBe(changeSet.title);
    expect(githubSyncCommitMessage(envelope)).not.toContain(changeSet.title);
  });

  it("writes encrypted sync objects to GitHub content paths and reports conflicts", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return {
        ok: true,
        status: 201,
        json: async () => ({ content: { path: ".omni-plan/workspaces/ws/manifest.json", sha: "new-sha" }, commit: { sha: "commit-sha" } })
      } as Response;
    };
    const client = new GitHubPrivateRepoSyncClient(
      { owner: "acme", repo: "private-plan", branch: "main", rootPath: ".omni-plan", workspaceId: "ws", deviceId: "mac" },
      "github_pat_test",
      fetcher as typeof fetch
    );
    const result = await client.writeText(".omni-plan/workspaces/ws/manifest.json", "{\"ok\":true}", "OmniPlan sync ws abc123", "old-sha");
    const body = JSON.parse(calls[0].init.body as string) as { branch: string; content: string; message: string; sha: string };

    expect(calls[0].url).toBe("https://api.github.com/repos/acme/private-plan/contents/.omni-plan/workspaces/ws/manifest.json");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer github_pat_test");
    expect(body.branch).toBe("main");
    expect(body.sha).toBe("old-sha");
    expect(atob(body.content)).toBe("{\"ok\":true}");
    expect(result.commitSha).toBe("commit-sha");

    const conflictClient = new GitHubPrivateRepoSyncClient(
      { owner: "acme", repo: "private-plan", branch: "main", rootPath: ".omni-plan", workspaceId: "ws", deviceId: "mac" },
      "github_pat_test",
      (async () => ({ ok: false, status: 409, json: async () => ({}) }) as Response) as unknown as typeof fetch
    );
    await expect(conflictClient.writeText(".omni-plan/workspaces/ws/manifest.json", "{}", "conflict")).rejects.toBeInstanceOf(GitHubSyncConflictError);
  });

  it("creates encrypted Firebase workspace snapshots without leaking project content", async () => {
    const envelope = await createFirebaseWorkspaceSnapshotEnvelope(
      sampleWorkspace,
      { workspaceId: "personal", deviceId: "macbook" },
      undefined,
      "correct horse",
      "2026-07-08T00:00:00.000Z"
    );
    const decrypted = await decryptSyncPayload<typeof sampleWorkspace>(envelope.payload, "correct horse");

    expect(envelope.revision).toHaveLength(64);
    expect(envelope.workspaceSchemaVersion).toBe(3);
    expect(JSON.stringify(envelope)).not.toContain(sampleWorkspace.projects[0].name);
    expect(decrypted.projects[0].name).toBe(sampleWorkspace.projects[0].name);
    await expect(decryptSyncPayload(envelope.payload, "wrong horse")).rejects.toThrow();
  });

  it("normalizes archived projects before writing Firebase workspace snapshots", async () => {
    const legacy = JSON.parse(JSON.stringify(sampleWorkspace));
    legacy.projects[0].status = "archived";
    const envelope = await createFirebaseWorkspaceSnapshotEnvelope(
      legacy,
      { workspaceId: "personal", deviceId: "mac" },
      undefined,
      "correct horse",
      "2026-07-08T00:00:00.000Z"
    );
    const encryptedSnapshot = await decryptSyncPayload<typeof sampleWorkspace>(envelope.payload, "correct horse");
    const pulled = await decryptFirebaseWorkspaceSnapshotEnvelope(envelope, "correct horse");

    expect(encryptedSnapshot.projects[0].status).toBe("done");
    expect(encryptedSnapshot.projects[0].archived).toBe(true);
    expect(pulled.projects[0].status).toBe("done");
    expect(pulled.projects[0].archived).toBe(true);
  });

  it("pushes and pulls Firebase E2EE workspace snapshots through REST documents", async () => {
    const config = {
      projectId: "firebase-project",
      apiKey: "firebase-web-api-key",
      databaseId: "(default)",
      collectionPath: "omniPlanSync",
      workspaceId: "personal",
      deviceId: "macbook"
    };
    const envelope = await createFirebaseWorkspaceSnapshotEnvelope(
      sampleWorkspace,
      { workspaceId: config.workspaceId, deviceId: config.deviceId },
      undefined,
      "correct horse",
      "2026-07-08T00:00:00.000Z"
    );
    const manifest = createFirebaseE2eeManifest(config, envelope);
    const manifestUpdateTime = "2026-07-08T00:00:30.000Z";
    const versionedManifest = { ...manifest, firestoreUpdateTime: manifestUpdateTime };
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.startsWith("https://identitytoolkit.googleapis.com")) {
        return {
          ok: true,
          json: async () => ({ idToken: "firebase-id-token", refreshToken: "refresh-token", localId: "anonymous-user", expiresIn: "3600" })
        } as Response;
      }
      if (url.endsWith(":commit")) {
        return {
          ok: true,
          json: async () => ({ commitTime: "2026-07-08T00:01:00.000Z" })
        } as Response;
      }
      if (url.endsWith("/omniPlanSync/personal/manifest/current")) {
        return {
          ok: true,
          json: async () => ({
            updateTime: manifestUpdateTime,
            fields: { manifestJson: { stringValue: JSON.stringify(manifest) } }
          })
        } as Response;
      }
      if (url.endsWith("/omniPlanSync/personal/snapshots/latest")) {
        return {
          ok: true,
          json: async () => ({ fields: { envelopeJson: { stringValue: JSON.stringify(envelope) } } })
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    };
    const client = new FirebaseE2eeSyncClient(config, fetcher as typeof fetch);
    const session = await client.signInAnonymously();
    const push = await client.pushWorkspaceSnapshot(sampleWorkspace, "correct horse", session, versionedManifest);
    const pull = await client.pullWorkspaceSnapshot("correct horse", session);
    const commitBody = JSON.parse(calls.find((call) => call.url.endsWith(":commit"))?.init.body as string) as {
      writes: Array<{ update: { name: string; fields: Record<string, unknown> }; currentDocument?: { exists?: boolean; updateTime?: string } }>;
    };
    const opWrite = commitBody.writes.find((write) => write.update.name.includes("/ops/"));
    const manifestWrite = commitBody.writes.find((write) => write.update.name.endsWith("/manifest/current"));

    expect(session.idToken).toBe("firebase-id-token");
    expect(push.envelope.revision).toHaveLength(64);
    expect(push.envelope.workspaceSchemaVersion).toBe(3);
    expect(push.manifest.workspaceSchemaVersion).toBe(3);
    expect(push.manifest.minimumClientWorkspaceSchemaVersion).toBe(3);
    expect(pull.workspace.projects).toHaveLength(sampleWorkspace.projects.length);
    expect(pull.manifest.firestoreUpdateTime).toBe(manifestUpdateTime);
    expect(JSON.stringify(pull.manifest)).not.toContain("firestoreUpdateTime");
    expect(calls.some((call) => call.url.includes("/documents:commit"))).toBe(true);
    expect(JSON.stringify(commitBody)).not.toContain(sampleWorkspace.projects[0].name);
    expect(JSON.stringify(commitBody)).toContain("envelopeJson");
    expect(opWrite?.currentDocument).toEqual({ exists: false });
    expect(manifestWrite?.currentDocument).toEqual({ updateTime: manifestUpdateTime });
    expect(JSON.stringify(manifestWrite?.update.fields.manifestJson)).not.toContain("firestoreUpdateTime");
  });

  it("uses create-only preconditions for the first Firebase manifest and operation", async () => {
    const config = {
      projectId: "firebase-project",
      apiKey: "firebase-web-api-key",
      databaseId: "(default)",
      collectionPath: "omniPlanSync",
      workspaceId: "personal",
      deviceId: "first-device"
    };
    let commitBody: {
      writes: Array<{ update: { name: string }; currentDocument?: { exists?: boolean; updateTime?: string } }>;
    } | undefined;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      commitBody = JSON.parse(init?.body as string) as typeof commitBody;
      return {
        ok: true,
        status: 200,
        json: async () => ({ commitTime: "2026-07-22T00:00:00.000Z" })
      } as Response;
    };
    const client = new FirebaseE2eeSyncClient(config, fetcher as typeof fetch);

    await client.pushWorkspaceSnapshot(
      sampleWorkspace,
      "correct horse",
      { idToken: "firebase-id-token", localId: "anonymous-user" }
    );

    const opWrite = commitBody?.writes.find((write) => write.update.name.includes("/ops/"));
    const manifestWrite = commitBody?.writes.find((write) => write.update.name.endsWith("/manifest/current"));
    expect(opWrite?.currentDocument).toEqual({ exists: false });
    expect(manifestWrite?.currentDocument).toEqual({ exists: false });
  });

  it("refuses to update an existing Firebase manifest without its Firestore version", async () => {
    const config = {
      projectId: "firebase-project",
      apiKey: "firebase-web-api-key",
      databaseId: "(default)",
      collectionPath: "omniPlanSync",
      workspaceId: "personal",
      deviceId: "stale-device"
    };
    const envelope = await createFirebaseWorkspaceSnapshotEnvelope(
      sampleWorkspace,
      { workspaceId: config.workspaceId, deviceId: "base-device" },
      undefined,
      "correct horse",
      "2026-07-22T00:00:00.000Z"
    );
    const previousManifest = createFirebaseE2eeManifest(config, envelope);
    let networkCalls = 0;
    const client = new FirebaseE2eeSyncClient(config, (async () => {
      networkCalls += 1;
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch);

    await expect(client.pushWorkspaceSnapshot(
      sampleWorkspace,
      "correct horse",
      { idToken: "firebase-id-token", localId: "anonymous-user" },
      previousManifest
    )).rejects.toBeInstanceOf(FirebaseSyncConflictError);
    expect(networkCalls).toBe(0);
  });

  it("allows only one concurrent Firebase push from the same manifest version", async () => {
    const baseConfig = {
      projectId: "firebase-project",
      apiKey: "firebase-web-api-key",
      databaseId: "(default)",
      collectionPath: "omniPlanSync",
      workspaceId: "personal"
    };
    const baseEnvelope = await createFirebaseWorkspaceSnapshotEnvelope(
      sampleWorkspace,
      { workspaceId: "personal", deviceId: "base-device" },
      undefined,
      "correct horse",
      "2026-07-22T00:00:00.000Z"
    );
    const initialUpdateTime = "2026-07-22T00:00:01.000Z";
    const baseManifest = {
      ...createFirebaseE2eeManifest({ ...baseConfig, deviceId: "base-device" }, baseEnvelope),
      firestoreUpdateTime: initialUpdateTime
    };
    let currentUpdateTime = initialUpdateTime;
    let successfulCommits = 0;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as {
        writes: Array<{ update: { name: string }; currentDocument?: { updateTime?: string } }>;
      };
      const manifestWrite = body.writes.find((write) => write.update.name.endsWith("/manifest/current"));
      if (manifestWrite?.currentDocument?.updateTime !== currentUpdateTime) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: { status: "ABORTED", message: "stale manifest updateTime" } })
        } as Response;
      }
      successfulCommits += 1;
      currentUpdateTime = "2026-07-22T00:00:02.000Z";
      return {
        ok: true,
        status: 200,
        json: async () => ({ commitTime: currentUpdateTime })
      } as Response;
    };
    const session = { idToken: "firebase-id-token", localId: "anonymous-user" };
    const firstClient = new FirebaseE2eeSyncClient({ ...baseConfig, deviceId: "device-a" }, fetcher as typeof fetch);
    const secondClient = new FirebaseE2eeSyncClient({ ...baseConfig, deviceId: "device-b" }, fetcher as typeof fetch);

    const results = await Promise.allSettled([
      firstClient.pushWorkspaceSnapshot(sampleWorkspace, "correct horse", session, baseManifest),
      secondClient.pushWorkspaceSnapshot(sampleWorkspace, "correct horse", session, baseManifest)
    ]);

    expect(successfulCommits).toBe(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(FirebaseSyncConflictError);
  });

  it("maps Firestore FAILED_PRECONDITION responses to Firebase sync conflicts", async () => {
    const config = {
      projectId: "firebase-project",
      apiKey: "firebase-web-api-key",
      databaseId: "(default)",
      collectionPath: "omniPlanSync",
      workspaceId: "personal",
      deviceId: "stale-device"
    };
    const envelope = await createFirebaseWorkspaceSnapshotEnvelope(
      sampleWorkspace,
      { workspaceId: config.workspaceId, deviceId: "base-device" },
      undefined,
      "correct horse",
      "2026-07-22T00:00:00.000Z"
    );
    const previousManifest = {
      ...createFirebaseE2eeManifest(config, envelope),
      firestoreUpdateTime: "2026-07-22T00:00:01.000Z"
    };
    const client = new FirebaseE2eeSyncClient(config, (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { status: "FAILED_PRECONDITION", message: "manifest changed" } })
    } as Response)) as unknown as typeof fetch);

    await expect(client.pushWorkspaceSnapshot(
      sampleWorkspace,
      "correct horse",
      { idToken: "firebase-id-token", localId: "anonymous-user" },
      previousManifest
    )).rejects.toBeInstanceOf(FirebaseSyncConflictError);
  });

  it.each([
    {
      label: "manifest workspace schema",
      versions: { workspaceSchemaVersion: 4, minimumClientWorkspaceSchemaVersion: 3 }
    },
    {
      label: "minimum client workspace schema",
      versions: { workspaceSchemaVersion: 3, minimumClientWorkspaceSchemaVersion: 4 }
    }
  ])("rejects a future Firebase $label before reading ciphertext", async ({ versions }) => {
    const config = {
      projectId: "firebase-project",
      apiKey: "firebase-web-api-key",
      databaseId: "(default)",
      collectionPath: "omniPlanSync",
      workspaceId: "personal",
      deviceId: "legacy-client"
    };
    const manifest = {
      schemaVersion: 1 as const,
      ...versions,
      provider: "firebase-firestore-e2ee" as const,
      workspaceId: "personal",
      latestRevision: "future-revision",
      updatedAt: "2026-07-22T00:00:00.000Z",
      updatedByDeviceId: "future-client",
      snapshotDocumentPath: "omniPlanSync/personal/snapshots/latest",
      heads: {}
    };
    let snapshotReads = 0;
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/omniPlanSync/personal/manifest/current")) {
        return {
          ok: true,
          json: async () => ({ fields: { manifestJson: { stringValue: JSON.stringify(manifest) } } })
        } as Response;
      }
      snapshotReads += 1;
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    };
    const client = new FirebaseE2eeSyncClient(config, fetcher as typeof fetch);

    await expect(client.readManifest({
      idToken: "firebase-id-token",
      localId: "anonymous-user"
    })).rejects.toThrow(/future workspace schema 4/);
    expect(snapshotReads).toBe(0);
  });

  it("rejects a push based on a future Firebase manifest before encrypting or writing", async () => {
    const config = {
      projectId: "firebase-project",
      apiKey: "firebase-web-api-key",
      databaseId: "(default)",
      collectionPath: "omniPlanSync",
      workspaceId: "personal",
      deviceId: "legacy-client"
    };
    let networkCalls = 0;
    const client = new FirebaseE2eeSyncClient(config, (async () => {
      networkCalls += 1;
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch);

    await expect(client.pushWorkspaceSnapshot(
      sampleWorkspace,
      "correct horse",
      { idToken: "firebase-id-token", localId: "anonymous-user" },
      {
        schemaVersion: 1,
        workspaceSchemaVersion: 4,
        minimumClientWorkspaceSchemaVersion: 4,
        provider: "firebase-firestore-e2ee",
        workspaceId: "personal",
        latestRevision: "future-revision",
        updatedAt: "2026-07-22T00:00:00.000Z",
        updatedByDeviceId: "future-client",
        snapshotDocumentPath: "omniPlanSync/personal/snapshots/latest",
        heads: {}
      }
    )).rejects.toThrow(/future workspace schema 4/);
    expect(networkCalls).toBe(0);
  });

  it("rejects a future Firebase snapshot envelope before decrypting it", async () => {
    const envelope = await createFirebaseWorkspaceSnapshotEnvelope(
      sampleWorkspace,
      { workspaceId: "personal", deviceId: "macbook" },
      undefined,
      "correct horse",
      "2026-07-08T00:00:00.000Z"
    );

    await expect(decryptFirebaseWorkspaceSnapshotEnvelope({
      ...envelope,
      workspaceSchemaVersion: 4
    }, "correct horse")).rejects.toThrow(/future workspace schema 4/);
  });

  it("keeps default sync fetch calls bound for Safari", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (function (this: unknown, input: RequestInfo | URL) {
      if (this !== globalThis) throw new Error("Can only call Window.fetch on instances of Window");
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://identitytoolkit.googleapis.com")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ idToken: "firebase-id-token", localId: "anonymous-user" })
        } as Response);
      }
      if (url.includes("/pulls?")) {
        return Promise.resolve({
          ok: true,
          headers: { get: () => null },
          json: async () => []
        } as unknown as Response);
      }
      if (url.startsWith("https://api.github.com")) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
      }
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response);
    }) as typeof fetch;

    try {
      const firebaseClient = new FirebaseE2eeSyncClient({
        projectId: "firebase-project",
        apiKey: "firebase-web-api-key",
        databaseId: "(default)",
        collectionPath: "omniPlanSync",
        workspaceId: "personal",
        deviceId: "safari"
      });
      const githubClient = new GitHubPrivateRepoSyncClient({
        owner: "acme",
        repo: "repo",
        branch: "main",
        rootPath: ".omni-plan",
        workspaceId: "personal",
        deviceId: "safari"
      }, "github-token");

      const session = await firebaseClient.signInAnonymously();
      const missingFile = await githubClient.readText(".omni-plan/workspaces/personal/manifest.json");
      const pullRequests = await fetchPullRequestEvidence("acme", "repo", "github-token");

      expect(session.idToken).toBe("firebase-id-token");
      expect(missingFile).toBeUndefined();
      expect(pullRequests).toEqual([]);
      expect(calls.some((url) => url.startsWith("https://identitytoolkit.googleapis.com"))).toBe(true);
      expect(calls.some((url) => url.startsWith("https://api.github.com"))).toBe(true);
      expect(calls.some((url) => url.includes("/pulls?"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
