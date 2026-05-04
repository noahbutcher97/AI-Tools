import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

import { loadBridgeConfigOrExit } from "../../lib/bridge-base.mjs";

// Load manifest so the shared resolver knows what fields to look for, then
// inject resolved values into process.env. The legacy resolveCredentials()
// below picks them up via its tier-1 env path (no behavior change).
const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(__dirname, "manifest.json"), "utf-8"));
loadBridgeConfigOrExit("miro", manifest.fields);

// ──────────────────────────────────────────────────────
//  CREDENTIAL RESOLUTION (legacy 3-tier kept for backward compatibility)
// ──────────────────────────────────────────────────────

function resolveCredentials() {
  // Priority 1: Direct env vars
  if (process.env.MIRO_ACCESS_TOKEN) {
    console.error(`[miro-bridge] Using direct env credentials`);
    return {
      accessToken: process.env.MIRO_ACCESS_TOKEN,
      orgName: process.env.MIRO_ORG_NAME || "unknown",
      source: "env"
    };
  }
  // Priority 2: PROJECT_ROOT env var
  if (process.env.PROJECT_ROOT) {
    const mcpPath = join(resolve(process.env.PROJECT_ROOT), ".mcp.json");
    const creds = readMcpJson(mcpPath);
    if (creds) return creds;
    console.error(`[miro-bridge] PROJECT_ROOT set but no valid .mcp.json at: ${mcpPath}`);
  }
  // Priority 3: Walk up from cwd
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
    const env = raw?.mcpServers?.miro?.env;
    if (!env?.MIRO_ACCESS_TOKEN) return null;
    console.error(`[miro-bridge] Loaded credentials from: ${filePath} (org: ${env.MIRO_ORG_NAME || "unknown"})`);
    return {
      accessToken: env.MIRO_ACCESS_TOKEN,
      orgName: env.MIRO_ORG_NAME || "unknown",
      source: filePath
    };
  } catch (e) {
    console.error(`[miro-bridge] Failed to parse ${filePath}: ${e.message}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════
//  MIRO REST API v2 CLIENT
// ══════════════════════════════════════════════════════

class MiroClient {
  constructor(accessToken) {
    this.baseUrl = "https://api.miro.com/v2";
    this.token = accessToken;
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
    const resp = await fetch(url.toString(), opts);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Miro API ${resp.status}: ${text}`);
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

// ══════════════════════════════════════════════════════
//  MCP SERVER + TOOLS
// ══════════════════════════════════════════════════════

const creds = resolveCredentials();
if (!creds) {
  console.error("[miro-bridge] ERROR: No Miro credentials found.");
  console.error("  Set PROJECT_ROOT env var to a folder with .mcp.json containing a 'miro' server entry,");
  console.error("  or pass MIRO_ACCESS_TOKEN directly as an env var.");
  process.exit(1);
}

const miro = new MiroClient(creds.accessToken);
const server = new McpServer({
  name: "miro-bridge",
  version: "1.0.0",
  description: "Miro Bridge for " + creds.orgName + " (credentials from " + creds.source + ")"
});

// ── connection_info ──
server.tool("connection_info", "Show which Miro org this server is connected to and where credentials came from", {},
  async () => ({ content: [{ type: "text", text: JSON.stringify({
    org: creds.orgName, tokenPrefix: creds.accessToken.slice(0, 20) + "...",
    credentialSource: creds.source
  }, null, 2) }] }));

// ── miro_list_boards ──
server.tool("miro_list_boards", "List Miro boards. Optionally filter by team or search query.", {
  teamId: z.string().optional().describe("Filter by team ID"),
  query: z.string().optional().describe("Search boards by name"),
  limit: z.number().optional().default(50).describe("Max results (1-50)")
}, async ({ teamId, query, limit }) => {
  const r = await miro.listBoards(teamId, query, Math.min(limit, 50));
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── miro_get_board ──
server.tool("miro_get_board", "Get details of a specific Miro board", {
  boardId: z.string().describe("Board ID (from miro_list_boards or board URL)")
}, async ({ boardId }) => {
  const b = await miro.getBoard(boardId);
  return { content: [{ type: "text", text: JSON.stringify(b, null, 2) }] };
});

// ── miro_get_board_items ──
server.tool("miro_get_board_items", "Get items on a Miro board. Filter by type for targeted queries.", {
  boardId: z.string().describe("Board ID"),
  type: z.string().optional().describe("Filter by item type: sticky_note, shape, text, frame, image, card, app_card, document, embed"),
  limit: z.number().optional().default(50).describe("Max results (1-50)"),
  cursor: z.string().optional().describe("Pagination cursor from previous response")
}, async ({ boardId, type, limit, cursor }) => {
  const r = await miro.getBoardItems(boardId, type, Math.min(limit, 50), cursor);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── miro_get_item ──
server.tool("miro_get_item", "Get a single item from a board by item ID", {
  boardId: z.string().describe("Board ID"),
  itemId: z.string().describe("Item ID")
}, async ({ boardId, itemId }) => {
  const i = await miro.getItem(boardId, itemId);
  return { content: [{ type: "text", text: JSON.stringify(i, null, 2) }] };
});

// ── miro_create_sticky_note ──
server.tool("miro_create_sticky_note", "Create a sticky note on a Miro board", {
  boardId: z.string().describe("Board ID"),
  content: z.string().describe("Sticky note text (supports basic HTML: <p>, <b>, <i>, <a>)"),
  color: z.string().optional().describe("Fill color: gray, light_yellow, yellow, orange, light_green, green, dark_green, cyan, light_pink, pink, violet, red, light_blue, blue, dark_blue, black"),
  x: z.number().optional().describe("X position"),
  y: z.number().optional().describe("Y position"),
  parentId: z.string().optional().describe("Parent frame ID to place inside")
}, async ({ boardId, content, color, x, y, parentId }) => {
  const r = await miro.createStickyNote(boardId, content, { color, x, y, parentId });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── miro_update_sticky_note ──
server.tool("miro_update_sticky_note", "Update an existing sticky note's content, color, or position", {
  boardId: z.string().describe("Board ID"),
  itemId: z.string().describe("Sticky note item ID"),
  content: z.string().describe("Updated text content"),
  color: z.string().optional().describe("New fill color"),
  x: z.number().optional().describe("New X position"),
  y: z.number().optional().describe("New Y position")
}, async ({ boardId, itemId, content, color, x, y }) => {
  const r = await miro.updateStickyNote(boardId, itemId, content, { color, x, y });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── miro_create_shape ──
server.tool("miro_create_shape", "Create a shape on a Miro board (rectangle, circle, triangle, etc.)", {
  boardId: z.string().describe("Board ID"),
  shapeType: z.string().describe("Shape type: rectangle, circle, triangle, wedge_round_rectangle_callout, round_rectangle, rhombus, trapezoid, pentagon, hexagon, octagon, star, flow_chart_*, cloud, cross, can, right_arrow, left_arrow, left_right_arrow, left_brace, right_brace, parallelogram"),
  content: z.string().optional().default("").describe("Text inside the shape"),
  color: z.string().optional().describe("Fill color hex (e.g. '#FF0000') or named color"),
  x: z.number().optional().describe("X position"),
  y: z.number().optional().describe("Y position"),
  width: z.number().optional().describe("Width in pixels"),
  height: z.number().optional().describe("Height in pixels"),
  parentId: z.string().optional().describe("Parent frame ID")
}, async ({ boardId, shapeType, content, color, x, y, width, height, parentId }) => {
  const r = await miro.createShape(boardId, shapeType, content, { color, x, y, width, height, parentId });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── miro_create_text ──
server.tool("miro_create_text", "Create a text item on a Miro board", {
  boardId: z.string().describe("Board ID"),
  content: z.string().describe("Text content (supports HTML)"),
  x: z.number().optional().describe("X position"),
  y: z.number().optional().describe("Y position"),
  fontSize: z.number().optional().describe("Font size (10-288)")
}, async ({ boardId, content, x, y, fontSize }) => {
  const r = await miro.createText(boardId, content, { x, y, fontSize });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── miro_create_frame ──
server.tool("miro_create_frame", "Create a frame (container) on a Miro board. Items can be placed inside frames using parentId.", {
  boardId: z.string().describe("Board ID"),
  title: z.string().describe("Frame title"),
  x: z.number().optional().describe("X position"),
  y: z.number().optional().describe("Y position"),
  width: z.number().optional().default(800).describe("Frame width"),
  height: z.number().optional().default(600).describe("Frame height")
}, async ({ boardId, title, x, y, width, height }) => {
  const r = await miro.createFrame(boardId, title, { x, y, width, height });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── miro_create_connector ──
server.tool("miro_create_connector", "Create a connector (arrow/line) between two items on a board", {
  boardId: z.string().describe("Board ID"),
  startItemId: z.string().describe("Start item ID"),
  endItemId: z.string().describe("End item ID"),
  caption: z.string().optional().describe("Text label on the connector")
}, async ({ boardId, startItemId, endItemId, caption }) => {
  const r = await miro.createConnector(boardId, startItemId, endItemId, { caption });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── miro_get_connectors ──
server.tool("miro_get_connectors", "Get all connectors on a board", {
  boardId: z.string().describe("Board ID")
}, async ({ boardId }) => {
  const r = await miro.getConnectors(boardId);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── miro_get_tags ──
server.tool("miro_get_tags", "Get all tags defined on a board", {
  boardId: z.string().describe("Board ID")
}, async ({ boardId }) => {
  const r = await miro.getTags(boardId);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── miro_create_tag ──
server.tool("miro_create_tag", "Create a tag on a board", {
  boardId: z.string().describe("Board ID"),
  title: z.string().describe("Tag name"),
  fillColor: z.string().optional().default("yellow").describe("Tag color: red, light_green, cyan, yellow, violet, dark_green, dark_blue, blue, gray, magenta, orange, light_yellow, light_blue, light_pink, pink, black")
}, async ({ boardId, title, fillColor }) => {
  const r = await miro.createTag(boardId, title, fillColor);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── miro_attach_tag ──
server.tool("miro_attach_tag", "Attach a tag to an item on a board", {
  boardId: z.string().describe("Board ID"),
  itemId: z.string().describe("Item ID to tag"),
  tagId: z.string().describe("Tag ID (from miro_get_tags or miro_create_tag)")
}, async ({ boardId, itemId, tagId }) => {
  const r = await miro.attachTag(boardId, itemId, tagId);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── miro_delete_item ──
server.tool("miro_delete_item", "Delete an item from a board", {
  boardId: z.string().describe("Board ID"),
  itemId: z.string().describe("Item ID to delete")
}, async ({ boardId, itemId }) => {
  const r = await miro.deleteItem(boardId, itemId);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── miro_get_board_members ──
server.tool("miro_get_board_members", "Get members who have access to a board", {
  boardId: z.string().describe("Board ID")
}, async ({ boardId }) => {
  const r = await miro.getBoardMembers(boardId);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ── START ──
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[miro-bridge] MCP server running - " + creds.orgName + " (token from " + creds.source + ")");
