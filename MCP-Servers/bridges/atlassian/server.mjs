import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod/v3";

import { loadBridgeConfigOrExit } from "../../lib/bridge-base.mjs";
import { toolJsonResult, toolListResult } from "../../lib/tool-result.mjs";

// Load manifest so the shared resolver knows what fields to look for, then
// inject resolved values into process.env. The legacy resolveCredentials()
// below picks them up via its tier-1 env path (no behavior change).
const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(__dirname, "manifest.json"), "utf-8"));
loadBridgeConfigOrExit("atlassian", manifest.fields);

// Credential Resolution - 3-tier: env vars > PROJECT_ROOT > cwd walk-up
// (Kept for backward compatibility with existing .mcp.json layouts under
// the 'jira' or 'confluence' keys. New layouts use 'atlassian' via the
// shared resolver above.)
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

import { AtlassianClient, ConfluenceClient } from "./client.mjs";


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
  async () => toolJsonResult({
    site: creds.siteName + ".atlassian.net", products: ["Jira", "Confluence"],
    user: creds.userEmail?.replace(/(.{3}).*(@.*)/, "$1***$2"),
    confluenceUser: creds.confluence ? creds.confluence.userEmail?.replace(/(.{3}).*(@.*)/, "$1***$2") : "(same as Jira)",
    credentialSource: creds.source
  }));

// ── jira_list_projects ──
server.tool("jira_list_projects", "List all Jira projects accessible with current credentials", {},
  async () => { const p = await client.listProjects(); return toolJsonResult(p); });

// ── jira_search ──
// Hits /rest/api/3/search/jql (the post-CHANGE-2046 endpoint). Pagination
// is token-based: pass nextPageToken from a previous response to get the
// next page. Response includes {issues, nextPageToken, isLast}; total/
// startAt are no longer returned by Atlassian on this endpoint.
server.tool("jira_search", "Search Jira issues using JQL (cursor-paginated via nextPageToken)", {
  jql: z.string().describe("JQL query string"),
  maxResults: z.number().optional().default(50).describe("Max results (1-100)"),
  nextPageToken: z.string().optional().describe("Pagination cursor from a previous response. Omit for first page.")
}, async ({ jql, maxResults, nextPageToken }) => {
  const r = await client.searchIssues(jql, Math.min(maxResults, 100), nextPageToken);
  return toolJsonResult(r);
});

// ── jira_get_issue ──
server.tool("jira_get_issue", "Get full details of a single Jira issue by key", {
  issueKey: z.string().describe("Issue key, e.g. 'OS-123'")
}, async ({ issueKey }) => {
  const i = await client.getIssue(issueKey);
  return toolJsonResult(i);
});

// ── jira_get_links ──
// Reconstructing the link graph otherwise means reading per-issue changelogs and
// replaying link-creation events one issue at a time. targetExists makes
// dangling-link detection a one-call check.
server.tool("jira_get_links",
  "Get current issue links for a set of keys — type, direction, target — with a targetExists flag "
  + "per target, so dangling links are detectable in one call.",
  {
    issueKeys: z.array(z.string()).describe("Issue keys to read links for"),
    checkTargets: z.boolean().optional().default(true)
      .describe("Verify each link target still resolves. Adds one lookup per distinct target."),
  },
  async ({ issueKeys, checkTargets }) => {
    const r = await client.getLinks(issueKeys, { checkTargets });
    return toolJsonResult({
      ...r,
      note: "Sources are resolved per key, not by a bulk `key in (...)` query, so an issue missing "
        + "from the search index still appears. targetExists is false only when the target was "
        + "checked and did not resolve; see targetVerdict for the reason.",
      scopeNote: "This covers Jira ISSUE LINKS only. Jira removes those when an issue is deleted, "
        + "so dangling link objects are rare. A hyperlink to a dead issue inside a description or "
        + "comment is plain text, not a link object, and is NOT detected here — extract those keys "
        + "yourself and pass them to jira_validate_keys.",
    });
  });

