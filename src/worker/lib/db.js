// D1 query layer. Entries are scoped by (user_id, space_id); ownership is
// enforced here, not by FKs (D1 doesn't enforce them).

import { hashPassword, verifyPassword, sha256Hex, randomHex } from "./auth.js";

// ---------- users ----------

export async function createUser(DB, email, password) {
  const { salt, hash } = await hashPassword(password);
  const token = "lapse_" + randomHex(24);
  const tokenHash = await sha256Hex(token);
  const user = await DB.prepare(
    "INSERT INTO users (email, password_hash, password_salt, api_token_hash) VALUES (?, ?, ?, ?) RETURNING id, email, created_at"
  )
    .bind(email.toLowerCase().trim(), hash, salt, tokenHash)
    .first();
  // every user starts with one default space
  await DB.prepare(
    "INSERT INTO spaces (user_id, name, is_default) VALUES (?, 'Journal', 1)"
  )
    .bind(user.id)
    .run();
  return { user, token }; // token returned once, never stored in plaintext
}

export async function authenticate(DB, email, password) {
  const user = await DB.prepare("SELECT * FROM users WHERE email = ?")
    .bind(email.toLowerCase().trim())
    .first();
  if (!user) return null;
  const ok = await verifyPassword(password, user.password_salt, user.password_hash);
  return ok ? user : null;
}

export async function getUserById(DB, id) {
  return DB.prepare("SELECT id, email, created_at FROM users WHERE id = ?").bind(id).first();
}

export async function getUserByToken(DB, token) {
  const tokenHash = await sha256Hex(token);
  return DB.prepare("SELECT id, email FROM users WHERE api_token_hash = ?").bind(tokenHash).first();
}

export async function getUserByEmail(DB, email) {
  return DB.prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(email.toLowerCase().trim())
    .first();
}

// Magic-link login doubles as signup: unknown email → new account with a
// random (unusable) password. The user logs in only via links until they set one.
export async function findOrCreateUserByEmail(DB, email) {
  const existing = await getUserByEmail(DB, email);
  if (existing) return existing;
  const { user } = await createUser(DB, email, "unused_" + randomHex(24));
  return user;
}

// ---------- magic links ----------

export async function createMagicLink(DB, email) {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  await DB.prepare(
    "INSERT INTO magic_links (token_hash, email, expires_at) VALUES (?, ?, ?)"
  )
    .bind(tokenHash, email.toLowerCase().trim(), Date.now() + 15 * 60 * 1000)
    .run();
  await DB.prepare("DELETE FROM magic_links WHERE expires_at < ?").bind(Date.now()).run();
  return token; // plaintext, emailed once
}

// Verify + burn (single-use). Returns the email on success, else null.
export async function consumeMagicLink(DB, token) {
  const tokenHash = await sha256Hex(token);
  const row = await DB.prepare("SELECT * FROM magic_links WHERE token_hash = ?")
    .bind(tokenHash)
    .first();
  if (row) await DB.prepare("DELETE FROM magic_links WHERE token_hash = ?").bind(tokenHash).run();
  if (!row || row.used || row.expires_at < Date.now()) return null;
  return row.email;
}

export async function rotateToken(DB, userId) {
  const token = "lapse_" + randomHex(24);
  const tokenHash = await sha256Hex(token);
  await DB.prepare("UPDATE users SET api_token_hash = ? WHERE id = ?").bind(tokenHash, userId).run();
  return token; // old token dead immediately
}

// ---------- spaces ----------

export async function listSpaces(DB, userId) {
  const { results } = await DB.prepare(
    `SELECT s.id, s.name, s.is_default,
            (SELECT COUNT(*) FROM entries e WHERE e.space_id = s.id) AS entry_count
     FROM spaces s WHERE s.user_id = ?
     ORDER BY s.is_default DESC, s.name COLLATE NOCASE`
  )
    .bind(userId)
    .all();
  return results.map((s) => ({ ...s, is_default: !!s.is_default }));
}

