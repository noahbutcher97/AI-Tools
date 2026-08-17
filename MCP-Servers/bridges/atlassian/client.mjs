// Atlassian + Confluence HTTP clients.
//
// Extracted verbatim from server.mjs so the request/parse logic is unit-
// testable against a mocked fetch, matching the client.mjs split already used
// by the otter bridge and the parsers.mjs split used by perforce. This move is
// mechanical: the class bodies are unchanged apart from the export keyword.

export class AtlassianClient {
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

  async searchIssues(jql, maxResults = 50, nextPageToken = null, fields = null) {
    // Atlassian removed /rest/api/3/search in their April 2025 changelog
    // (CHANGE-2046). The replacement /rest/api/3/search/jql differs in two
    // material ways:
    //   1. Pagination is token-based (nextPageToken), not offset-based
    //      (startAt). Response no longer includes `total` or `startAt`.
    //   2. The default `fields` set is now {id} only — old endpoint
    //      returned the full *navigable set. We default to "*all" so the
    //      bridge's _formatIssue() keeps populating key/summary/status/etc.
    //      Callers can still pass an explicit field list to narrow the
    //      payload (e.g. "summary,status,priority" for terse summaries).
    const params = { jql, maxResults, fields: fields || "*all" };
    if (nextPageToken) params.nextPageToken = nextPageToken;
    const data = await this.request("/rest/api/3/search/jql", params);
    return {
      issues: data.issues.map(i => this._formatIssue(i)),
      nextPageToken: data.nextPageToken || null,
      isLast: data.isLast === true,
    };
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

export class ConfluenceClient {
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