// ── jira_validate_keys ──
// Use this instead of a `key in (...)` JQL query when checking whether issue
// keys are real. That query returns only the keys it resolves, with no error and
// no list of what it dropped, so absence reads as deletion — and absence has at
// least three causes: the issue is gone, you cannot read it, or it is missing
// from the search index while still fetching fine by key. This tool resolves
// each key individually and returns exactly one verdict per key.
server.tool("jira_validate_keys",
  "Check whether Jira issue keys exist, one verdict per key. Prefer this over a `key in (...)` "
  + "JQL query for reference-integrity checks: that query silently omits keys it cannot resolve, "
  + "and omission does NOT imply deletion.",
  {
    keys: z.array(z.string()).describe("Issue keys to check, e.g. ['OA-794','OA-829']"),
    checkSearchable: z.boolean().optional().default(true)
      .describe("Also flag keys that exist but are invisible to JQL search. Costs one extra "
        + "query per 50 keys. On by default because that case is the one that silently "
        + "corrupts reference-integrity checks."),
  },
  async ({ keys, checkSearchable }) => {
    const r = await client.validateKeys(keys, { checkSearchable });
    return toolJsonResult({
      ...r,
      verdictMeaning: {
        exists: "Resolved by direct fetch.",
        moved: "Resolved, but under a different key — see resolvedKey.",
        exists_not_searchable: "Exists, but absent from JQL results. A `key in (...)` query will "
          + "silently omit it. Not deleted.",
        not_found_or_no_permission: "HTTP 404. The API returns the same response for a missing "
          + "issue and one you may not read; they cannot be told apart from here.",
        no_permission: "HTTP 403.",
        rate_limited: "Rate limited after retries. Status UNKNOWN — do not treat as absent.",
        error: "Request failed for another reason. Status UNKNOWN — do not treat as absent.",
      },
    });
  });

// ── jira_list_boards ──
// Without projectKey, the underlying /rest/agile/1.0/board endpoint returns
// every board the credential can see across the entire Atlassian instance.
// Callers that meant "boards in my project" need a way to notice that fact,
// so the response is wrapped with scope/warning fields when projectKey is
// absent. See _handoffs/2026-05-18-bridge-scope-leak-audit.md.
server.tool("jira_list_boards", "List Jira/agile boards. With projectKey: scoped to that project. WITHOUT projectKey: returns boards across the ENTIRE Atlassian instance (response includes a scope warning).", {
  projectKey: z.string().optional().describe("Project key to scope to. Strongly recommended — omitting it returns boards from every project the credential can access.")
}, async ({ projectKey }) => {
  const boards = await client.listBoards(projectKey);
  if (projectKey) {
    return toolJsonResult({ scope: `project: ${projectKey}`, count: boards.length, boards });
  }
  return toolJsonResult({
    scope: "ENTIRE_INSTANCE",
    warning: `No projectKey provided — returning ${boards.length} boards across all projects the credential can access. Pass projectKey to scope.`,
    count: boards.length,
    boards,
  });
});

// ── jira_list_sprints ──
server.tool("jira_list_sprints", "List sprints for a board", {
  boardId: z.number().describe("Board ID (from jira_list_boards)"),
  state: z.string().optional().default("active,future").describe("Sprint states: active, future, closed")
}, async ({ boardId, state }) => {
  const s = await client.listSprints(boardId, state);
  return toolJsonResult(s);
});

// ── jira_get_sprint_issues ──
server.tool("jira_get_sprint_issues", "Get all issues in a sprint", {
  sprintId: z.number().describe("Sprint ID (from jira_list_sprints)")
}, async ({ sprintId }) => {
  const d = await client.getSprintIssues(sprintId);
  return toolJsonResult(d);
});

// ── jira_list_epics ──
server.tool("jira_list_epics", "List all epics in a project", {
  projectKey: z.string().describe("Project key")
}, async ({ projectKey }) => {
  const d = await client.listEpics(projectKey);
  return toolJsonResult(d);
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
  return toolJsonResult({
    project: projectKey, site: creds.siteName + ".atlassian.net", totalIssues: statusData.total,
    byStatusCategory: byStatus, byPriority, byAssignee, byIssueType: byType, blockerCount,
    completionRate: byStatus["Done"] ? ((byStatus["Done"] / statusData.total) * 100).toFixed(1) + "%" : "0%"
  });
});

