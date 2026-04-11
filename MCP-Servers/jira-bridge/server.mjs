import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { z } from "zod/v3";

// Credential Resolution - 3-tier: env vars > PROJECT_ROOT > cwd walk-up
function resolveCredentials() {
  if (process.env.ATLASSIAN_SITE_NAME && process.env.ATLASSIAN_USER_EMAIL && process.env.ATLASSIAN_API_TOKEN) {
    console.error(`[jira-bridge] Using direct env credentials for site: ${process.env.ATLASSIAN_SITE_NAME}`);
    return {
      siteName: process.env.ATLASSIAN_SITE_NAME,
      userEmail: process.env.ATLASSIAN_USER_EMAIL,
      apiToken: process.env.ATLASSIAN_API_TOKEN,
      source: "env"
    };
  }
  if (process.env.PROJECT_ROOT) {
    const mcpPath = join(resolve(process.env.PROJECT_ROOT), ".mcp.json");
    const creds = readMcpJson(mcpPath);
    if (creds) return creds;
    console.error(`[jira-bridge] PROJECT_ROOT set but no valid .mcp.json at: ${mcpPath}`);
  }
  let dir = process.cwd();
  const root = resolve("/");
  while (dir !== root) {
    const mcpPath = join(dir, ".mcp.json");
    const creds = readMcpJson(mcpPath);
    if (creds) return creds;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readMcpJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    const jiraEnv = raw?.mcpServers?.jira?.env;
    const confEnv = raw?.mcpServers?.confluence?.env;
    const env = jiraEnv || confEnv;
    if (!env?.ATLASSIAN_SITE_NAME || !env?.ATLASSIAN_USER_EMAIL || !env?.ATLASSIAN_API_TOKEN) {
      return null;
    }
    const confluenceCreds = confEnv ? {
      siteName: confEnv.ATLASSIAN_SITE_NAME,
      userEmail: confEnv.ATLASSIAN_USER_EMAIL,
      apiToken: confEnv.ATLASSIAN_API_TOKEN,
    } : null;
    console.error(`[atlassian-bridge] Loaded credentials from: ${filePath} (site: ${env.ATLASSIAN_SITE_NAME})`);
    return {
      siteName: env.ATLASSIAN_SITE_NAME,
      userEmail: env.ATLASSIAN_USER_EMAIL,
      apiToken: env.ATLASSIAN_API_TOKEN,
      confluence: confluenceCreds,
      source: filePath
    };
  } catch (e) {
    console.error(`[atlassian-bridge] Failed to parse ${filePath}: ${e.message}`);
    return null;
  }
}

class AtlassianClient {
  constructor(creds) {
    this.baseUrl = `https://${creds.siteName}.atlassian.net`;
    this.auth = Buffer.from(`${creds.userEmail}:${creds.apiToken}`).toString("base64");
    this.siteName = creds.siteName;
  }

