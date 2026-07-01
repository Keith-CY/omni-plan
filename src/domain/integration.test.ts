import { describe, expect, it } from "vitest";
import { fetchPullRequestEvidence, githubPrToEvidence } from "./github";
import { BrowserAppSettingsRepository, defaultAppSettings } from "./settings";
import { BrowserWorkspaceRepository } from "./storage";
import { sampleWorkspace } from "./sampleData";
import { BrowserEncryptedSecretVault, browserSecretVaultStatus, decryptProviderSecret, encryptProviderSecret, type SecretVaultStorage } from "./secrets";
import {
  buildChangeEnvelopePath,
  createSyncChangeEnvelope,
  decryptSyncPayload,
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
});