// ── jira_dashboard_export ──
// Pagination is token-based since CHANGE-2046 (April 2025). The previous
// implementation walked `startAt`/`total` against the old endpoint; both
// fields were removed when the endpoint changed, so the loop either stopped
// after one page or never advanced. See _handoffs/2026-05-18-bridge-scope-leak-audit.md.
server.tool("jira_dashboard_export", "Export all project issues as flat JSON for dashboard consumption", {
  projectKey: z.string().describe("Project key"),
  maxResults: z.number().optional().default(200).describe("Max issues")
}, async ({ projectKey, maxResults }) => {
  const all = [];
  const jql = `project = "${projectKey}" ORDER BY rank ASC`;
  const pageSize = 100;
  let nextPageToken = null;
  while (all.length < maxResults) {
    const remaining = maxResults - all.length;
    const batch = await client.searchIssues(jql, Math.min(pageSize, remaining), nextPageToken);
    all.push(...batch.issues);
    if (batch.isLast || !batch.nextPageToken || batch.issues.length === 0) break;
    nextPageToken = batch.nextPageToken;
  }
  return toolJsonResult(all);
});

// ── CONFLUENCE TOOLS ──

// The type filter used to be documented as 'global' or 'personal'. Neither
// matches the type the largest space on a real instance actually uses
// ('collaboration'), so filtering silently hid the main project space and
// returned a complete-looking wrong answer. The filter now passes through
// whatever the API accepts, and the default is no filter at all.
server.tool("confluence_list_spaces",
  "List Confluence spaces. Omit `type` to list every space — filtering by type can hide spaces "
  + "whose type you did not think to ask for.",
  {
    type: z.string().optional()
      .describe("Optional space type, passed through to the API. Known values include "
        + "'global', 'personal' and 'collaboration'. Omit to list all types."),
    limit: z.number().optional().default(50).describe("Max spaces per page"),
    start: z.number().optional().describe("Offset for the next page. Omit for the first page."),
  },
  async ({ type, limit, start }) => {
    const s = await confluence.listSpaces({ limit, type, start });
    return toolListResult(s.spaces, {
      isLast: s.isLast,
      total: s.total,
      start: s.start,
      limit: s.limit,
      itemsKey: "spaces",
    });
  });

server.tool("confluence_search", "Search Confluence using CQL", {
  cql: z.string().describe("CQL query. Key fields: space, title, text, label, type, creator, lastModified"),
  limit: z.number().optional().default(25).describe("Max results (1-100)"),
  start: z.number().optional().default(0).describe("Pagination offset")
}, async ({ cql, limit, start }) => {
  const r = await confluence.search(cql, Math.min(limit, 100), start);
  return toolListResult(r.results, {
    isLast: r.isLast,
    total: r.total,
    start: r.start,
    limit: r.limit,
    itemsKey: "results",
  });
});

// format:"text" strips markup server-side. Large pages are mostly macro and
// attachment wrappers rather than prose, so raw HTML can exceed the tool-result
// cap and spill to a file, pushing the caller into writing their own stripping
// just to read a page.
//
// version fetches a historical revision, so "did this text exist at version
// N-1?" is answerable by fetching two versions and comparing.
server.tool("confluence_get_page",
  "Get a Confluence page by ID with body, children and labels. Pass format='text' for readable "
  + "text instead of HTML — large pages are mostly markup, and raw HTML may exceed the result cap.",
  {
    pageId: z.string().describe("Page ID (numeric string)"),
    bodyFormat: z.enum(["storage", "view"]).optional().default("storage")
      .describe("'storage' (raw) or 'view' (rendered)"),
    format: z.enum(["html", "text"]).optional().default("html")
      .describe("'text' strips markup server-side. Response reports both bodyLength and "
        + "rawBodyLength so you can see what was removed."),
    version: z.number().optional()
      .describe("Fetch a specific historical version instead of the current one. Fetch two "
        + "versions and compare to determine when content appeared."),
  },
  async ({ pageId, bodyFormat, format, version }) => {
    const p = await confluence.getPage(pageId, bodyFormat, { format, version });
    return toolJsonResult(p);
  });

server.tool("confluence_get_page_by_title", "Get a Confluence page by space key and exact title", {
  spaceKey: z.string().describe("Space key"),
  title: z.string().describe("Exact page title")
}, async ({ spaceKey, title }) => {
  const p = await confluence.getPageByTitle(spaceKey, title);
  return toolJsonResult(p);
});

server.tool("confluence_get_comments", "Get all comments on a Confluence page", {
  pageId: z.string().describe("Page ID"),
  limit: z.number().optional().default(50).describe("Max comments")
}, async ({ pageId, limit }) => {
  const c = await confluence.getPageComments(pageId, limit);
  return toolJsonResult(c);
});

