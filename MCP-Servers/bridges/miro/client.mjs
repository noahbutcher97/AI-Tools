// Miro REST client.
//
// Extracted verbatim from server.mjs so request logic is unit-testable against
// a mocked fetch, matching the client.mjs split used by the atlassian and otter
// bridges. Mechanical move: the class body is unchanged apart from the export.

export class MiroClient {
  // fetchImpl is injectable so request construction can be unit tested without
  // a live board, matching the atlassian and otter clients.
  constructor(accessToken, { fetchImpl } = {}) {
    this.baseUrl = "https://api.miro.com/v2";
    this.origin = "https://api.miro.com";
    this.token = accessToken;
    this.fetch = fetchImpl || ((...args) => fetch(...args));
  }

  // Generic passthrough to any Miro API path, mirroring jira_request on the
  // atlassian bridge. The purpose-built tools cover seventeen operations; an
  // item type or endpoint outside that set was previously unreachable, with no
  // escape hatch short of changing this file.
  //
  // Paths are resolved against the API origin rather than the client's default
  // base, so a caller can reach a path outside /v2 - an experimental or legacy
  // endpoint - which is a large part of why a passthrough is useful.
  async rawRequest(path, { method = "GET", queryParams = {}, bodyJson = null } = {}) {
    const url = new URL(path, this.origin);
    // Numbers are coerced rather than rejected: callers naturally write
    // { limit: 50 }, and a schema that only accepts strings turns an ordinary
    // call into a type error for no benefit.
    Object.entries(queryParams || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    });
    const opts = {
      method,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
    };
    if (bodyJson && method !== "GET" && method !== "DELETE") opts.body = JSON.stringify(bodyJson);
    const resp = await this.fetch(url.toString(), opts);
    if (!resp.ok) {
      const text = await resp.text();
      const err = new Error(`Miro API ${resp.status}: ${text}`);
      err.status = resp.status;
      err.body = text;
      throw err;
    }
    if (resp.status === 204) return null;
    return resp.json();
  }

  async request(path, params = {}, method = "GET", body = null) {
    const url = new URL(path, this.baseUrl);
    if (method === "GET") {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      });
    }
    const opts = {
      method,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Accept": "application/json",
        "Content-Type": "application/json"
      }
    };
    if (body) opts.body = JSON.stringify(body);
    const resp = await this.fetch(url.toString(), opts);
    if (!resp.ok) {
      const text = await resp.text();
      const err = new Error(`Miro API ${resp.status}: ${text}`);
      err.status = resp.status;
      err.body = text;
      throw err;
    }
    if (resp.status === 204) return null;
    return resp.json();
  }

  // ── Boards ──
  async listBoards(teamId = null, query = null, limit = 50) {
    const params = { limit };
    if (teamId) params.team_id = teamId;
    if (query) params.query = query;
    const data = await this.request("/v2/boards", params);
    return { total: data.total, boards: data.data.map(b => this._fmtBoard(b)) };
  }

  async getBoard(boardId) {
    const data = await this.request(`/v2/boards/${boardId}`);
    return this._fmtBoard(data);
  }

  // ── Board Items (generic) ──
  async getBoardItems(boardId, type = null, limit = 50, cursor = null) {
    const params = { limit };
    if (type) params.type = type;
    if (cursor) params.cursor = cursor;
    const data = await this.request(`/v2/boards/${boardId}/items`, params);
    return {
      items: data.data.map(i => this._fmtItem(i)),
      cursor: data.cursor || null,
      total: data.total
    };
  }

  async getItem(boardId, itemId) {
    const data = await this.request(`/v2/boards/${boardId}/items/${itemId}`);
    return this._fmtItem(data);
  }

  // ── Sticky Notes ──
  async createStickyNote(boardId, content, opts = {}) {
    const body = { data: { content } };
    if (opts.color) body.style = { fillColor: opts.color };
    if (opts.x !== undefined && opts.y !== undefined) {
      body.position = { x: opts.x, y: opts.y };
    }
    if (opts.parentId) body.parent = { id: opts.parentId };
    const data = await this.request(`/v2/boards/${boardId}/sticky_notes`, {}, "POST", body);
    return this._fmtItem(data);
  }

  async updateStickyNote(boardId, itemId, content, opts = {}) {
    const body = { data: { content } };
    if (opts.color) body.style = { fillColor: opts.color };
    if (opts.x !== undefined && opts.y !== undefined) {
      body.position = { x: opts.x, y: opts.y };
    }
    const data = await this.request(`/v2/boards/${boardId}/sticky_notes/${itemId}`, {}, "PATCH", body);
    return this._fmtItem(data);
  }

  // ── Shapes ──
  async createShape(boardId, shapeType, content, opts = {}) {
    const body = { data: { shape: shapeType, content } };
    if (opts.x !== undefined && opts.y !== undefined) body.position = { x: opts.x, y: opts.y };
    if (opts.width || opts.height) body.geometry = {};
    if (opts.width) body.geometry.width = opts.width;
    if (opts.height) body.geometry.height = opts.height;
    if (opts.color) body.style = { fillColor: opts.color };
    if (opts.parentId) body.parent = { id: opts.parentId };
    const data = await this.request(`/v2/boards/${boardId}/shapes`, {}, "POST", body);
    return this._fmtItem(data);
  }

  // ── Text ──
  async createText(boardId, content, opts = {}) {
    const body = { data: { content } };
    if (opts.x !== undefined && opts.y !== undefined) body.position = { x: opts.x, y: opts.y };
    if (opts.fontSize) body.style = { fontSize: String(opts.fontSize) };
    const data = await this.request(`/v2/boards/${boardId}/texts`, {}, "POST", body);
    return this._fmtItem(data);
  }

  // ── Frames ──
  async createFrame(boardId, title, opts = {}) {
    const body = { data: { title, type: "freeform" } };
    if (opts.x !== undefined && opts.y !== undefined) body.position = { x: opts.x, y: opts.y };
    if (opts.width || opts.height) body.geometry = {};
    if (opts.width) body.geometry.width = opts.width;
    if (opts.height) body.geometry.height = opts.height;
    const data = await this.request(`/v2/boards/${boardId}/frames`, {}, "POST", body);
    return this._fmtItem(data);
  }

  // ── Connectors ──
  async createConnector(boardId, startItemId, endItemId, opts = {}) {
    const body = {
      startItem: { id: startItemId },
      endItem: { id: endItemId }
    };
    if (opts.caption) body.captions = [{ content: opts.caption }];
    if (opts.style) body.style = opts.style;
    const data = await this.request(`/v2/boards/${boardId}/connectors`, {}, "POST", body);
    return { id: data.id, type: "connector", startItem: data.startItem, endItem: data.endItem };
  }

  async getConnectors(boardId, limit = 50) {
    const data = await this.request(`/v2/boards/${boardId}/connectors`, { limit });
    return data.data.map(c => ({ id: c.id, type: "connector", startItem: c.startItem, endItem: c.endItem, captions: c.captions }));
  }

  // ── Tags ──
  async getTags(boardId) {
    const data = await this.request(`/v2/boards/${boardId}/tags`);
    return data.data.map(t => ({ id: t.id, title: t.title, fillColor: t.fillColor }));
  }

  async createTag(boardId, title, fillColor = "yellow") {
    const data = await this.request(`/v2/boards/${boardId}/tags`, {}, "POST", { title, fillColor });
    return { id: data.id, title: data.title, fillColor: data.fillColor };
  }

  async attachTag(boardId, itemId, tagId) {
    await this.request(`/v2/boards/${boardId}/items/${itemId}/tags`, {}, "POST", { id: tagId });
    return { success: true, itemId, tagId };
  }

  // ── Delete ──
  async deleteItem(boardId, itemId) {
    await this.request(`/v2/boards/${boardId}/items/${itemId}`, {}, "DELETE");
    return { deleted: true, itemId };
  }

  // ── Board Members ──
  async getBoardMembers(boardId, limit = 50) {
    const data = await this.request(`/v2/boards/${boardId}/members`, { limit });
    return data.data.map(m => ({ id: m.id, name: m.name, role: m.role }));
  }

  // ── Format helpers ──
  _fmtBoard(b) {
    return {
      id: b.id, name: b.name, description: b.description,
      owner: b.owner?.name, team: b.team?.name,
      createdAt: b.createdAt, modifiedAt: b.modifiedAt,
      viewLink: b.viewLink
    };
  }

  _fmtItem(i) {
    return {
      id: i.id, type: i.type,
      content: i.data?.content || i.data?.title || i.data?.shape || null,
      position: i.position || null,
      geometry: i.geometry || null,
      style: i.style || null,
      parentId: i.parent?.id || null,
      createdBy: i.createdBy?.name,
      modifiedAt: i.modifiedAt
    };
  }
}