  async request(path, params = {}, method = "GET", body = null) {
    const url = new URL(path, this.baseUrl);
    if (method === "GET" || method === "DELETE") {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      });
    }
    const opts = {
      method,
      headers: {
        "Authorization": `Basic ${this.auth}`,
        "Accept": "application/json",
        "Content-Type": "application/json"
      }
    };
    if (body && method !== "GET" && method !== "DELETE") opts.body = JSON.stringify(body);
    const resp = await fetch(url.toString(), opts);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Atlassian API ${resp.status}: ${text}`);
    }
    if (resp.status === 204) return { success: true };
    return resp.json();
  }

  async listProjects() {
    const data = await this.request("/rest/api/3/project/search", { maxResults: 50 });
    return data.values.map(p => ({ key: p.key, name: p.name, id: p.id, style: p.style, lead: p.lead?.displayName }));
  }

  async searchIssues(jql, maxResults = 50, startAt = 0, fields = null) {
    const params = { jql, maxResults, startAt };
    if (fields) params.fields = fields;
    const data = await this.request("/rest/api/3/search", params);
    return { total: data.total, startAt: data.startAt, maxResults: data.maxResults, issues: data.issues.map(i => this._formatIssue(i)) };
  }

  async getIssue(issueKey) {
    const data = await this.request(`/rest/api/3/issue/${issueKey}`);
    return this._formatIssue(data);
  }

  async listBoards(projectKeyOrId) {
    const params = {};
    if (projectKeyOrId) params.projectKeyOrId = projectKeyOrId;
    const data = await this.request("/rest/agile/1.0/board", params);
    return data.values.map(b => ({ id: b.id, name: b.name, type: b.type, projectKey: b.location?.projectKey }));
  }

  async listSprints(boardId, state = "active,future") {
    const data = await this.request(`/rest/agile/1.0/board/${boardId}/sprint`, { state });
    return data.values.map(s => ({ id: s.id, name: s.name, state: s.state, startDate: s.startDate, endDate: s.endDate, goal: s.goal }));
  }

  async getSprintIssues(sprintId, maxResults = 100) {
    const data = await this.request(`/rest/agile/1.0/sprint/${sprintId}/issue`, { maxResults });
    return { total: data.total, issues: data.issues.map(i => this._formatIssue(i)) };
  }

  async listEpics(projectKey) {
    return this.searchIssues(`project = "${projectKey}" AND issuetype = Epic ORDER BY rank ASC`, 100);
  }

  async getProjectStatuses(projectKey) {
    const data = await this.request(`/rest/api/3/project/${projectKey}/statuses`);
    return data.flatMap(it => it.statuses.map(s => ({ issueType: it.name, statusName: s.name, category: s.statusCategory?.name })));
  }

  // ── Write Operations ──

  async createIssue(projectKey, issueType, summary, opts = {}) {
    const fields = {
      project: { key: projectKey },
      issuetype: { name: issueType },
      summary,
    };
    if (opts.description) fields.description = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: opts.description }] }] };
    if (opts.assignee) fields.assignee = { accountId: opts.assignee };
    if (opts.priority) fields.priority = { name: opts.priority };
    if (opts.labels) fields.labels = opts.labels;
    if (opts.parentKey) fields.parent = { key: opts.parentKey };
    if (opts.components) fields.components = opts.components.map(c => ({ name: c }));
    if (opts.storyPoints !== undefined) fields.customfield_10016 = opts.storyPoints;
    const data = await this.request("/rest/api/3/issue", {}, "POST", { fields });
    return { key: data.key, id: data.id, self: data.self };
  }

  async updateIssue(issueKey, fields) {
    await this.request(`/rest/api/3/issue/${issueKey}`, {}, "PUT", { fields });
    return { updated: true, key: issueKey };
  }

  async transitionIssue(issueKey, transitionId) {
    await this.request(`/rest/api/3/issue/${issueKey}/transitions`, {}, "POST", { transition: { id: transitionId } });
    return { transitioned: true, key: issueKey, transitionId };
  }

  async getTransitions(issueKey) {
    const data = await this.request(`/rest/api/3/issue/${issueKey}/transitions`);
    return data.transitions.map(t => ({ id: t.id, name: t.name, to: t.to?.name }));
  }

  async addComment(issueKey, bodyText) {
    const body = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: bodyText }] }] };
    const data = await this.request(`/rest/api/3/issue/${issueKey}/comment`, {}, "POST", { body });
    return { id: data.id, author: data.author?.displayName, created: data.created };
  }

  async addWorklog(issueKey, timeSpentSeconds, opts = {}) {
    const body = { timeSpentSeconds };
    if (opts.started) body.started = opts.started;
    if (opts.comment) body.comment = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: opts.comment }] }] };
    const data = await this.request(`/rest/api/3/issue/${issueKey}/worklog`, {}, "POST", body);
    return { id: data.id, timeSpent: data.timeSpent, author: data.author?.displayName };
  }

  async deleteIssue(issueKey, deleteSubtasks = false) {
    await this.request(`/rest/api/3/issue/${issueKey}`, { deleteSubtasks }, "DELETE");
    return { deleted: true, key: issueKey };
  }

  async assignIssue(issueKey, accountId) {
    await this.request(`/rest/api/3/issue/${issueKey}/assignee`, {}, "PUT", { accountId });
    return { assigned: true, key: issueKey, accountId };
  }

  async getUsers(projectKey) {
    const data = await this.request("/rest/api/3/user/assignable/search", { project: projectKey, maxResults: 100 });
    return data.map(u => ({ accountId: u.accountId, displayName: u.displayName, email: u.emailAddress, active: u.active }));
  }

  async genericRequest(path, method = "GET", queryParams = {}, body = null) {
    return this.request(path, queryParams, method, body);
  }

  _formatIssue(issue) {
    const f = issue.fields || {};
    return {
      key: issue.key, summary: f.summary, status: f.status?.name, statusCategory: f.status?.statusCategory?.name,
      priority: f.priority?.name, assignee: f.assignee?.displayName || "Unassigned", reporter: f.reporter?.displayName,
      issueType: f.issuetype?.name, created: f.created, updated: f.updated, resolutionDate: f.resolutiondate,
      labels: f.labels || [], epic: f.epic?.name || f.parent?.fields?.summary, epicKey: f.epic?.key || f.parent?.key,
      sprint: f.sprint?.name, sprintState: f.sprint?.state, storyPoints: f.customfield_10016 || f.story_points,
      components: (f.components || []).map(c => c.name), description: f.description ? "[present]" : null
    };
  }
}

class ConfluenceClient {
  constructor(creds) {
    const c = creds.confluence || creds;
    this.baseUrl = `https://${c.siteName}.atlassian.net`;
    this.auth = Buffer.from(`${c.userEmail}:${c.apiToken}`).toString("base64");
    this.siteName = c.siteName;
  }

  async request(path, params = {}, method = "GET", body = null) {
    const url = new URL(path, this.baseUrl);
    if (method === "GET" || method === "DELETE") {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      });
    }
    const opts = {
      method,
      headers: { "Authorization": `Basic ${this.auth}`, "Accept": "application/json", "Content-Type": "application/json" }
    };
    if (body && method !== "GET" && method !== "DELETE") opts.body = JSON.stringify(body);
    const resp = await fetch(url.toString(), opts);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Confluence API ${resp.status}: ${text}`);
    }
    if (resp.status === 204) return { success: true };
    return resp.json();
  }

  async listSpaces(limit = 25, type = null) {
    const params = { limit };
    if (type) params.type = type;
    const data = await this.request("/wiki/rest/api/space", params);
    return data.results.map(s => ({ key: s.key, name: s.name, type: s.type, status: s.status, url: s._links?.webui ? `${this.baseUrl}/wiki${s._links.webui}` : null }));
  }

  async search(cql, limit = 25, start = 0) {
    const data = await this.request("/wiki/rest/api/content/search", { cql, limit, start, expand: "version,space,ancestors" });
    return { total: data.totalSize, results: data.results.map(p => this._formatPage(p)) };
  }

  async getPage(pageId, bodyFormat = "storage") {
    const expand = `body.${bodyFormat},version,space,ancestors,children.page,children.comment,metadata.labels`;
    const data = await this.request(`/wiki/rest/api/content/${pageId}`, { expand });
    return {
      ...this._formatPage(data),
      body: data.body?.[bodyFormat]?.value || null,
      children: data.children?.page?.results?.map(c => ({ id: c.id, title: c.title, status: c.status })) || [],
      labels: data.metadata?.labels?.results?.map(l => l.name) || [],
      commentCount: data.children?.comment?.size || 0
    };
  }

  async getPageByTitle(spaceKey, title) {
    const data = await this.request("/wiki/rest/api/content", { spaceKey, title, expand: "body.storage,version,space,metadata.labels" });
    if (!data.results || data.results.length === 0) throw new Error(`Page "${title}" not found in space ${spaceKey}`);
    const page = data.results[0];
    return { ...this._formatPage(page), body: page.body?.storage?.value || null, labels: page.metadata?.labels?.results?.map(l => l.name) || [] };
  }

  async getPageComments(pageId, limit = 50) {
    const data = await this.request(`/wiki/rest/api/content/${pageId}/child/comment`, { limit, expand: "body.storage,version,extensions.inlineProperties" });
    return data.results.map(c => ({
      id: c.id, author: c.version?.by?.displayName, created: c.version?.when,
      body: this._stripHtml(c.body?.storage?.value || ""),
      isInline: !!c.extensions?.inlineProperties, inlineRef: c.extensions?.inlineProperties?.originalSelection || null
    }));
  }

  async getPageChildren(pageId, limit = 50) {
    const data = await this.request(`/wiki/rest/api/content/${pageId}/child/page`, { limit, expand: "version,space" });
    return data.results.map(p => this._formatPage(p));
  }

  async getPageHistory(pageId, limit = 10) {
    const data = await this.request(`/wiki/rest/api/content/${pageId}/version`, { limit });
    return data.results.map(v => ({ number: v.number, by: v.by?.displayName, when: v.when, message: v.message || null, minorEdit: v.minorEdit }));
  }

  async getSpacePages(spaceKey, limit = 100, depth = "all") {
    const data = await this.request("/wiki/rest/api/content", { spaceKey, type: "page", limit, depth, expand: "version,ancestors" });
    return data.results.map(p => this._formatPage(p));
  }

  async getPageLabels(pageId) {
    const data = await this.request(`/wiki/rest/api/content/${pageId}/label`);
    return data.results.map(l => ({ name: l.name, prefix: l.prefix }));
  }

  // ── Write Operations ──

  async createPage(spaceKey, title, bodyHtml, parentId = null) {
    const body = {
      type: "page", title,
      space: { key: spaceKey },
      body: { storage: { value: bodyHtml, representation: "storage" } }
    };
    if (parentId) body.ancestors = [{ id: parentId }];
    const data = await this.request("/wiki/rest/api/content", {}, "POST", body);
    return this._formatPage(data);
  }

  async updatePage(pageId, title, bodyHtml, version) {
    const body = {
      type: "page", title,
      body: { storage: { value: bodyHtml, representation: "storage" } },
      version: { number: version }
    };
    const data = await this.request(`/wiki/rest/api/content/${pageId}`, {}, "PUT", body);
    return this._formatPage(data);
  }

  async addComment(pageId, bodyHtml) {
    const body = {
      type: "comment",
      container: { id: pageId, type: "page" },
      body: { storage: { value: bodyHtml, representation: "storage" } }
    };
    const data = await this.request(`/wiki/rest/api/content`, {}, "POST", body);
    return { id: data.id, author: data.version?.by?.displayName, created: data.version?.when };
  }

  async deletePage(pageId) {
    await this.request(`/wiki/rest/api/content/${pageId}`, {}, "DELETE");
    return { deleted: true, pageId };
  }

  async addLabel(pageId, label) {
    const data = await this.request(`/wiki/rest/api/content/${pageId}/label`, {}, "POST", [{ prefix: "global", name: label }]);
    return { added: true, pageId, label };
  }

  async genericRequest(path, method = "GET", queryParams = {}, body = null) {
    return this.request(path, queryParams, method, body);
  }

  _formatPage(page) {
    return {
      id: page.id, title: page.title, type: page.type, status: page.status,
      space: page.space?.key, spaceName: page.space?.name, version: page.version?.number,
      lastUpdated: page.version?.when, lastUpdatedBy: page.version?.by?.displayName,
      ancestors: (page.ancestors || []).map(a => ({ id: a.id, title: a.title })),
      url: page._links?.webui ? `${this.baseUrl}/wiki${page._links.webui}` : null
    };
  }

  _stripHtml(html) {
    return html.replace(/<ac:.*?\/>/g, '').replace(/<ac:.*?>.*?<\/ac:.*?>/gs, '')
      .replace(/<ri:.*?\/>/g, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  }
}

// ── Output helpers ──
function compactJson(obj) {
  // Recursively strip null values, empty arrays, and empty strings to reduce token usage
  if (Array.isArray(obj)) return obj.map(compactJson).filter(v => v !== undefined);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
      out[k] = compactJson(v);
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return obj;
}

function jsonOut(data, compact = false) {
  const output = compact ? compactJson(data) : data;
  return { content: [{ type: "text", text: JSON.stringify(output, null, compact ? 0 : 2) }] };
}

// ── MCP SERVER INIT ──
const creds = resolveCredentials();
if (!creds) {
  console.error("[jira-bridge] ERROR: No Atlassian credentials found.");
  console.error("  Set PROJECT_ROOT env var to a folder with .mcp.json,");
  console.error("  or pass ATLASSIAN_SITE_NAME / ATLASSIAN_USER_EMAIL / ATLASSIAN_API_TOKEN directly.");
  process.exit(1);
}

const client = new AtlassianClient(creds);
const confluence = new ConfluenceClient(creds);
const server = new McpServer({
  name: "atlassian-bridge",
  version: "1.1.0",
  description: "Atlassian Bridge for " + creds.siteName + " (Jira + Confluence)"
});

// ── connection_info ──
server.tool("connection_info", "Show which Atlassian org this server is connected to and where credentials came from", {},
  async () => ({ content: [{ type: "text", text: JSON.stringify({
    site: creds.siteName + ".atlassian.net", products: ["Jira", "Confluence"],
    user: creds.userEmail?.replace(/(.{3}).*(@.*)/, "$1***$2"),
    confluenceUser: creds.confluence ? creds.confluence.userEmail?.replace(/(.{3}).*(@.*)/, "$1***$2") : "(same as Jira)",
    credentialSource: creds.source
  }, null, 2) }] }));

// ── jira_list_projects ──
server.tool("jira_list_projects", "List all Jira projects accessible with current credentials", {},
  async () => { const p = await client.listProjects(); return { content: [{ type: "text", text: JSON.stringify(p, null, 2) }] }; });

// ── jira_search ──
server.tool("jira_search", "Search Jira issues using JQL", {
  jql: z.string().describe("JQL query string"),
  maxResults: z.number().optional().default(50).describe("Max results (1-100)"),
  startAt: z.number().optional().default(0).describe("Pagination offset")
}, async ({ jql, maxResults, startAt }) => {
  const r = await client.searchIssues(jql, Math.min(maxResults, 100), startAt);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── jira_get_issue ──
server.tool("jira_get_issue", "Get full details of a single Jira issue by key", {
  issueKey: z.string().describe("Issue key, e.g. 'OS-123'")
}, async ({ issueKey }) => {
  const i = await client.getIssue(issueKey);
  return { content: [{ type: "text", text: JSON.stringify(i, null, 2) }] };
});

// ── jira_list_boards ──
server.tool("jira_list_boards", "List Jira/agile boards, optionally filtered by project", {
  projectKey: z.string().optional().describe("Filter by project key")
}, async ({ projectKey }) => {
  const b = await client.listBoards(projectKey);
  return { content: [{ type: "text", text: JSON.stringify(b, null, 2) }] };
});

// ── jira_list_sprints ──
server.tool("jira_list_sprints", "List sprints for a board", {
  boardId: z.number().describe("Board ID (from jira_list_boards)"),
  state: z.string().optional().default("active,future").describe("Sprint states: active, future, closed")
}, async ({ boardId, state }) => {
  const s = await client.listSprints(boardId, state);
  return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
});

// ── jira_get_sprint_issues ──
server.tool("jira_get_sprint_issues", "Get all issues in a sprint", {
  sprintId: z.number().describe("Sprint ID (from jira_list_sprints)")
}, async ({ sprintId }) => {
  const d = await client.getSprintIssues(sprintId);
  return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
});

// ── jira_list_epics ──
server.tool("jira_list_epics", "List all epics in a project", {
  projectKey: z.string().describe("Project key")
}, async ({ projectKey }) => {
  const d = await client.listEpics(projectKey);
  return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
});

// ── jira_project_summary ──
server.tool("jira_project_summary", "High-level project summary: status counts, priority breakdown, assignee workload", {
  projectKey: z.string().describe("Project key")
}, async ({ projectKey }) => {
  const statusData = await client.searchIssues(`project = "${projectKey}" ORDER BY status`, 200);
  const byStatus = {}, byPriority = {}, byAssignee = {}, byType = {};
  let blockerCount = 0;
  for (const issue of statusData.issues) {
    const cat = issue.statusCategory || "Unknown";
    byStatus[cat] = (byStatus[cat] || 0) + 1;
    byPriority[issue.priority || "None"] = (byPriority[issue.priority || "None"] || 0) + 1;
    byAssignee[issue.assignee] = (byAssignee[issue.assignee] || 0) + 1;
    byType[issue.issueType || "Unknown"] = (byType[issue.issueType || "Unknown"] || 0) + 1;
    if (issue.priority === "Highest" || issue.priority === "Blocker") blockerCount++;
  }
  return { content: [{ type: "text", text: JSON.stringify({
    project: projectKey, site: creds.siteName + ".atlassian.net", totalIssues: statusData.total,
    byStatusCategory: byStatus, byPriority, byAssignee, byIssueType: byType, blockerCount,
    completionRate: byStatus["Done"] ? ((byStatus["Done"] / statusData.total) * 100).toFixed(1) + "%" : "0%"
  }, null, 2) }] };
});

// ── jira_dashboard_export ──
server.tool("jira_dashboard_export", "Export all project issues as flat JSON for dashboard consumption", {
  projectKey: z.string().describe("Project key"),
  maxResults: z.number().optional().default(200).describe("Max issues")
}, async ({ projectKey, maxResults }) => {
  const all = [];
  let startAt = 0;
  while (startAt < maxResults) {
    const batch = await client.searchIssues(`project = "${projectKey}" ORDER BY rank ASC`, Math.min(100, maxResults - startAt), startAt);
    all.push(...batch.issues);
    if (all.length >= batch.total || batch.issues.length === 0) break;
    startAt += batch.issues.length;
  }
  return { content: [{ type: "text", text: JSON.stringify(all, null, 2) }] };
});

// ── CONFLUENCE TOOLS ──

server.tool("confluence_list_spaces", "List all Confluence spaces", {
  type: z.string().optional().describe("Filter: 'global' or 'personal'")
}, async ({ type }) => {
  const s = await confluence.listSpaces(50, type);
  return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
});

server.tool("confluence_search", "Search Confluence using CQL", {
  cql: z.string().describe("CQL query. Key fields: space, title, text, label, type, creator, lastModified"),
  limit: z.number().optional().default(25).describe("Max results (1-100)"),
  start: z.number().optional().default(0).describe("Pagination offset")
}, async ({ cql, limit, start }) => {
  const r = await confluence.search(cql, Math.min(limit, 100), start);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("confluence_get_page", "Get a Confluence page by ID with full body, children, labels", {
  pageId: z.string().describe("Page ID (numeric string)"),
  bodyFormat: z.enum(["storage", "view"]).optional().default("storage").describe("'storage' (raw) or 'view' (rendered)")
}, async ({ pageId, bodyFormat }) => {
  const p = await confluence.getPage(pageId, bodyFormat);
  return { content: [{ type: "text", text: JSON.stringify(p, null, 2) }] };
});

server.tool("confluence_get_page_by_title", "Get a Confluence page by space key and exact title", {
  spaceKey: z.string().describe("Space key"),
  title: z.string().describe("Exact page title")
}, async ({ spaceKey, title }) => {
  const p = await confluence.getPageByTitle(spaceKey, title);
  return { content: [{ type: "text", text: JSON.stringify(p, null, 2) }] };
});

server.tool("confluence_get_comments", "Get all comments on a Confluence page", {
  pageId: z.string().describe("Page ID"),
  limit: z.number().optional().default(50).describe("Max comments")
}, async ({ pageId, limit }) => {
  const c = await confluence.getPageComments(pageId, limit);
  return { content: [{ type: "text", text: JSON.stringify(c, null, 2) }] };
});

server.tool("confluence_get_children", "Get child pages of a Confluence page", {
  pageId: z.string().describe("Parent page ID"),
  limit: z.number().optional().default(50).describe("Max children")
}, async ({ pageId, limit }) => {
  const c = await confluence.getPageChildren(pageId, limit);
  return { content: [{ type: "text", text: JSON.stringify(c, null, 2) }] };
});

server.tool("confluence_get_history", "Get version history of a Confluence page", {
  pageId: z.string().describe("Page ID"),
  limit: z.number().optional().default(10).describe("Number of versions")
}, async ({ pageId, limit }) => {
  const h = await confluence.getPageHistory(pageId, limit);
  return { content: [{ type: "text", text: JSON.stringify(h, null, 2) }] };
});

server.tool("confluence_space_pages", "List all pages in a Confluence space", {
  spaceKey: z.string().describe("Space key"),
  limit: z.number().optional().default(100).describe("Max pages")
}, async ({ spaceKey, limit }) => {
  const p = await confluence.getSpacePages(spaceKey, Math.min(limit, 200));
  return { content: [{ type: "text", text: JSON.stringify(p, null, 2) }] };
});

server.tool("confluence_get_labels", "Get all labels on a Confluence page", {
  pageId: z.string().describe("Page ID")
}, async ({ pageId }) => {
  const l = await confluence.getPageLabels(pageId);
  return { content: [{ type: "text", text: JSON.stringify(l, null, 2) }] };
});

// ── JIRA WRITE TOOLS ──

server.tool("jira_create_issue", "Create a new Jira issue", {
  projectKey: z.string().describe("Project key (e.g. 'OS', 'ZK')"),
  issueType: z.string().describe("Issue type: Task, Story, Bug, Epic, Sub-task"),
  summary: z.string().describe("Issue title/summary"),
  description: z.string().optional().describe("Plain text description"),
  assignee: z.string().optional().describe("Assignee accountId (from jira_get_users)"),
  priority: z.string().optional().describe("Priority: Highest, High, Medium, Low, Lowest"),
  labels: z.array(z.string()).optional().describe("Array of label strings"),
  parentKey: z.string().optional().describe("Parent issue key (for sub-tasks or child issues under epics)"),
  components: z.array(z.string()).optional().describe("Array of component names"),
  storyPoints: z.number().optional().describe("Story point estimate")
}, async ({ projectKey, issueType, summary, description, assignee, priority, labels, parentKey, components, storyPoints }) => {
  const r = await client.createIssue(projectKey, issueType, summary, { description, assignee, priority, labels, parentKey, components, storyPoints });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("jira_update_issue", "Update fields on an existing Jira issue. Pass fields as a JSON string of field names to new values.", {
  issueKey: z.string().describe("Issue key (e.g. 'OS-123')"),
  fieldsJson: z.string().describe("JSON string of fields to update. Examples: '{\"summary\": \"New title\"}', '{\"priority\": {\"name\": \"High\"}}', '{\"labels\": [\"ui\", \"urgent\"]}'")
}, async ({ issueKey, fieldsJson }) => {
  const fields = JSON.parse(fieldsJson);
  const r = await client.updateIssue(issueKey, fields);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("jira_transition_issue", "Move an issue to a new status. Use jira_get_transitions first to find available transition IDs.", {
  issueKey: z.string().describe("Issue key"),
  transitionId: z.string().describe("Transition ID (from jira_get_transitions)")
}, async ({ issueKey, transitionId }) => {
  const r = await client.transitionIssue(issueKey, transitionId);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("jira_get_transitions", "Get available status transitions for an issue (needed before jira_transition_issue)", {
  issueKey: z.string().describe("Issue key")
}, async ({ issueKey }) => {
  const r = await client.getTransitions(issueKey);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("jira_add_comment", "Add a comment to a Jira issue", {
  issueKey: z.string().describe("Issue key"),
  body: z.string().describe("Comment text (plain text)")
}, async ({ issueKey, body }) => {
  const r = await client.addComment(issueKey, body);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("jira_add_worklog", "Log time spent on a Jira issue", {
  issueKey: z.string().describe("Issue key"),
  timeSpentSeconds: z.number().describe("Time spent in seconds (e.g. 3600 = 1 hour)"),
  started: z.string().optional().describe("When work started (ISO 8601, e.g. '2024-01-15T09:00:00.000+0000')"),
  comment: z.string().optional().describe("Worklog comment")
}, async ({ issueKey, timeSpentSeconds, started, comment }) => {
  const r = await client.addWorklog(issueKey, timeSpentSeconds, { started, comment });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("jira_delete_issue", "Delete a Jira issue (requires admin permissions)", {
  issueKey: z.string().describe("Issue key to delete"),
  deleteSubtasks: z.boolean().optional().default(false).describe("Also delete subtasks")
}, async ({ issueKey, deleteSubtasks }) => {
  const r = await client.deleteIssue(issueKey, deleteSubtasks);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("jira_assign_issue", "Assign an issue to a user", {
  issueKey: z.string().describe("Issue key"),
  accountId: z.string().describe("User's accountId (from jira_get_users). Use null string to unassign.")
}, async ({ issueKey, accountId }) => {
  const r = await client.assignIssue(issueKey, accountId === "null" ? null : accountId);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("jira_get_users", "Get assignable users for a project (returns accountIds needed for assignment)", {
  projectKey: z.string().describe("Project key")
}, async ({ projectKey }) => {
  const r = await client.getUsers(projectKey);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("jira_request", "Generic Jira REST API request — use for any endpoint not covered by other tools", {
  path: z.string().describe("API path (e.g. '/rest/api/3/issue/OS-123/watchers')"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().default("GET").describe("HTTP method"),
  queryParams: z.record(z.string()).optional().describe("Query parameters as key-value pairs"),
  bodyJson: z.string().optional().describe("Request body as JSON string (for POST/PUT/PATCH). Must be valid JSON.")
}, async ({ path, method, queryParams, bodyJson }) => {
  const body = bodyJson ? JSON.parse(bodyJson) : null;
  const r = await client.genericRequest(path, method, queryParams || {}, body);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── CONFLUENCE WRITE TOOLS ──

server.tool("confluence_create_page", "Create a new Confluence page", {
  spaceKey: z.string().describe("Space key"),
  title: z.string().describe("Page title"),
  body: z.string().describe("Page body in Confluence storage format (HTML). Use <p>, <h1>-<h6>, <table>, <ul>/<ol>, <ac:structured-macro> etc."),
  parentId: z.string().optional().describe("Parent page ID to nest under (omit for top-level)")
}, async ({ spaceKey, title, body, parentId }) => {
  const r = await confluence.createPage(spaceKey, title, body, parentId);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("confluence_update_page", "Update an existing Confluence page's title and/or body. You MUST provide the next version number (current + 1).", {
  pageId: z.string().describe("Page ID"),
  title: z.string().describe("Page title (can be same as current)"),
  body: z.string().describe("Full page body in storage format (replaces entire body)"),
  version: z.number().describe("Next version number (current version + 1, get from confluence_get_page)")
}, async ({ pageId, title, body, version }) => {
  const r = await confluence.updatePage(pageId, title, body, version);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("confluence_add_comment", "Add a comment to a Confluence page", {
  pageId: z.string().describe("Page ID"),
  body: z.string().describe("Comment body in storage format (HTML)")
}, async ({ pageId, body }) => {
  const r = await confluence.addComment(pageId, body);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("confluence_delete_page", "Delete a Confluence page", {
  pageId: z.string().describe("Page ID to delete")
}, async ({ pageId }) => {
  const r = await confluence.deletePage(pageId);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("confluence_add_label", "Add a label to a Confluence page", {
  pageId: z.string().describe("Page ID"),
  label: z.string().describe("Label name (lowercase, no spaces)")
}, async ({ pageId, label }) => {
  const r = await confluence.addLabel(pageId, label);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("confluence_request", "Generic Confluence REST API request — use for any endpoint not covered by other tools", {
  path: z.string().describe("API path (e.g. '/wiki/rest/api/content/12345/label' or '/wiki/api/v2/pages')"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().default("GET").describe("HTTP method"),
  queryParams: z.record(z.string()).optional().describe("Query parameters as key-value pairs"),
  bodyJson: z.string().optional().describe("Request body as JSON string (for POST/PUT/PATCH). Must be valid JSON.")
}, async ({ path, method, queryParams, bodyJson }) => {
  const body = bodyJson ? JSON.parse(bodyJson) : null;
  const r = await confluence.genericRequest(path, method, queryParams || {}, body);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── START ──
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[atlassian-bridge] MCP server running - Jira + Confluence on " + creds.siteName + ".atlassian.net");