server.tool("confluence_get_children", "Get child pages of a Confluence page", {
  pageId: z.string().describe("Parent page ID"),
  limit: z.number().optional().default(50).describe("Max children")
}, async ({ pageId, limit }) => {
  const c = await confluence.getPageChildren(pageId, limit);
  return toolJsonResult(c);
});

server.tool("confluence_get_history", "Get version history of a Confluence page", {
  pageId: z.string().describe("Page ID"),
  limit: z.number().optional().default(10).describe("Number of versions")
}, async ({ pageId, limit }) => {
  const h = await confluence.getPageHistory(pageId, limit);
  return toolJsonResult(h);
});

// Returns a page of results plus an explicit isLast, so a caller can page a
// space to completion. Previously a bare array: asking for 100 and receiving
// 100 was indistinguishable from a space holding exactly 100 pages, and there
// was no cursor to continue with.
server.tool("confluence_space_pages",
  "List pages in a Confluence space, one page of results at a time. Check `isLast`: if it is "
  + "false, call again with `start` advanced by `limit` to continue.",
  {
    spaceKey: z.string().describe("Space key"),
    limit: z.number().optional().default(100).describe("Max pages per call"),
    start: z.number().optional().describe("Offset for the next page. Omit for the first page."),
  },
  async ({ spaceKey, limit, start }) => {
    const p = await confluence.getSpacePages(spaceKey, Math.min(limit, 200), { start });
    return toolListResult(p.pages, {
      isLast: p.isLast,
      total: p.total,
      start: p.start,
      limit: p.limit,
      itemsKey: "pages",
    });
  });

server.tool("confluence_get_labels", "Get all labels on a Confluence page", {
  pageId: z.string().describe("Page ID")
}, async ({ pageId }) => {
  const l = await confluence.getPageLabels(pageId);
  return toolJsonResult(l);
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
  return toolJsonResult(r);
});

server.tool("jira_update_issue", "Update fields on an existing Jira issue. Pass fields as a JSON string of field names to new values.", {
  issueKey: z.string().describe("Issue key (e.g. 'OS-123')"),
  fieldsJson: z.string().describe("JSON string of fields to update. Examples: '{\"summary\": \"New title\"}', '{\"priority\": {\"name\": \"High\"}}', '{\"labels\": [\"ui\", \"urgent\"]}'")
}, async ({ issueKey, fieldsJson }) => {
  const fields = JSON.parse(fieldsJson);
  const r = await client.updateIssue(issueKey, fields);
  return toolJsonResult(r);
});

server.tool("jira_transition_issue", "Move an issue to a new status. Use jira_get_transitions first to find available transition IDs.", {
  issueKey: z.string().describe("Issue key"),
  transitionId: z.string().describe("Transition ID (from jira_get_transitions)")
}, async ({ issueKey, transitionId }) => {
  const r = await client.transitionIssue(issueKey, transitionId);
  return toolJsonResult(r);
});

server.tool("jira_get_transitions", "Get available status transitions for an issue (needed before jira_transition_issue)", {
  issueKey: z.string().describe("Issue key")
}, async ({ issueKey }) => {
  const r = await client.getTransitions(issueKey);
  return toolJsonResult(r);
});

server.tool("jira_add_comment", "Add a comment to a Jira issue", {
  issueKey: z.string().describe("Issue key"),
  body: z.string().describe("Comment text (plain text)")
}, async ({ issueKey, body }) => {
  const r = await client.addComment(issueKey, body);
  return toolJsonResult(r);
});

server.tool("jira_add_worklog", "Log time spent on a Jira issue", {
  issueKey: z.string().describe("Issue key"),
  timeSpentSeconds: z.number().describe("Time spent in seconds (e.g. 3600 = 1 hour)"),
  started: z.string().optional().describe("When work started (ISO 8601, e.g. '2024-01-15T09:00:00.000+0000')"),
  comment: z.string().optional().describe("Worklog comment")
}, async ({ issueKey, timeSpentSeconds, started, comment }) => {
  const r = await client.addWorklog(issueKey, timeSpentSeconds, { started, comment });
  return toolJsonResult(r);
});

server.tool("jira_delete_issue", "Delete a Jira issue (requires admin permissions)", {
  issueKey: z.string().describe("Issue key to delete"),
  deleteSubtasks: z.boolean().optional().default(false).describe("Also delete subtasks")
}, async ({ issueKey, deleteSubtasks }) => {
  const r = await client.deleteIssue(issueKey, deleteSubtasks);
  return toolJsonResult(r);
});

