// SPDX-License-Identifier: GPL-3.0-or-later

// Filing issues on GitHub with a token read from a file (BOT_GITHUB_TOKEN_FILE,
// or ~/.config/pca/github-token): the bot never holds it in its environment.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function readGithubToken(tokenFile = null) {
  const candidates = [tokenFile, path.join(os.homedir(), ".config", "pca", "github-token")].filter(Boolean);
  for (const file of candidates) {
    try {
      const token = fs.readFileSync(file, "utf8").trim();
      if (token) return token;
    } catch { /* next */ }
  }
  return null;
}

/**
 * @param {{ token: string, repo: string, apiUrl?: string, fetch?: typeof fetch }} options
 *   `repo` is `owner/name`.
 */
export function createGithubIssues({ token, repo, apiUrl = "https://api.github.com", fetch: fetchFn = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`BOT_FEEDBACK_REPO must be owner/name, got "${repo}"`);
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "polkadot-chat-agents",
  };
  return {
    repo,
    /** @param {{ title: string, body: string, labels?: string[] }} issue */
    async create(issue) {
      const response = await fetchFn(`${apiUrl}/repos/${repo}/issues`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: issue.title, body: issue.body, labels: issue.labels ?? [] }),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const data = await response.json();
      return { number: data.number, url: data.html_url };
    },
    /** Labels the repo defines, so the agent only applies ones that exist. */
    async labels() {
      const response = await fetchFn(`${apiUrl}/repos/${repo}/labels?per_page=100`, { headers });
      if (!response.ok) return [];
      return (await response.json()).map((label) => label.name);
    },
  };
}
