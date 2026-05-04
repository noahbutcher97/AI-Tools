// github.mjs
// Minimal GitHub API client for the installer.
// Anonymous (rate-limited to 60 req/hour, plenty for our needs).
// Used to fetch latest release metadata + download release tarballs.

const GH_API = "https://api.github.com";
const USER_AGENT = "noahbutcher97-mcp-bridges-installer";

/**
 * Get metadata for the latest release of a repo.
 * @param {string} repo - "owner/name"
 * @returns {Promise<{tag, name, publishedAt, tarballUrl, zipballUrl}|null>}
 */
export async function getLatestRelease(repo) {
  const url = `${GH_API}/repos/${repo}/releases/latest`;
  const resp = await fetchWithUserAgent(url);
  if (!resp.ok) {
    if (resp.status === 404) return null; // no releases yet
    throw new Error(`GitHub API ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  return {
    tag: data.tag_name,
    name: data.name,
    publishedAt: data.published_at,
    tarballUrl: data.tarball_url,
    zipballUrl: data.zipball_url,
  };
}

/**
 * Get the SHA of the default branch HEAD (used as a fallback when a repo
 * has no releases yet).
 * @param {string} repo
 * @param {string} [ref="HEAD"]
 */
export async function getDefaultBranchHead(repo) {
  const url = `${GH_API}/repos/${repo}`;
  const resp = await fetchWithUserAgent(url);
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const branch = data.default_branch || "main";

  const branchUrl = `${GH_API}/repos/${repo}/branches/${encodeURIComponent(branch)}`;
  const branchResp = await fetchWithUserAgent(branchUrl);
  if (!branchResp.ok) throw new Error(`GitHub API ${branchResp.status}: ${await branchResp.text()}`);
  const branchData = await branchResp.json();
  return {
    branch,
    sha: branchData.commit?.sha,
    tarballUrl: `https://api.github.com/repos/${repo}/tarball/${branch}`,
    zipballUrl: `https://api.github.com/repos/${repo}/zipball/${branch}`,
  };
}

/**
 * Download a URL to a buffer.
 */
export async function downloadToBuffer(url) {
  const resp = await fetchWithUserAgent(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`Download ${resp.status}: ${url}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

async function fetchWithUserAgent(url, opts = {}) {
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept": opts.accept || "application/vnd.github+json",
    ...(opts.headers || {}),
  };
  return fetch(url, {
    ...opts,
    headers,
    signal: opts.signal || AbortSignal.timeout(60000),
  });
}
