// Stateless MCP over Streamable HTTP, hand-rolled JSON-RPC.
// The official SDK transport expects Node req/res streams; on Workers a
// plain JSON response per POST is spec-compliant and is what Claude's
// custom connectors speak.

import * as store from "./db.js";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// Reusable schema fragment: the optional space selector on entry tools.
const SPACE_PROP = {
  space: {
    type: "string",
    description: "Name of the space to use. Omit for the user's default space.",
  },
};

// Resolve the space for a read tool (no auto-create — unknown name → default).
const readSpaceId = (DB, userId, args) =>
  store.resolveSpaceId(DB, userId, { spaceName: args.space });

// Injected into the agent's context at connector load — the "skill file".
// Teaches any MCP client what this journal is for and how to use it well.
const INSTRUCTIONS = `This is Lapse — the user's personal journal, a long-term record of their life, written by talking to you. Treat it as their legacy, not an app.

## Staying current (read this first)
Other agents AND the user's own devices (iPhone Shortcut, ChatGPT, the web app) write to this journal — including between your turns. Your conversation memory of "the last entry" goes stale fast. Before answering anything about recent state ("my last entry", "what did I log", "how many today", streaks), call 'get_context' and answer from that, not memory. A live snapshot is also injected below at connect time.

## When to log
Log proactively whenever the user shares something that happened, a decision, a feeling, a milestone, or says "log this". Don't ask permission for obvious logs — just log and confirm in one short line. One event = one entry; a day recap can be one entry.

## How to log
- Preserve the user's voice: log close to their own words, first person, no corporate polish.
- Set 'timestamp' to when the event actually happened (they may log yesterday's thing today).
- Put their verbatim message in 'raw_source' when paraphrasing.

## Tags & typed tags
- Tag sparingly (2-4). Reuse existing tags — check 'known_entities' / 'top_recent_tags' in context, or 'list_tags'. Don't invent near-duplicates.
- Prefer NAMESPACED tags for entities so they become graph nodes: 'person:asha', 'project:lapse', 'place:goa', 'mood:low', 'topic:stoicism'. Reuse the exact existing value ('person:asha', never a new 'person:aasha') — the 'known_entities' vocabulary in context lists what's already used.
- Mix freely: a single entry can carry plain tags ('work') and typed tags ('person:asha','mood:tired').

## Spaces
Entries live in named spaces — separate areas of the user's life (e.g. Journal, Philosophy, Career, Legacy). Every entry tool takes an optional 'space' name.
- 'list_spaces' shows what exists. Use it before assuming a space is there.
- When the user clearly means a distinct area ("log this in my career space", "add to philosophy"), pass that 'space' name. If it doesn't exist yet, 'add_entry' creates it automatically — but prefer names the user actually said; don't invent spaces or split hairs over near-duplicates.
- Omit 'space' for everyday logging — it goes to the default space, which is what the user sees on screen.
- Reads ('get_recent', 'search_entries', 'get_by_date_range', 'get_stats', etc.) are scoped to one space. Omit 'space' for the default; pass a name to look inside another. A weekly review of "my career" means passing space:"Career".
- 'create_space' and 'rename_space' let you set spaces up when the user asks. You cannot delete a space — that's done by the user in the web app.

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
        ...SPACE_PROP,
      },
      required: ["content"],
    },
    handler: async (DB, userId, args) => {
      const spaceId = await store.resolveSpaceId(DB, userId, {
        spaceName: args.space,
        autoCreate: true,
      });
      return store.addEntry(DB, userId, spaceId, { ...args, via: "mcp" });
    },
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
    description: "Most recent entries in a space, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Default 10" },
        offset: { type: "number" },
        ...SPACE_PROP,
      },
    },
    handler: async (DB, userId, args) =>
      store.getRecent(DB, userId, await readSpaceId(DB, userId, args), args.limit ?? 10, args.offset ?? 0),
  },
  {
    name: "get_by_date_range",
    description: "Entries in a space between two ISO 8601 timestamps (inclusive).",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: "ISO 8601 start" },
        end: { type: "string", description: "ISO 8601 end" },
        ...SPACE_PROP,
      },
      required: ["start", "end"],
    },
    handler: async (DB, userId, args) =>
      store.getByDateRange(DB, userId, await readSpaceId(DB, userId, args), args.start, args.end),
  },
  {
    name: "search_entries",
    description: "Full-text substring search over entry content within a space.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Default 20" },
        ...SPACE_PROP,
      },
      required: ["query"],
    },
    handler: async (DB, userId, args) =>
      store.searchEntries(DB, userId, await readSpaceId(DB, userId, args), args.query, args.limit ?? 20),
  },
  {
    name: "get_by_tag",
    description: "Entries in a space carrying a given tag, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string" },
        limit: { type: "number", description: "Default 50" },
        ...SPACE_PROP,
      },
      required: ["tag"],
    },
    handler: async (DB, userId, args) =>
      store.getByTag(DB, userId, await readSpaceId(DB, userId, args), args.tag, args.limit ?? 50),
  },
  {
    name: "get_random",
    description: "One random entry from a space — for resurfacing old memories.",
    inputSchema: { type: "object", properties: { ...SPACE_PROP } },
    handler: async (DB, userId, args) =>
      (await store.getRandom(DB, userId, await readSpaceId(DB, userId, args))) || {
        error: "no entries yet",
      },
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
    description: "All tags in a space with usage counts.",
    inputSchema: { type: "object", properties: { ...SPACE_PROP } },
    handler: async (DB, userId, args) =>
      store.listTags(DB, userId, await readSpaceId(DB, userId, args)),
  },
  {
    name: "get_stats",
    description: "Space stats: totals, first/last entry, tag count, last-7-days activity.",
    inputSchema: { type: "object", properties: { ...SPACE_PROP } },
    handler: async (DB, userId, args) =>
      store.getStats(DB, userId, await readSpaceId(DB, userId, args)),
  },
  {
    name: "get_context",
    description:
      "Current state of the journal: last entry (with which client wrote it), counts, streak, spaces, known tag vocabulary, last review. Call before answering anything about recent activity — other clients and the user's devices write here between turns, so your memory may be stale.",
    inputSchema: { type: "object", properties: {} },
    handler: (DB, userId) => store.buildContext(DB, userId),
  },
  {
    name: "list_spaces",
    description:
      "List the user's spaces (named areas that entries live in), with entry counts and which is the default.",
    inputSchema: { type: "object", properties: {} },
    handler: (DB, userId) => store.listSpaces(DB, userId),
  },
  {
    name: "create_space",
    description:
      "Create a new space. Use when the user wants a distinct area (e.g. Philosophy, Career, Legacy). Returns the existing space if the name is already taken.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Space name, e.g. 'Career'" } },
      required: ["name"],
    },
    handler: (DB, userId, { name }) => store.createSpace(DB, userId, name),
  },
  {
    name: "rename_space",
    description: "Rename a space by its id (get the id from list_spaces).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" }, name: { type: "string" } },
      required: ["id", "name"],
    },
    handler: async (DB, userId, { id, name }) =>
      (await store.renameSpace(DB, userId, id, name)) || { error: "not found" },
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

// Compact live snapshot appended to instructions at connect time.
function formatContext(c) {
  const lines = [`## Current state (as of ${c.server_time_utc} — trust this over your own memory of "recent")`];
  if (c.last_entry) {
    const e = c.last_entry;
    lines.push(`- Last entry: #${e.id} in "${e.space}" via ${e.via}, ${e.timestamp} — "${e.snippet}"`);
  } else {
    lines.push(`- Last entry: none yet`);
  }
  lines.push(
    `- Volume: ${c.entries_today} today · ${c.entries_this_week} this week · ${c.total_entries} total · streak ${c.current_streak_days}d` +
      (c.days_since_last_entry != null ? ` · ${c.days_since_last_entry}d since last` : "")
  );
  if (c.spaces.length)
    lines.push(`- Spaces: ${c.spaces.map((s) => `${s.name}(${s.entry_count})`).join(", ")}`);
  const ke = Object.entries(c.known_entities);
  if (ke.length)
    lines.push(
      `- Known entities (reuse these exact values when tagging): ` +
        ke.map(([t, vals]) => `${t}: ${vals.join(", ")}`).join(" · ")
    );
  if (c.top_recent_tags.length)
    lines.push(`- Recent tags: ${c.top_recent_tags.join(", ")}`);
  if (c.last_review_at) lines.push(`- Last review: ${c.last_review_at}`);
  lines.push(`Call 'get_context' anytime to refresh — this snapshot is only current as of connect.`);
  return lines.join("\n");
}

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
      const ctx = await store.buildContext(DB, userId).catch(() => null);
      const instructions = ctx ? `${INSTRUCTIONS}\n\n${formatContext(ctx)}` : INSTRUCTIONS;
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "lapse", version: "2.2.0" },
        instructions,
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
