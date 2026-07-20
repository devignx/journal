// Stateless MCP over Streamable HTTP, hand-rolled JSON-RPC.
// The official SDK transport expects Node req/res streams; on Workers a
// plain JSON response per POST is spec-compliant and is what Claude's
// custom connectors speak.

import * as store from "./db.js";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// Injected into the agent's context at connector load — the "skill file".
// Teaches any MCP client what this journal is for and how to use it well.
const INSTRUCTIONS = `This is the user's personal journal — a long-term record of their life, written by talking to you. Treat it as their legacy, not an app.

## When to log
Log proactively whenever the user shares something that happened, a decision, a feeling, a milestone, or says "log this". Don't ask permission for obvious logs — just log and confirm in one short line. One event = one entry; a day recap can be one entry.

## How to log
- Preserve the user's voice: log close to their own words, first person, no corporate polish.
- Set 'timestamp' to when the event actually happened (they may log yesterday's thing today).
- Put their verbatim message in 'raw_source' when paraphrasing.
- Tag consistently and sparingly (2-4 lowercase tags). Check 'list_tags' occasionally and reuse existing tags instead of inventing near-duplicates.

## Making the journal useful (not just a write-only log)
- Weekly/monthly reviews: 'get_by_date_range', then reflect back patterns — themes, mood arcs, what they kept mentioning. Offer to save the reflection as an entry tagged 'review'.
- Resurfacing: 'get_random' for a "remember this?" moment. Great when the user seems nostalgic or stuck.
- Continuity: before big-picture conversations, 'get_recent' or 'search_entries' for context on what's been going on in their life.
- 'get_stats' shows streaks and volume — mention milestones (100th entry, first entry anniversary).

## Boundaries
- Never delete without explicit confirmation.
- Never editorialize their feelings in stored entries — record what they said, not your interpretation.
- The journal may hold sensitive content. Don't quote it into unrelated contexts unless the user asks.`;

const TOOLS = [
  {
    name: "add_entry",
    description:
      "Add a journal entry. Use when the user shares something worth logging: what they did, thought, felt, decided, or experienced. Preserve their voice — log close to their own words.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The entry text, in the user's voice" },
        timestamp: {
          type: "string",
          description: "ISO 8601 time the event happened (defaults to now)",
        },
        raw_source: { type: "string", description: "Verbatim user message that produced this entry" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Freeform lowercase tags, e.g. ['work','health']",
        },
      },
      required: ["content"],
    },
    handler: (DB, userId, args) => store.addEntry(DB, userId, args),
  },
  {
    name: "get_entry",
    description: "Fetch a single entry by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
    handler: async (DB, userId, { id }) =>
      (await store.getEntry(DB, userId, id)) || { error: "not found" },
  },
  {
    name: "update_entry",
    description: "Update an entry's content and/or timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        content: { type: "string" },
        timestamp: { type: "string" },
      },
      required: ["id"],
    },
    handler: async (DB, userId, { id, ...rest }) =>
      (await store.updateEntry(DB, userId, id, rest)) || { error: "not found" },
  },
  {
    name: "delete_entry",
    description: "Delete an entry permanently. Confirm with the user before calling.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
    handler: async (DB, userId, { id }) => ({ deleted: await store.deleteEntry(DB, userId, id) }),
  },
  {
    name: "get_recent",
    description: "Most recent entries, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Default 10" },
        offset: { type: "number" },
      },
    },
    handler: (DB, userId, { limit, offset }) =>
      store.getRecent(DB, userId, limit ?? 10, offset ?? 0),
  },
  {
    name: "get_by_date_range",
    description: "Entries between two ISO 8601 timestamps (inclusive).",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: "ISO 8601 start" },
        end: { type: "string", description: "ISO 8601 end" },
      },
      required: ["start", "end"],
    },
    handler: (DB, userId, { start, end }) => store.getByDateRange(DB, userId, start, end),
  },
  {
    name: "search_entries",
    description: "Full-text substring search over entry content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Default 20" },
      },
      required: ["query"],
    },
    handler: (DB, userId, { query, limit }) => store.searchEntries(DB, userId, query, limit ?? 20),
  },
  {
    name: "get_by_tag",
    description: "Entries carrying a given tag, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string" },
        limit: { type: "number", description: "Default 50" },
      },
      required: ["tag"],
    },
    handler: (DB, userId, { tag, limit }) => store.getByTag(DB, userId, tag, limit ?? 50),
  },
  {
    name: "get_random",
    description: "One random entry — for resurfacing old memories.",
    inputSchema: { type: "object", properties: {} },
    handler: async (DB, userId) => (await store.getRandom(DB, userId)) || { error: "no entries yet" },
  },
  {
    name: "add_tags",
    description: "Attach tags to an existing entry.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id", "tags"],
    },
    handler: async (DB, userId, { id, tags }) =>
      (await store.addTags(DB, userId, id, tags)) || { error: "not found" },
  },
  {
    name: "remove_tag",
    description: "Remove one tag from an entry.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" }, tag: { type: "string" } },
      required: ["id", "tag"],
    },
    handler: async (DB, userId, { id, tag }) =>
      (await store.removeTag(DB, userId, id, tag)) || { error: "not found" },
  },
  {
    name: "list_tags",
    description: "All tags with usage counts.",
    inputSchema: { type: "object", properties: {} },
    handler: (DB, userId) => store.listTags(DB, userId),
  },
  {
    name: "get_stats",
    description: "Journal stats: totals, first/last entry, tag count, last-7-days activity.",
    inputSchema: { type: "object", properties: {} },
    handler: (DB, userId) => store.getStats(DB, userId),
  },
];

