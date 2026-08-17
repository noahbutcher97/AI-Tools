import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

import { loadBridgeConfigOrExit } from "../../lib/bridge-base.mjs";
import { toolJsonResult, toolErrorResult, toolListResult } from "../../lib/tool-result.mjs";
import { MiroClient } from "./client.mjs";

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
  async () => toolJsonResult({
    org: creds.orgName, tokenPrefix: creds.accessToken.slice(0, 20) + "...",
    credentialSource: creds.source
  }));

// ── miro_list_boards ──
// Without teamId, the underlying /v2/boards endpoint returns every board
// the token can see across every team. Callers that meant "boards in my
// team" need a way to notice that fact, so the response is wrapped with
// scope/warning fields when teamId is absent.
// See _handoffs/2026-05-18-bridge-scope-leak-audit.md.
server.tool("miro_list_boards", "List Miro boards. With teamId: scoped to that team. WITHOUT teamId: returns boards across ALL teams the token can access (response includes a scope warning).", {
  teamId: z.string().optional().describe("Team ID to scope to. Strongly recommended — omitting it returns boards from every team the token can access."),
  query: z.string().optional().describe("Search boards by name"),
  limit: z.number().optional().default(50).describe("Max results (1-50)")
}, async ({ teamId, query, limit }) => {
  const r = await miro.listBoards(teamId, query, Math.min(limit, 50));
  if (teamId) {
    return toolJsonResult({ scope: `team: ${teamId}`, ...r });
  }
  return toolJsonResult({
    scope: "ALL_TEAMS",
    warning: `No teamId provided — returning ${r.total ?? r.boards.length} boards across all teams the token can access. Pass teamId to scope.`,
    ...r,
  });
});

// ── miro_get_board ──
server.tool("miro_get_board", "Get details of a specific Miro board", {
  boardId: z.string().describe("Board ID (from miro_list_boards or board URL)")
}, async ({ boardId }) => {
  const b = await miro.getBoard(boardId);
  return toolJsonResult(b);
});

// ── miro_get_board_items ──
server.tool("miro_get_board_items", "Get items on a Miro board. Filter by type for targeted queries.", {
  boardId: z.string().describe("Board ID"),
  type: z.string().optional().describe("Filter by item type: sticky_note, shape, text, frame, image, card, app_card, document, embed"),
  limit: z.number().optional().default(50).describe("Max results (1-50)"),
  cursor: z.string().optional().describe("Pagination cursor from previous response")
}, async ({ boardId, type, limit, cursor }) => {
  const r = await miro.getBoardItems(boardId, type, Math.min(limit, 50), cursor);
  return toolJsonResult(r);
});

// ── miro_get_item ──
server.tool("miro_get_item", "Get a single item from a board by item ID", {
  boardId: z.string().describe("Board ID"),
  itemId: z.string().describe("Item ID")
}, async ({ boardId, itemId }) => {
  const i = await miro.getItem(boardId, itemId);
  return toolJsonResult(i);
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
  return toolJsonResult(r);
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
  return toolJsonResult(r);
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
  return toolJsonResult(r);
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
  return toolJsonResult(r);
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
  return toolJsonResult(r);
});

// ── miro_create_connector ──
server.tool("miro_create_connector", "Create a connector (arrow/line) between two items on a board", {
  boardId: z.string().describe("Board ID"),
  startItemId: z.string().describe("Start item ID"),
  endItemId: z.string().describe("End item ID"),
  caption: z.string().optional().describe("Text label on the connector")
}, async ({ boardId, startItemId, endItemId, caption }) => {
  const r = await miro.createConnector(boardId, startItemId, endItemId, { caption });
  return toolJsonResult(r);
});

// ── miro_get_connectors ──
// Connectors encode what blocks what. Endpoints used to come back as bare IDs,
// so reading the graph meant enumerating every item and joining by hand; and
// when an endpoint was absent there was no way to tell an unattached connector
// from a dropped field. Both are addressed: resolveEndpoints does the join, and
// an absent endpoint now carries the reason.
server.tool("miro_get_connectors",
  "Get connectors on a board — the dependency graph. Pass resolveEndpoints=true to inline what "
  + "each endpoint actually is, instead of getting bare item IDs to join yourself.",
  {
    boardId: z.string().describe("Board ID"),
    resolveEndpoints: z.boolean().optional().default(false)
      .describe("Inline each endpoint's type and text. Costs a full board enumeration."),
    limit: z.number().optional().default(50).describe("Max connectors per call (1-50)"),
    cursor: z.string().optional().describe("Pagination cursor from a previous response"),
  },
  async ({ boardId, resolveEndpoints, limit, cursor }) => {
    const r = await miro.getConnectors(boardId, {
      limit: Math.min(limit, 50), resolveEndpoints, cursor,
    });
    return toolListResult(r.connectors, {
      isLast: r.isLast,
      total: r.total,
      itemsKey: "connectors",
      extra: {
        ...(r.cursor ? { cursor: r.cursor } : {}),
        endpointNote: "A connector with `endpointsUnavailable` is NOT necessarily unattached on the "
          + "board — read the field, which distinguishes an API serialization limit from a genuinely "
          + "missing endpoint.",
      },
    });
  });