server.tool("jira_assign_issue", "Assign an issue to a user", {
  issueKey: z.string().describe("Issue key"),
  accountId: z.string().describe("User's accountId (from jira_get_users). Use null string to unassign.")
}, async ({ issueKey, accountId }) => {
  const r = await client.assignIssue(issueKey, accountId === "null" ? null : accountId);
  return toolJsonResult(r);
});

server.tool("jira_get_users", "Get assignable users for a project (returns accountIds needed for assignment)", {
  projectKey: z.string().describe("Project key")
}, async ({ projectKey }) => {
  const r = await client.getUsers(projectKey);
  return toolJsonResult(r);
});

server.tool("jira_request", "Generic Jira REST API request — use for any endpoint not covered by other tools", {
  path: z.string().describe("API path (e.g. '/rest/api/3/issue/OS-123/watchers')"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().default("GET").describe("HTTP method"),
  queryParams: z.record(z.string()).optional().describe("Query parameters as key-value pairs"),
  bodyJson: z.string().optional().describe("Request body as JSON string (for POST/PUT/PATCH). Must be valid JSON.")
}, async ({ path, method, queryParams, bodyJson }) => {
  const body = bodyJson ? JSON.parse(bodyJson) : null;
  const r = await client.genericRequest(path, method, queryParams || {}, body);
  return toolJsonResult(r);
});

// ── CONFLUENCE WRITE TOOLS ──

server.tool("confluence_create_page", "Create a new Confluence page", {
  spaceKey: z.string().describe("Space key"),
  title: z.string().describe("Page title"),
  body: z.string().describe("Page body in Confluence storage format (HTML). Use <p>, <h1>-<h6>, <table>, <ul>/<ol>, <ac:structured-macro> etc."),
  parentId: z.string().optional().describe("Parent page ID to nest under (omit for top-level)")
}, async ({ spaceKey, title, body, parentId }) => {
  const r = await confluence.createPage(spaceKey, title, body, parentId);
  return toolJsonResult(r);
});

server.tool("confluence_update_page", "Update an existing Confluence page's title and/or body. You MUST provide the next version number (current + 1).", {
  pageId: z.string().describe("Page ID"),
  title: z.string().describe("Page title (can be same as current)"),
  body: z.string().describe("Full page body in storage format (replaces entire body)"),
  version: z.number().describe("Next version number (current version + 1, get from confluence_get_page)")
}, async ({ pageId, title, body, version }) => {
  const r = await confluence.updatePage(pageId, title, body, version);
  return toolJsonResult(r);
});

server.tool("confluence_add_comment", "Add a comment to a Confluence page", {
  pageId: z.string().describe("Page ID"),
  body: z.string().describe("Comment body in storage format (HTML)")
}, async ({ pageId, body }) => {
  const r = await confluence.addComment(pageId, body);
  return toolJsonResult(r);
});

server.tool("confluence_delete_page", "Delete a Confluence page", {
  pageId: z.string().describe("Page ID to delete")
}, async ({ pageId }) => {
  const r = await confluence.deletePage(pageId);
  return toolJsonResult(r);
});

server.tool("confluence_add_label", "Add a label to a Confluence page", {
  pageId: z.string().describe("Page ID"),
  label: z.string().describe("Label name (lowercase, no spaces)")
}, async ({ pageId, label }) => {
  const r = await confluence.addLabel(pageId, label);
  return toolJsonResult(r);
});

server.tool("confluence_request", "Generic Confluence REST API request — use for any endpoint not covered by other tools", {
  path: z.string().describe("API path (e.g. '/wiki/rest/api/content/12345/label' or '/wiki/api/v2/pages')"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().default("GET").describe("HTTP method"),
  queryParams: z.record(z.string()).optional().describe("Query parameters as key-value pairs"),
  bodyJson: z.string().optional().describe("Request body as JSON string (for POST/PUT/PATCH). Must be valid JSON.")
}, async ({ path, method, queryParams, bodyJson }) => {
  const body = bodyJson ? JSON.parse(bodyJson) : null;
  const r = await confluence.genericRequest(path, method, queryParams || {}, body);
  return toolJsonResult(r);
});

// ── START ──
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[atlassian-bridge] MCP server running - Jira + Confluence on " + creds.siteName + ".atlassian.net");