// Prompt templates surfaced in the client's UI (claude.ai shows these in the
// connector menu). Each returns messages that kick off a specific ritual.
const PROMPTS = [
  {
    name: "log_today",
    description: "Quick end-of-day logging: tell me about your day, I'll journal it",
    text: "I want to log my day. Ask me 2-3 short questions to draw out what happened today (events, feelings, decisions, anything worth remembering), then save it to my journal in my own words with sensible tags. Keep it quick — this is a daily ritual, not an interview.",
  },
  {
    name: "weekly_review",
    description: "Read the last 7 days of entries and reflect back patterns",
    text: "Run my weekly review. Fetch my journal entries from the last 7 days (get_by_date_range), then reflect back: recurring themes, mood arc, things I said I'd do, anything I seemed excited or worried about. End by offering to save the reflection as an entry tagged 'review'.",
  },
  {
    name: "remember_this",
    description: "Resurface one random old entry and reflect on it",
    text: "Pull one random entry from my journal (get_random) and show it to me with its date. Then briefly reflect: what was going on then, how it might connect to now. If it sparks something, offer to log a follow-up entry linking back to it.",
  },
];

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMessage(DB, userId, msg) {
  const { id, method, params = {} } = msg;

  // Notifications (no id) get no response body.
  if (id === undefined || id === null) return null;

  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const version = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[1];
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "journal", version: "2.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "prompts/list":
      return rpcResult(id, {
        prompts: PROMPTS.map(({ name, description }) => ({ name, description })),
      });
    case "prompts/get": {
      const prompt = PROMPTS.find((p) => p.name === params.name);
      if (!prompt) return rpcError(id, -32602, `Unknown prompt: ${params.name}`);
      return rpcResult(id, {
        description: prompt.description,
        messages: [{ role: "user", content: { type: "text", text: prompt.text } }],
      });
    }
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      try {
        const data = await tool.handler(DB, userId, params.arguments || {});
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        });
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(request, DB, userId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }

  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((m) => handleMessage(DB, userId, m)))).filter(
      Boolean
    );
    if (!responses.length) return new Response(null, { status: 202 });
    return Response.json(responses);
  }

  const response = await handleMessage(DB, userId, body);
  if (!response) return new Response(null, { status: 202 });
  return Response.json(response);
}