export async function getDefaultSpaceId(DB, userId) {
  const row = await DB.prepare(
    "SELECT id FROM spaces WHERE user_id = ? AND is_default = 1 LIMIT 1"
  )
    .bind(userId)
    .first();
  return row ? row.id : null;
}

export async function getSpaceById(DB, userId, id) {
  return DB.prepare("SELECT id, name, is_default FROM spaces WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first();
}

async function getSpaceByName(DB, userId, name) {
  return DB.prepare("SELECT id, name, is_default FROM spaces WHERE user_id = ? AND name = ? COLLATE NOCASE")
    .bind(userId, String(name).trim())
    .first();
}

// Create a space, or return the existing one if the name is already taken
// (case-insensitive) — makes agent auto-create idempotent.
export async function createSpace(DB, userId, name) {
  const clean = String(name).trim();
  if (!clean) throw new Error("space name required");
  const existing = await getSpaceByName(DB, userId, clean);
  if (existing) return existing;
  return DB.prepare(
    "INSERT INTO spaces (user_id, name, is_default) VALUES (?, ?, 0) RETURNING id, name, is_default"
  )
    .bind(userId, clean)
    .first();
}

export async function renameSpace(DB, userId, id, name) {
  const space = await getSpaceById(DB, userId, id);
  if (!space) return null;
  const clean = String(name).trim();
  if (!clean) throw new Error("space name required");
  await DB.prepare("UPDATE spaces SET name = ? WHERE id = ? AND user_id = ?")
    .bind(clean, id, userId)
    .run();
  return getSpaceById(DB, userId, id);
}

// Deletes the space and everything in it. Refuses the default/last space.
export async function deleteSpace(DB, userId, id) {
  const space = await getSpaceById(DB, userId, id);
  if (!space) return { ok: false, reason: "not_found" };
  if (space.is_default) return { ok: false, reason: "is_default" };
  await DB.batch([
    DB.prepare(
      "DELETE FROM tags WHERE entry_id IN (SELECT id FROM entries WHERE space_id = ? AND user_id = ?)"
    ).bind(id, userId),
    DB.prepare("DELETE FROM entries WHERE space_id = ? AND user_id = ?").bind(id, userId),
    DB.prepare("DELETE FROM spaces WHERE id = ? AND user_id = ?").bind(id, userId),
  ]);
  return { ok: true };
}

// Resolve a space for a request. spaceId wins; else spaceName (optionally
// auto-created); else the user's default space. Always returns a valid id.
export async function resolveSpaceId(DB, userId, { spaceId, spaceName, autoCreate = false } = {}) {
  if (spaceId != null) {
    const s = await getSpaceById(DB, userId, spaceId);
    if (s) return s.id;
  }
  if (spaceName) {
    const s = await getSpaceByName(DB, userId, spaceName);
    if (s) return s.id;
    if (autoCreate) return (await createSpace(DB, userId, spaceName)).id;
  }
  return getDefaultSpaceId(DB, userId);
}

// ---------- entries ----------

async function attachTags(DB, entry) {
  if (!entry) return entry;
  const { results } = await DB.prepare("SELECT tag FROM tags WHERE entry_id = ? ORDER BY tag")
    .bind(entry.id)
    .all();
  entry.tags = results.map((r) => r.tag);
  return entry;
}

async function attachTagsAll(DB, entries) {
  return Promise.all(entries.map((e) => attachTags(DB, e)));
}

// One tag = one word. Malformed input is accepted and cleaned here:
// plain multi-word tags split into separate words; typed tags (type:value)
// stay one node with spaces hyphenated so "person:john doe" doesn't fracture.
function normalizeTags(tags) {
  const out = [];
  for (let raw of tags || []) {
    raw = String(raw).trim().toLowerCase();
    if (!raw) continue;
    const i = raw.indexOf(":");
    if (i > 0) {
      const type = raw.slice(0, i).trim().replace(/\s+/g, "-");
      const val = raw.slice(i + 1).trim().replace(/\s+/g, "-");
      if (type && val) out.push(`${type}:${val}`);
    } else {
      for (const w of raw.split(/[\s,]+/)) if (w) out.push(w);
    }
  }
  return [...new Set(out)];
}

export async function addEntry(DB, userId, spaceId, { content, timestamp, raw_source, tags, via }) {
  const ts = timestamp || new Date().toISOString();
  const row = await DB.prepare(
    "INSERT INTO entries (user_id, space_id, content, timestamp, raw_source, via) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(userId, spaceId, content, ts, raw_source || null, via || "unknown")
    .first();
  const clean = normalizeTags(tags);
  if (clean.length) {
    await DB.batch(
      clean.map((tag) =>
        DB.prepare("INSERT OR IGNORE INTO tags (entry_id, tag) VALUES (?, ?)").bind(row.id, tag)
      )
    );
  }
  return getEntry(DB, userId, row.id);
}

// Single-entry ops key off (id, user_id) — ownership is enough, space irrelevant.
export async function getEntry(DB, userId, id) {
  const entry = await DB.prepare("SELECT * FROM entries WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first();
  return attachTags(DB, entry);
}

export async function updateEntry(DB, userId, id, { content, timestamp, tags }) {
  const existing = await getEntry(DB, userId, id);
  if (!existing) return null;
  await DB.prepare(
    "UPDATE entries SET content = ?, timestamp = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ?"
  )
    .bind(content ?? existing.content, timestamp ?? existing.timestamp, id, userId)
    .run();
  // When tags is provided (web edit), replace the whole set.
  if (Array.isArray(tags)) {
    await DB.prepare("DELETE FROM tags WHERE entry_id = ?").bind(id).run();
    const clean = normalizeTags(tags);
    if (clean.length) {
      await DB.batch(
        clean.map((t) =>
          DB.prepare("INSERT OR IGNORE INTO tags (entry_id, tag) VALUES (?, ?)").bind(id, t)
        )
      );
    }
  }
  return getEntry(DB, userId, id);
}

export async function deleteEntry(DB, userId, id) {
  const owned = await DB.prepare("SELECT id FROM entries WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first();
  if (!owned) return false;
  await DB.batch([
    DB.prepare("DELETE FROM tags WHERE entry_id = ?").bind(id),
    DB.prepare("DELETE FROM entries WHERE id = ?").bind(id),
  ]);
  return true;
}

// Multi-entry reads are scoped to one space.
export async function getRecent(DB, userId, spaceId, limit = 10, offset = 0) {
  const { results } = await DB.prepare(
    "SELECT * FROM entries WHERE user_id = ? AND space_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?"
  )
    .bind(userId, spaceId, limit, offset)
    .all();
  return attachTagsAll(DB, results);
}

// All entries across every space, newest first, each carrying its space name.
export async function getRecentAll(DB, userId, limit = 50, offset = 0) {
  const { results } = await DB.prepare(
    `SELECT e.*, s.name AS space FROM entries e JOIN spaces s ON s.id = e.space_id
     WHERE e.user_id = ? ORDER BY e.timestamp DESC LIMIT ? OFFSET ?`
  )
    .bind(userId, limit, offset)
    .all();
  return attachTagsAll(DB, results);
}

export async function getByDateRange(DB, userId, spaceId, start, end) {
  const { results } = await DB.prepare(
    "SELECT * FROM entries WHERE user_id = ? AND space_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC"
  )
    .bind(userId, spaceId, start, end)
    .all();
  return attachTagsAll(DB, results);
}

export async function searchEntries(DB, userId, spaceId, query, limit = 20) {
  const { results } = await DB.prepare(
    "SELECT * FROM entries WHERE user_id = ? AND space_id = ? AND content LIKE ? ORDER BY timestamp DESC LIMIT ?"
  )
    .bind(userId, spaceId, `%${query}%`, limit)
    .all();
  return attachTagsAll(DB, results);
}

export async function getByTag(DB, userId, spaceId, tag, limit = 50) {
  const { results } = await DB.prepare(
    `SELECT e.* FROM entries e
     JOIN tags t ON t.entry_id = e.id
     WHERE e.user_id = ? AND e.space_id = ? AND t.tag = ?
     ORDER BY e.timestamp DESC LIMIT ?`
  )
    .bind(userId, spaceId, String(tag).trim().toLowerCase(), limit)
    .all();
  return attachTagsAll(DB, results);
}

export async function getRandom(DB, userId, spaceId) {
  const entry = await DB.prepare(
    "SELECT * FROM entries WHERE user_id = ? AND space_id = ? ORDER BY RANDOM() LIMIT 1"
  )
    .bind(userId, spaceId)
    .first();
  return attachTags(DB, entry);
}

export async function addTags(DB, userId, entryId, tags) {
  const entry = await getEntry(DB, userId, entryId);
  if (!entry) return null;
  const clean = normalizeTags(tags);
  if (clean.length) {
    await DB.batch(
      clean.map((tag) =>
        DB.prepare("INSERT OR IGNORE INTO tags (entry_id, tag) VALUES (?, ?)").bind(entryId, tag)
      )
    );
  }
  return getEntry(DB, userId, entryId);
}

export async function removeTag(DB, userId, entryId, tag) {
  const entry = await getEntry(DB, userId, entryId);
  if (!entry) return null;
  await DB.prepare("DELETE FROM tags WHERE entry_id = ? AND tag = ?")
    .bind(entryId, String(tag).trim().toLowerCase())
    .run();
  return getEntry(DB, userId, entryId);
}

export async function listTags(DB, userId, spaceId) {
  const { results } = await DB.prepare(
    `SELECT t.tag, COUNT(*) AS count FROM tags t
     JOIN entries e ON e.id = t.entry_id
     WHERE e.user_id = ? AND e.space_id = ?
     GROUP BY t.tag ORDER BY count DESC, t.tag`
  )
    .bind(userId, spaceId)
    .all();
  return results;
}

// ---------- ambient context (for MCP initialize + get_context) ----------

// A small, non-critical situational snapshot so agents don't answer from stale
// conversation memory when other clients/devices have written since.
export async function buildContext(DB, userId) {
  const snippet = (s, n = 140) => (s && s.length > n ? s.slice(0, n) + "…" : s);

  const last = await DB.prepare(
    `SELECT e.id, e.content, e.timestamp, e.via, s.name AS space
     FROM entries e JOIN spaces s ON s.id = e.space_id
     WHERE e.user_id = ? ORDER BY e.timestamp DESC LIMIT 1`
  )
    .bind(userId)
    .first();

  const counts = await DB.prepare(
    `SELECT
       SUM(CASE WHEN timestamp >= date('now') THEN 1 ELSE 0 END) AS today,
       SUM(CASE WHEN timestamp >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS week,
       COUNT(*) AS total
     FROM entries WHERE user_id = ?`
  )
    .bind(userId)
    .first();

  // distinct entry days (last 60) → current streak
  const { results: days } = await DB.prepare(
    `SELECT DISTINCT date(timestamp) AS d FROM entries
     WHERE user_id = ? AND timestamp >= datetime('now','-60 days')
     ORDER BY d DESC`
  )
    .bind(userId)
    .all();
  let streak = 0;
  if (days.length) {
    const dayMs = 86400000;
    const today = new Date(new Date().toISOString().slice(0, 10)).getTime();
    let cursor = today;
    const set = new Set(days.map((r) => r.d));
    // allow streak to count if the most recent day is today or yesterday
    if (!set.has(new Date(today).toISOString().slice(0, 10))) cursor = today - dayMs;
    while (set.has(new Date(cursor).toISOString().slice(0, 10))) {
      streak++;
      cursor -= dayMs;
    }
  }
  const daysSince = last
    ? Math.floor((Date.now() - new Date(last.timestamp).getTime()) / 86400000)
    : null;

  const spaces = await DB.prepare(
    `SELECT s.name, s.is_default,
            (SELECT COUNT(*) FROM entries e WHERE e.space_id = s.id) AS entry_count,
            (SELECT MAX(e.timestamp) FROM entries e WHERE e.space_id = s.id) AS last_entry_at
     FROM spaces s WHERE s.user_id = ? ORDER BY s.is_default DESC, s.name COLLATE NOCASE`
  )
    .bind(userId)
    .all();

  // namespaced tags → known entities vocabulary
  const { results: typed } = await DB.prepare(
    `SELECT DISTINCT t.tag FROM tags t JOIN entries e ON e.id = t.entry_id
     WHERE e.user_id = ? AND t.tag LIKE '%:%'`
  )
    .bind(userId)
    .all();
  const known_entities = {};
  for (const { tag } of typed) {
    const i = tag.indexOf(":");
    const type = tag.slice(0, i);
    const val = tag.slice(i + 1);
    (known_entities[type] ||= []).push(val);
  }

  const { results: recentTags } = await DB.prepare(
    `SELECT t.tag, COUNT(*) AS c FROM tags t JOIN entries e ON e.id = t.entry_id
     WHERE e.user_id = ? AND e.timestamp >= datetime('now','-30 days')
     GROUP BY t.tag ORDER BY c DESC, t.tag LIMIT 15`
  )
    .bind(userId)
    .all();

  const review = await DB.prepare(
    `SELECT MAX(e.timestamp) AS ts FROM entries e JOIN tags t ON t.entry_id = e.id
     WHERE e.user_id = ? AND t.tag = 'review'`
  )
    .bind(userId)
    .first();

  return {
    server_time_utc: new Date().toISOString(),
    total_entries: counts.total || 0,
    entries_today: counts.today || 0,
    entries_this_week: counts.week || 0,
    current_streak_days: streak,
    days_since_last_entry: daysSince,
    last_entry: last
      ? { id: last.id, snippet: snippet(last.content), timestamp: last.timestamp, space: last.space, via: last.via }
      : null,
    spaces: spaces.results.map((s) => ({
      name: s.name,
      entry_count: s.entry_count,
      last_entry_at: s.last_entry_at,
    })),
    known_entities,
    top_recent_tags: recentTags.map((r) => r.tag),
    last_review_at: review.ts || null,
  };
}

// ---------- graph (tag co-occurrence) ----------

// spaceIds: array of ids to include, or null for all the user's spaces.
export async function getGraph(DB, userId, spaceIds) {
  const useFilter = Array.isArray(spaceIds) && spaceIds.length > 0;
  const inClause = useFilter ? `AND e.space_id IN (${spaceIds.map(() => "?").join(",")})` : "";
  const args = useFilter ? [userId, ...spaceIds] : [userId];

  const { results: nodes } = await DB.prepare(
    `SELECT t.tag, COUNT(*) AS count FROM tags t JOIN entries e ON e.id = t.entry_id
     WHERE e.user_id = ? ${inClause}
     GROUP BY t.tag ORDER BY count DESC`
  )
    .bind(...args)
    .all();

  const { results: edges } = await DB.prepare(
    `SELECT t1.tag AS a, t2.tag AS b, COUNT(*) AS weight
     FROM tags t1
     JOIN tags t2 ON t1.entry_id = t2.entry_id AND t1.tag < t2.tag
     JOIN entries e ON e.id = t1.entry_id
     WHERE e.user_id = ? ${inClause}
     GROUP BY t1.tag, t2.tag`
  )
    .bind(...args)
    .all();

  return { nodes, edges };
}

export async function getStats(DB, userId, spaceId) {
  const agg = await DB.prepare(
    `SELECT COUNT(*) AS total, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts,
            SUM(CASE WHEN timestamp >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS last7
     FROM entries WHERE user_id = ? AND space_id = ?`
  )
    .bind(userId, spaceId)
    .first();
  const tagCount = await DB.prepare(
    "SELECT COUNT(DISTINCT t.tag) AS n FROM tags t JOIN entries e ON e.id = t.entry_id WHERE e.user_id = ? AND e.space_id = ?"
  )
    .bind(userId, spaceId)
    .first();
  return {
    total_entries: agg.total,
    first_entry: agg.first_ts,
    last_entry: agg.last_ts,
    distinct_tags: tagCount.n,
    entries_last_7_days: agg.last7 || 0,
  };
}