// Pages the board server-side. The per-call cap is 50, so a 320-item board is
// seven round trips of cursor bookkeeping for the caller.
server.tool("miro_get_all_board_items",
  "Get EVERY item on a board, paging internally. Use instead of miro_get_board_items when you need "
  + "the whole board rather than one page.",
  {
    boardId: z.string().describe("Board ID"),
    type: z.string().optional()
      .describe("Optional item type filter. Note: undocumented types (table, table_text, "
        + "widgets_stack) are rejected by the API as a filter value."),
    maxPages: z.number().optional().default(40)
      .describe("Safety bound on pages fetched. If it truncates, the response says so."),
  },
  async ({ boardId, type, maxPages }) => {
    const r = await miro.getAllBoardItems(boardId, { type, maxPages });
    return toolListResult(r.items, {
      isLast: r.isLast,
      total: r.total,
      ...(r.truncated ? { truncated: r.truncated } : {}),
      extra: { pagesFetched: r.pagesFetched },
    });
  });

// ── miro_get_tags ──
server.tool("miro_get_tags", "Get all tags defined on a board", {
  boardId: z.string().describe("Board ID")
}, async ({ boardId }) => {
  const r = await miro.getTags(boardId);
  return toolJsonResult(r);
});

// ── miro_create_tag ──
server.tool("miro_create_tag", "Create a tag on a board", {
  boardId: z.string().describe("Board ID"),
  title: z.string().describe("Tag name"),
  fillColor: z.string().optional().default("yellow").describe("Tag color: red, light_green, cyan, yellow, violet, dark_green, dark_blue, blue, gray, magenta, orange, light_yellow, light_blue, light_pink, pink, black")
}, async ({ boardId, title, fillColor }) => {
  const r = await miro.createTag(boardId, title, fillColor);
  return toolJsonResult(r);
});

// ── miro_attach_tag ──
server.tool("miro_attach_tag", "Attach a tag to an item on a board", {
  boardId: z.string().describe("Board ID"),
  itemId: z.string().describe("Item ID to tag"),
  tagId: z.string().describe("Tag ID (from miro_get_tags or miro_create_tag)")
}, async ({ boardId, itemId, tagId }) => {
  const r = await miro.attachTag(boardId, itemId, tagId);
  return toolJsonResult(r);
});

// ── miro_delete_item ──
server.tool("miro_delete_item", "Delete an item from a board", {
  boardId: z.string().describe("Board ID"),
  itemId: z.string().describe("Item ID to delete")
}, async ({ boardId, itemId }) => {
  const r = await miro.deleteItem(boardId, itemId);
  return toolJsonResult(r);
});

// ── miro_get_board_members ──
server.tool("miro_get_board_members", "Get members who have access to a board", {
  boardId: z.string().describe("Board ID")
}, async ({ boardId }) => {
  const r = await miro.getBoardMembers(boardId);
  return toolJsonResult(r);
});

// ── miro_request ──
// Generic passthrough, mirroring jira_request on the atlassian bridge. The
// tools above model seventeen specific operations; anything outside that set —
// an undocumented item type, a newer or experimental endpoint — was previously
// unreachable without editing this file.
//
// Concretely: `table`, `table_text` and `widgets_stack` items enumerate on real
// boards but serialize with null content, because the API marks them
// unsupported and returns no data for them. They also cannot be used as a
// `type` filter, so they cannot be fetched selectively. This tool is the route
// to investigate such cases and to reach any endpoint added later.
server.tool("miro_request",
  "Call any Miro API path directly. Use when no purpose-built tool covers what you need — "
  + "undocumented item types, newer endpoints, or anything outside this bridge's 17 tools.",
  {
    path: z.string().describe("API path beginning with a slash, e.g. '/v2/boards/{id}/items'. "
      + "Paths outside /v2 are allowed."),
    method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).optional().default("GET"),
    queryParams: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
      .describe("Query string parameters. Numbers and booleans are accepted."),
    bodyJson: z.record(z.any()).optional().describe("JSON request body. Ignored on GET and DELETE."),
  },
  async ({ path, method, queryParams, bodyJson }) => {
    try {
      const r = await miro.rawRequest(path, { method, queryParams, bodyJson });
      return toolJsonResult(r);
    } catch (e) {
      return toolErrorResult(`${e.message}`);
    }
  });

// ── START ──
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[miro-bridge] MCP server running - " + creds.orgName + " (token from " + creds.source + ")");

