import { htmlToText } from "../../lib/html-text.mjs";

// Atlassian + Confluence HTTP clients.
//
// Extracted verbatim from server.mjs so the request/parse logic is unit-
// testable against a mocked fetch, matching the client.mjs split already used
// by the otter bridge and the parsers.mjs split used by perforce. This move is
// mechanical: the class bodies are unchanged apart from the export keyword.

export class AtlassianClient {
  // fetchImpl is injectable so request/parse logic can be unit tested without a
  // live instance, matching the otter bridge's client. Defaults to global fetch.
  constructor(creds, { fetchImpl } = {}) {
    this.baseUrl = `https://${creds.siteName}.atlassian.net`;
    this.auth = Buffer.from(`${creds.userEmail}:${creds.apiToken}`).toString("base64");
    this.siteName = creds.siteName;
    this.fetch = fetchImpl || ((...args) => fetch(...args));
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
    const resp = await this.fetch(url.toString(), opts);
    if (!resp.ok) {
      const text = await resp.text();
      // The status is attached as a value, not just formatted into the message.
      // Callers that must tell a missing issue from an unreadable one (404 vs
      // 403) cannot recover it by parsing the string. Message text is unchanged
      // so anything matching on it keeps working.
      const err = new Error(`Atlassian API ${resp.status}: ${text}`);
      err.status = resp.status;
      err.body = text;
      throw err;
    }
    if (resp.status === 204) return { success: true };
    return resp.json();
  }

  // ── Key validation ──
  //
  // A JQL `key in (...)` query returns only the keys it resolves. There is no
  // error and no list of omissions, so a caller reading the result infers that
  // an absent key was deleted. That inference is unsafe for two distinct
  // reasons: the API returns the same 404 for a missing issue and one the
  // caller may not read, and a live issue can be missing from the search index
  // while still fetching fine by key.
  //
  // So resolution is per key, by direct fetch — the only route that sees an
  // unindexed issue — and every input key gets exactly one verdict. Omission is
  // structurally impossible: results.length always equals keys.length.

