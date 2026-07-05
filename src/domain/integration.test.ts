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
  decryptSyncPayload,
  FirebaseE2eeSyncClient,
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
    expect(JSON.stringify(envelope)).not.toContain(sampleWorkspace.projects[0].name);
    expect(decrypted.projects[0].name).toBe(sampleWorkspace.projects[0].name);
    await expect(decryptSyncPayload(envelope.payload, "wrong horse")).rejects.toThrow();
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
          json: async () => ({ fields: { manifestJson: { stringValue: JSON.stringify(manifest) } } })
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
    const push = await client.pushWorkspaceSnapshot(sampleWorkspace, "correct horse", session, manifest);
    const pull = await client.pullWorkspaceSnapshot("correct horse", session);
    const commitBody = JSON.stringify(JSON.parse(calls.find((call) => call.url.endsWith(":commit"))?.init.body as string));

    expect(session.idToken).toBe("firebase-id-token");
    expect(push.envelope.revision).toHaveLength(64);
    expect(pull.workspace.projects).toHaveLength(sampleWorkspace.projects.length);
    expect(calls.some((call) => call.url.includes("/documents:commit"))).toBe(true);
    expect(commitBody).not.toContain(sampleWorkspace.projects[0].name);
    expect(commitBody).toContain("envelopeJson");
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
