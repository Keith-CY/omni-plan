import type { Evidence, Id } from "./types";
import { browserFetch } from "./http";

export interface GitHubPullRequestEvidence {
  title: string;
  url: string;
  state: string;
  mergedAt?: string;
  number: number;
}

export async function fetchPullRequestEvidence(
  owner: string,
  repo: string,
  token: string,
  fetcher: typeof fetch = browserFetch
): Promise<GitHubPullRequestEvidence[]> {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`
  };
  const results: GitHubPullRequestEvidence[] = [];
  let url: string | undefined = `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&per_page=30`;

  while (url) {
    const response = await fetcher(url, { headers });

    if (!response.ok) {
      throw new Error(`GitHub evidence import failed: ${response.status}`);
    }

    const payload = (await response.json()) as Array<{
    title: string;
    html_url: string;
    state: string;
    merged_at?: string;
    number: number;
  }>;

    results.push(...payload.map((item) => ({
      title: item.title,
      url: item.html_url,
      state: item.state,
      mergedAt: item.merged_at,
      number: item.number
    })));
    url = nextLink(response.headers?.get("Link") ?? null);
  }

  return results;
}

function nextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  return linkHeader
    .split(",")
    .map((part) => {
      const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
      return match ? { url: match[1], rel: match[2] } : undefined;
    })
    .find((link) => link?.rel === "next")?.url;
}

export function githubPrToEvidence(projectId: Id, workItemId: Id | undefined, pr: GitHubPullRequestEvidence, now: string): Evidence {
  return {
    id: `evidence-github-pr-${pr.number}`,
    kind: "pr",
    summary: `PR #${pr.number}: ${pr.title} (${pr.state})`,
    url: pr.url,
    projectId,
    workItemId,
    createdAt: pr.mergedAt ?? now,
    confidence: pr.state === "closed" ? 0.9 : 0.65,
    tags: ["github", "readonly"]
  };
}