  async validateKeys(keys, options = {}) {
    const {
      checkSearchable = true,
      concurrency = 5,
      maxRetries = 3,
      retryDelayMs = 1000,
    } = options;

    const summary = {
      exists: 0,
      moved: 0,
      exists_not_searchable: 0,
      not_found_or_no_permission: 0,
      no_permission: 0,
      rate_limited: 0,
      error: 0,
    };

    if (!Array.isArray(keys) || keys.length === 0) {
      return { total: 0, isLast: true, unresolved: 0, summary, results: [] };
    }

    // Phase 1 — one direct fetch per key, bounded concurrency.
    const results = new Array(keys.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < keys.length) {
        const i = cursor;
        cursor += 1;
        results[i] = await this._resolveKey(keys[i], { maxRetries, retryDelayMs });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, keys.length) }, () => worker()),
    );

    // Phase 2 — searchability, as ONE bulk query per chunk rather than a second
    // fetch per key. Any key that resolved by fetch but does not come back from
    // JQL is the case that silently corrupts reference-integrity checks.
    if (checkSearchable) {
      const live = results.filter((r) => r.verdict === "exists" || r.verdict === "moved");
      if (live.length > 0) {
        try {
          const seen = await this._searchableKeys(live.map((r) => r.resolvedKey || r.key));
          for (const r of live) {
            if (!seen.has(r.resolvedKey || r.key)) {
              r.verdict = "exists_not_searchable";
              r.note =
                "Fetches by key but is absent from JQL results — it will be silently omitted "
                + "from any `key in (...)` query. Do not treat that omission as deletion.";
            }
          }
        } catch (e) {
          // Searchability is an enrichment. If the search itself fails, say so
          // rather than downgrading verdicts already established by fetch.
          for (const r of live) {
            r.searchableCheck = `skipped: ${e.message}`;
          }
        }
      }
    }

    for (const r of results) summary[r.verdict] += 1;

    return {
      total: results.length,
      isLast: true,
      // Keys whose true state could not be established. Never fold these into a
      // missing-style verdict — unknown is not absent.
      unresolved: summary.rate_limited + summary.error,
      summary,
      results,
    };
  }

  // ── Link graph ──
  //
  // Returns current links per issue with type, direction and target, plus
  // whether each target still resolves — so a dangling link is a one-call
  // check instead of a per-issue changelog replay.
  //
  // Sources are resolved one key at a time rather than by a bulk
  // `key in (...)` query, for the same reason validateKeys is: a bulk query
  // silently omits an unindexed issue, and a graph missing a node is worse
  // than no graph at all.
  async getLinks(keys, options = {}) {
    const { checkTargets = true, concurrency = 5, maxRetries = 3, retryDelayMs = 1000 } = options;

    if (!Array.isArray(keys) || keys.length === 0) {
      return { total: 0, isLast: true, danglingCount: 0, linkCount: 0, results: [] };
    }

    const results = new Array(keys.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < keys.length) {
        const i = cursor;
        cursor += 1;
        results[i] = await this._linksForKey(keys[i], { maxRetries, retryDelayMs });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, () => worker()));

    if (checkTargets) {
      const targets = [...new Set(
        results.flatMap((r) => r.links.map((l) => l.targetKey)).filter(Boolean),
      )];
      if (targets.length > 0) {
        const verdicts = await this.validateKeys(targets, { checkSearchable: false, concurrency });
        const live = new Map(verdicts.results.map((v) => [v.key, v.verdict]));
        for (const r of results) {
          for (const l of r.links) {
            const verdict = live.get(l.targetKey);
            // Only a confirmed resolution counts as existing. An unknown state
            // (rate limited, request error) must not read as a live target.
            l.targetExists = verdict === "exists" || verdict === "moved"
              || verdict === "exists_not_searchable";
            l.targetVerdict = verdict ?? "unchecked";
          }
        }
      }
    }

    const allLinks = results.flatMap((r) => r.links);
    return {
      total: results.length,
      isLast: true,
      linkCount: allLinks.length,
      danglingCount: allLinks.filter((l) => l.targetExists === false).length,
      results,
    };
  }

  async _linksForKey(key, { maxRetries, retryDelayMs }) {
    const resolved = await this._resolveKey(key, { maxRetries, retryDelayMs });
    if (resolved.verdict !== "exists" && resolved.verdict !== "moved") {
      // The source itself is unresolvable — reported, never dropped.
      return { key, sourceVerdict: resolved.verdict, links: [] };
    }
    try {
      const data = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: "issuelinks" });
      const links = (data.fields?.issuelinks || []).map((l) => {
        const outward = l.outwardIssue || null;
        const inward = l.inwardIssue || null;
        const target = outward || inward;
        return {
          type: l.type?.name ?? null,
          direction: outward ? "outward" : "inward",
          relation: outward ? (l.type?.outward ?? null) : (l.type?.inward ?? null),
          targetKey: target?.key ?? null,
        };
      });
      return { key, sourceVerdict: "exists", links };
    } catch (e) {
      return { key, sourceVerdict: "error", error: e.message, links: [] };
    }
  }

  async _resolveKey(key, { maxRetries, retryDelayMs }) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const data = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: "key" });
        const resolved = data && data.key;
        if (resolved && resolved !== key) {
          return { key, verdict: "moved", resolvedKey: resolved };
        }
        return { key, verdict: "exists" };
      } catch (e) {
        if (e.status === 429 && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
          continue;
        }
        if (e.status === 429) {
          return {
            key,
            verdict: "rate_limited",
            status: 429,
            note: "Rate limited after retries — status unknown, not confirmed absent.",
          };
        }
        if (e.status === 404) {
          return {
            key,
            verdict: "not_found_or_no_permission",
            status: 404,
            note: "The API returns 404 both for a missing issue and one you may not read; "
              + "these are not distinguishable from here.",
          };
        }
        if (e.status === 403) return { key, verdict: "no_permission", status: 403 };
        return { key, verdict: "error", status: e.status ?? null, note: e.message };
      }
    }
  }

  // Returns the set of keys JQL can actually see, chunked so a large batch does
  // not exceed the query's result window, and paged so a full page is never
  // mistaken for a complete one.
  async _searchableKeys(keys, chunkSize = 50) {
    const seen = new Set();
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      let nextPageToken = null;
      do {
        const params = { jql: `key in (${chunk.join(",")})`, maxResults: 100, fields: "key" };
        if (nextPageToken) params.nextPageToken = nextPageToken;
        const data = await this.request("/rest/api/3/search/jql", params);
        for (const issue of data.issues || []) seen.add(issue.key);
        nextPageToken = data.isLast === true ? null : data.nextPageToken || null;
      } while (nextPageToken);
    }
    return seen;
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
  // fetchImpl is injectable for the same reason as AtlassianClient: the
  // pagination logic below is only meaningful if it can be tested against
  // recorded responses rather than a live instance.
  constructor(creds, { fetchImpl } = {}) {
    const c = creds.confluence || creds;
    this.baseUrl = `https://${c.siteName}.atlassian.net`;
    this.auth = Buffer.from(`${c.userEmail}:${c.apiToken}`).toString("base64");
    this.siteName = c.siteName;
    this.fetch = fetchImpl || ((...args) => fetch(...args));
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
    const resp = await this.fetch(url.toString(), opts);
    if (!resp.ok) {
      const text = await resp.text();
      const err = new Error(`Confluence API ${resp.status}: ${text}`);
      err.status = resp.status;
      err.body = text;
      throw err;
    }
    if (resp.status === 204) return { success: true };
    return resp.json();
  }

  // Spaces come in more types than the two this tool used to document. On a real
  // instance the largest space by page count is type "collaboration", which a
  // global/personal filter excludes entirely — so filtering returned a confident
  // and complete-looking result that omitted the main project space. The filter
  // is now a pass-through: any type the API accepts is accepted here.
  async listSpaces({ limit = 25, type = null, start = null } = {}) {
    const params = { limit };
    if (type) params.type = type;
    if (start !== null && start !== undefined) params.start = start;
    const data = await this.request("/wiki/rest/api/space", params);
    const spaces = (data.results || []).map(s => ({
      key: s.key, name: s.name, type: s.type, status: s.status,
      url: s._links?.webui ? `${this.baseUrl}/wiki${s._links.webui}` : null,
    }));
    return {
      count: spaces.length,
      // v1 reports a per-page size, never a collection total.
      total: null,
      start: data.start ?? start ?? 0,
      limit: data.limit ?? limit,
      isLast: !data._links?.next,
      spaces,
    };
  }

  // This is the tool callers fall back to when space enumeration fails them, and
  // a full page was previously indistinguishable from the last one.
  //
  // The endpoint returns {start, limit, size, _links.next} and NO total — the
  // previous code read `data.totalSize`, which this API does not send, so the
  // reported total was always undefined. Verified against the live instance.
  // Completeness therefore comes from the next link, as elsewhere in v1, and
  // total stays an explicit null rather than a fabricated number.
  async search(cql, limit = 25, start = 0) {
    const data = await this.request("/wiki/rest/api/content/search", { cql, limit, start, expand: "version,space,ancestors" });
    const results = (data.results || []).map(p => this._formatPage(p));
    return {
      count: results.length,
      total: null,
      start: data.start ?? start,
      limit: data.limit ?? limit,
      isLast: !data._links?.next,
      results,
    };
  }

  // `format: "text"` strips markup server-side. Large pages are mostly macro
  // and attachment wrappers rather than prose — on a sampled page this took
  // 12,964 characters to 3,055 — and returning raw HTML pushed callers into
  // writing their own stripping just to read a page.
  //
  // `version` fetches a historical revision. Version metadata was already
  // available but content was not, so "did this text exist at version N-1?"
  // was unanswerable.
  async getPage(pageId, bodyFormat = "storage", { format = "html", version = null } = {}) {
    const expand = `body.${bodyFormat},version,space,ancestors,children.page,children.comment,metadata.labels`;
    const params = { expand };
    if (version !== null && version !== undefined) params.version = version;
    const data = await this.request(`/wiki/rest/api/content/${pageId}`, params);
    const raw = data.body?.[bodyFormat]?.value || null;
    const asText = format === "text" && raw !== null ? htmlToText(raw) : null;
    return {
      ...this._formatPage(data),
      body: format === "text" ? asText : raw,
      // Both lengths are reported so a caller can see what stripping removed,
      // and can tell a genuinely short page from an over-aggressive strip.
      ...(raw !== null ? { rawBodyLength: raw.length } : {}),
      ...(format === "text" ? { bodyLength: asText === null ? 0 : asText.length } : {}),
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

  // Previously returned a bare array with no way to continue and no way to tell
  // a truncated page from a complete one — asking for 100 and receiving 100 was
  // indistinguishable from a space with exactly 100 pages.
  //
  // `isLast` comes from the absence of the API's own next link, which is the
  // only reliable signal here. `total` stays null: the v1 endpoint reports the
  // size of the page it just returned, not the size of the collection, and
  // passing that off as a total is what made truncation invisible.
  async getSpacePages(spaceKey, limit = 100, { start = null, depth = "all" } = {}) {
    const params = { spaceKey, type: "page", limit, depth, expand: "version,ancestors" };
    if (start !== null && start !== undefined) params.start = start;
    const data = await this.request("/wiki/rest/api/content", params);
    const pages = (data.results || []).map(p => this._formatPage(p));
    return {
      count: pages.length,
      total: null,
      start: data.start ?? start ?? 0,
      limit: data.limit ?? limit,
      isLast: !data._links?.next,
      pages,
    };
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

  // Delegates to the shared implementation in lib/ so this bridge and the miro
  // bridge cannot drift apart on what "text" means. Behaviour differs from the
  // previous local copy in one respect: tags now collapse to a space rather
  // than to nothing, so adjacent blocks no longer weld together
  // ("<li>one</li><li>two</li>" reads as "one two", not "onetwo").
  _stripHtml(html) {
    return htmlToText(html);
  }
}
