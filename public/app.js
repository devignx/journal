const $ = (id) => document.getElementById(id);

const state = {
  mode: "login", // or "signup"
  entries: [], // everything loaded so far (server order: newest first)
  offset: 0,
  limit: 50,
  activeTag: "",
  sort: "desc", // "desc" newest first | "asc" oldest first
  totalEntries: 0,
  expanded: new Set(), // date keys the user opened; newest group auto-opens
  me: null,
  freshToken: null, // MCP token, present only right after signup/rotation
  provider: "claude",
  spaces: [], // [{id,name,is_default,entry_count}]
  activeSpaceId: null,
  view: "feed", // "feed" | "all" | "graph"
  graphSpaces: null, // Set of space ids to include, or null = all
};

// Scope a read to the active space.
const withSpace = (params) => {
  if (state.activeSpaceId != null) params.set("space", state.activeSpaceId);
  return params;
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
}

// ---------- auth ----------

function showAuth() {
  $("auth").classList.remove("hidden");
  $("app").classList.add("hidden");
}

function showAuthError(text) {
  const el = $("auth-error");
  el.textContent = text;
  el.classList.remove("hidden");
}

// ---------- magic-link login (the only way in) ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

$("magic-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  if (!EMAIL_RE.test(email)) {
    showAuthError("Enter a valid email.");
    return;
  }
  $("magic-btn").disabled = true;
  try {
    await api("/api/magic/request", { method: "POST", body: JSON.stringify({ email }) });
    $("magic-email").textContent = email;
    $("magic-sent").classList.remove("hidden");
    $("auth-error").classList.add("hidden");
    $("magic-form").classList.add("hidden");
    $("auth-hint").classList.add("hidden");
  } catch (err) {
    $("magic-btn").disabled = false;
    showAuthError(
      err.message === "rate_limited"
        ? "Too many attempts — wait a minute, then retry."
        : err.message === "send_failed"
          ? "Couldn't send the email just now. Try again shortly."
          : "That doesn't look like an email."
    );
  }
});

// ---------- account dropdown ----------

const account = $("account");

$("account-trigger").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = account.classList.toggle("open");
  $("account-trigger").setAttribute("aria-expanded", open);
});
document.addEventListener("click", () => {
  account.classList.remove("open");
  $("account-trigger").setAttribute("aria-expanded", "false");
  closeSpaceMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    account.classList.remove("open");
    closeSpaceMenu();
  }
});

$("menu-settings").addEventListener("click", () => {
  account.classList.remove("open");
  openSettings();
});

$("menu-all").addEventListener("click", () => {
  account.classList.remove("open");
  setView("all");
});
$("menu-graph").addEventListener("click", () => {
  account.classList.remove("open");
  setView("graph");
});
$("menu-guide").addEventListener("click", () => {
  location.href = "/guide";
});

$("menu-logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
});

// ---------- view switching (feed / all / graph) ----------

// The space switcher returns to the single-space feed.
async function setView(view) {
  state.view = view;
  const isGraph = view === "graph";
  const isFeed = view === "feed";
  $("composer").classList.toggle("hidden", !isFeed);
  document.querySelector(".toolbar").classList.toggle("hidden", isGraph);
  $("feed").classList.toggle("hidden", isGraph);
  $("empty").classList.add("hidden");
  $("load-more").classList.toggle("hidden", isGraph);
  $("graph-view").classList.toggle("hidden", !isGraph);
  // tag filter / search only make sense in single-space feed
  $("tag-filter").classList.toggle("hidden", !isFeed);
  $("search").classList.toggle("hidden", !isFeed);
  $("sort-toggle").classList.toggle("hidden", !isFeed);

  if (isGraph) {
    await loadGraph();
  } else {
    await loadEntries();
  }
}

// ---------- entry rendering ----------

// Append text to node with bare URLs turned into safe links.
function appendLinkified(node, text) {
  const re = /https?:\/\/[^\s<>"')\]]+/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    node.append(text.slice(last, m.index));
    const a = document.createElement("a");
    a.href = m[0];
    a.textContent = m[0];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    node.append(a);
    last = m.index + m[0].length;
  }
  node.append(text.slice(last));
}

const VIA_LABEL = { mcp: "via AI", capture: "via capture" };

function renderTag(t) {
  const s = document.createElement("span");
  const i = t.indexOf(":");
  if (i > 0) {
    s.className = "tag typed";
    s.dataset.type = t.slice(0, i).toLowerCase();
    s.innerHTML = `<span class="tag-type">${esc(t.slice(0, i))}</span>${esc(t.slice(i + 1))}`;
  } else {
    s.className = "tag";
    s.textContent = t;
  }
  return s;
}

function renderTagsRow(entry) {
  const tags = document.createElement("div");
  tags.className = "entry-tags";
  for (const t of entry.tags || []) tags.append(renderTag(t));
  return tags;
}

function renderEntry(entry) {
  const el = document.createElement("article");
  el.className = "entry";
  el.dataset.id = entry.id;

  const meta = document.createElement("div");
  meta.className = "entry-meta";
  if (entry.space) {
    const sp = document.createElement("span");
    sp.className = "entry-space";
    sp.textContent = entry.space;
    meta.append(sp);
  }
  const time = document.createElement("time");
  const d = new Date(entry.timestamp);
  time.textContent = isNaN(d)
    ? entry.timestamp
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  meta.append(time);
  if (VIA_LABEL[entry.via]) {
    const via = document.createElement("span");
    via.className = "entry-via";
    via.textContent = VIA_LABEL[entry.via];
    meta.append(via);
  }
  const actions = document.createElement("div");
  actions.className = "entry-actions";
  const editBtn = document.createElement("button");
  editBtn.className = "entry-act";
  editBtn.textContent = "edit";
  editBtn.addEventListener("click", () => startEditEntry(el, entry));
  const delBtn = document.createElement("button");
  delBtn.className = "entry-act danger";
  delBtn.textContent = "delete";
  delBtn.addEventListener("click", () => deleteEntryWeb(entry));
  actions.append(editBtn, delBtn);
  meta.append(actions);

  const p = document.createElement("p");
  appendLinkified(p, entry.content);

  el.append(meta, p);
  if (entry.tags && entry.tags.length) el.append(renderTagsRow(entry));
  return el;
}

// inline editor swaps the entry's body for a textarea + tags input
function startEditEntry(el, entry) {
  el.classList.add("editing");
  el.querySelector("p")?.remove();
  el.querySelector(".entry-tags")?.remove();
  el.querySelector(".entry-actions")?.remove();

  const form = document.createElement("form");
  form.className = "entry-edit";
  form.innerHTML = `
    <textarea class="edit-content" rows="3"></textarea>
    <input class="edit-tags" type="text" placeholder="tags, comma separated (person:asha, mood:good)" />
    <div class="edit-actions">
      <button type="submit">Save</button>
      <button type="button" class="edit-cancel">Cancel</button>
    </div>`;
  form.querySelector(".edit-content").value = entry.content;
  form.querySelector(".edit-tags").value = (entry.tags || []).join(", ");
  form.querySelector(".edit-cancel").addEventListener("click", () => loadEntries());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const content = form.querySelector(".edit-content").value.trim();
    if (!content) return;
    const tags = form
      .querySelector(".edit-tags")
      .value.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    await api(`/api/entries/${entry.id}`, {
      method: "PATCH",
      body: JSON.stringify({ content, tags }),
    });
    await reloadAll();
  });
  el.append(form);
  form.querySelector(".edit-content").focus();
}

async function deleteEntryWeb(entry) {
  if (!confirm("Delete this entry? This can't be undone.")) return;
  await api(`/api/entries/${entry.id}`, { method: "DELETE" });
  await reloadAll();
}

// re-fetch everything for the current space (after any mutation)
async function reloadAll() {
  await loadSpaces();
  await Promise.all([loadStats(), loadTags()]);
  await loadEntries();
}

// ---------- date grouping ----------

function dateKey(ts) {
  const d = new Date(ts);
  return isNaN(d) ? "unknown" : d.toDateString();
}

function groupLabel(key) {
  if (key === "unknown") return "undated";
  const d = new Date(key);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "today";
  if (d.toDateString() === yesterday.toDateString()) return "yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

function renderFeed() {
  const feed = $("feed");
  feed.innerHTML = "";

  const entries =
    state.sort === "desc" ? state.entries : [...state.entries].reverse();

  // group in display order
  const groups = new Map();
  for (const e of entries) {
    const key = dateKey(e.timestamp);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  let first = true;
  for (const [key, list] of groups) {
    if (first) {
      state.expanded.add(key); // newest visible group starts open
      first = false;
    }
    const group = document.createElement("section");
    group.className = "group" + (state.expanded.has(key) ? " open" : "");

    const head = document.createElement("button");
    head.className = "group-head";
    head.setAttribute("aria-expanded", state.expanded.has(key));
    head.innerHTML = `<span class="chev">▶</span><span>${groupLabel(key)}</span><span class="n">${list.length}</span>`;
    head.addEventListener("click", () => {
      state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
      group.classList.toggle("open");
      head.setAttribute("aria-expanded", group.classList.contains("open"));
    });

    const body = document.createElement("div");
    body.className = "group-body";
    for (const e of list) body.append(renderEntry(e));

    group.append(head, body);
    feed.append(group);
  }

  $("empty").classList.toggle("hidden", state.entries.length > 0);
  let more;
  if (state.view === "all") {
    more = state.entries.length > 0 && state.entries.length % state.limit === 0;
  } else {
    const filtered = $("search").value.trim() || state.activeTag;
    more = !filtered && state.entries.length < state.totalEntries;
  }
  $("load-more").classList.toggle("hidden", !more);
  renderCount();
}

function renderCount() {
  if (state.view === "all") {
    $("entry-count").textContent = `${state.entries.length} shown · all spaces`;
    return;
  }
  const q = $("search").value.trim();
  let text;
  if (q) text = `${state.entries.length} matching “${q}”`;
  else if (state.activeTag) text = `${state.entries.length} tagged ${state.activeTag}`;
  else text = `${state.totalEntries} ${state.totalEntries === 1 ? "entry" : "entries"}`;
  $("entry-count").textContent = text;
}

// ---------- data loading ----------

async function loadEntries({ append = false } = {}) {
  let params;
  if (state.view === "all") {
    params = new URLSearchParams({ limit: state.limit, space: "all" });
    if (append) params.set("offset", state.offset);
  } else {
    const q = $("search").value.trim();
    params = withSpace(new URLSearchParams({ limit: state.limit }));
    if (q) params.set("q", q);
    else if (state.activeTag) params.set("tag", state.activeTag);
    else if (append) params.set("offset", state.offset);
  }
  const entries = await api(`/api/entries?${params}`);
  if (append) {
    state.entries = state.entries.concat(entries);
    state.offset += entries.length;
  } else {
    state.entries = entries;
    state.offset = entries.length;
    state.expanded = new Set();
  }
  renderFeed();
}

async function loadTags() {
  const tags = await api(`/api/tags?${withSpace(new URLSearchParams())}`);
  const select = $("tag-filter");
  const current = state.activeTag;
  select.innerHTML = `<option value="">all tags</option>`;
  for (const { tag, count } of tags) {
    const opt = document.createElement("option");
    opt.value = tag;
    opt.textContent = `${tag} (${count})`;
    if (tag === current) opt.selected = true;
    select.append(opt);
  }
}

async function loadStats() {
  const s = await api(`/api/stats?${withSpace(new URLSearchParams())}`);
  state.totalEntries = s.total_entries;
  renderCount();
}

// ---------- spaces ----------

function activeSpaceStorageKey() {
  return `lapse_active_space_${state.me?.email || ""}`;
}

async function loadSpaces() {
  state.spaces = await api("/api/spaces");
  const stored = Number(localStorage.getItem(activeSpaceStorageKey()));
  const exists = state.spaces.some((s) => s.id === stored);
  const fallback = (state.spaces.find((s) => s.is_default) || state.spaces[0]);
  state.activeSpaceId = exists ? stored : fallback ? fallback.id : null;
  renderSpaceSwitcher();
}

function activeSpace() {
  return state.spaces.find((s) => s.id === state.activeSpaceId);
}

function renderSpaceSwitcher() {
  const s = activeSpace();
  $("active-space-name").textContent = s ? s.name : "Journal";

  const menu = $("space-menu");
  menu.innerHTML = "";

  for (const space of state.spaces) {
    const row = document.createElement("div");
    row.className = "space-row" + (space.id === state.activeSpaceId ? " active" : "");

    const pick = document.createElement("button");
    pick.className = "space-pick";
    pick.setAttribute("role", "menuitem");
    pick.innerHTML = `<span class="space-check">${space.id === state.activeSpaceId ? "✓" : ""}</span>
      <span class="space-label">${esc(space.name)}</span>
      <span class="space-count">${space.entry_count}</span>`;
    pick.addEventListener("click", () => switchSpace(space.id));
    row.append(pick);

    if (!space.is_default) {
      const del = document.createElement("button");
      del.className = "space-del";
      del.title = "Delete space";
      del.setAttribute("aria-label", `Delete ${space.name}`);
      del.textContent = "✕";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSpace(space);
      });
      row.append(del);
    }
    menu.append(row);
  }

  const create = document.createElement("button");
  create.className = "space-create";
  create.setAttribute("role", "menuitem");
  create.innerHTML = `<span class="space-plus">+</span> New space`;
  create.addEventListener("click", startCreateSpace);
  menu.append(create);
}

function startCreateSpace() {
  const menu = $("space-menu");
  const wrap = document.createElement("form");
  wrap.className = "space-create-form";
  wrap.innerHTML = `<input type="text" placeholder="space name" maxlength="40" autocomplete="off" />`;
  const input = wrap.querySelector("input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      wrap.requestSubmit();
    }
  });
  wrap.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    try {
      const space = await api("/api/spaces", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      await loadSpaces();
      switchSpace(space.id);
    } catch (err) {
      input.value = "";
      input.placeholder = err.message === "name_taken" ? "name already used" : "couldn't create";
    }
  });
  menu.replaceChild(wrap, menu.querySelector(".space-create"));
  input.focus();
}

async function switchSpace(id) {
  state.activeSpaceId = id;
  localStorage.setItem(activeSpaceStorageKey(), String(id));
  closeSpaceMenu();
  state.activeTag = "";
  $("search").value = "";
  $("tag-filter").value = "";
  renderSpaceSwitcher();
  await Promise.all([loadStats(), loadTags()]);
  // picking a space always returns to the single-space feed
  if (state.view !== "feed") {
    await setView("feed");
  } else {
    await loadEntries();
  }
}

async function deleteSpace(space) {
  if (
    !confirm(
      `Delete “${space.name}” and its ${space.entry_count} ${
        space.entry_count === 1 ? "entry" : "entries"
      }? This can't be undone.`
    )
  )
    return;
  await api(`/api/spaces/${space.id}`, { method: "DELETE" });
  const wasActive = state.activeSpaceId === space.id;
  await loadSpaces();
  if (wasActive) {
    await switchSpace(state.activeSpaceId);
  } else {
    renderSpaceSwitcher();
  }
}

function closeSpaceMenu() {
  $("space-switcher").classList.remove("open");
  $("space-trigger").setAttribute("aria-expanded", "false");
}

$("space-trigger").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("space-switcher").classList.toggle("open");
  $("space-trigger").setAttribute("aria-expanded", open);
  if (open) renderSpaceSwitcher();
});
// Clicks inside the menu (switch, delete, create form) shouldn't reach the
// document handler that closes it — closing is done explicitly where needed.
$("space-menu").addEventListener("click", (e) => e.stopPropagation());

// ---------- toolbar ----------

let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  state.activeTag = "";
  $("tag-filter").value = "";
  searchTimer = setTimeout(() => loadEntries(), 250);
});

$("tag-filter").addEventListener("change", () => {
  state.activeTag = $("tag-filter").value;
  $("search").value = "";
  loadEntries();
});

$("sort-toggle").addEventListener("click", () => {
  state.sort = state.sort === "desc" ? "asc" : "desc";
  $("sort-toggle").textContent = state.sort === "desc" ? "newest ↓" : "oldest ↑";
  state.expanded = new Set();
  renderFeed();
});

$("load-more").addEventListener("click", () => loadEntries({ append: true }));

$("refresh-btn").addEventListener("click", async () => {
  const btn = $("refresh-btn");
  btn.classList.add("spinning");
  try {
    await reloadAll(); // keeps current space, tag, search, sort
  } finally {
    setTimeout(() => btn.classList.remove("spinning"), 500);
  }
});

// ---------- composer (web add, via "web") ----------

$("composer-input").addEventListener("focus", () =>
  $("composer-extra").classList.remove("hidden")
);
$("composer-input").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});
$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const content = $("composer-input").value.trim();
  if (!content) return;
  const tags = $("composer-tags")
    .value.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  await api(`/api/entries?${withSpace(new URLSearchParams())}`, {
    method: "POST",
    body: JSON.stringify({ content, tags }),
  });
  $("composer-input").value = "";
  $("composer-tags").value = "";
  $("composer-extra").classList.add("hidden");
  await reloadAll();
});

$("empty-connect").addEventListener("click", (e) => {
  e.preventDefault();
  openSettings();
});

// ---------- connections ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const TOKEN_PLACEHOLDER = "lapse_YOUR_TOKEN";

const PROVIDERS = [
  {
    id: "claude",
    label: "Claude",
    auth: "OAuth — no token needed",
    usesToken: false,
    render: (url) => `
      <ol class="setup-steps">
        <li>Open Claude → Settings → <strong>Connectors</strong> → <em>Add custom connector</em></li>
        <li>Paste this URL — leave client id &amp; secret <strong>empty</strong>:
          <div class="copy-row"><code>${esc(url)}</code><button data-copy="${esc(url)}">copy</button></div>
        </li>
        <li>Claude redirects here — log in to Lapse, then Authorize</li>
        <li>Done. In any chat: <em>“log this: …”</em></li>
      </ol>`,
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    auth: "OAuth — no token needed",
    usesToken: false,
    render: (url) => `
      <ol class="setup-steps">
        <li>ChatGPT → Settings → <strong>Connectors</strong> (turn on <em>Developer mode</em> if you don't see custom connectors)</li>
        <li>Create a connector → type <strong>MCP</strong> → paste this URL:
          <div class="copy-row"><code>${esc(url)}</code><button data-copy="${esc(url)}">copy</button></div>
        </li>
        <li>Auth: <strong>OAuth</strong>. ChatGPT sends you to Lapse — log in, then Authorize.</li>
        <li>Done. Enable the connector in a chat and say <em>“log this: …”</em></li>
      </ol>`,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    auth: "Bearer token",
    usesToken: true,
    render: (url, token) => {
      const cmd = `claude mcp add --transport http lapse ${url} \\\n  --scope user --header "Authorization: Bearer ${token}"`;
      return `
      <ol class="setup-steps">
        <li>Run in your terminal:
          <div class="copy-row"><pre>${esc(cmd)}</pre><button data-copy="${esc(cmd)}">copy</button></div>
        </li>
        <li>Restart Claude Code — <span class="mono">lapse_*</span> tools appear</li>
      </ol>`;
    },
  },
  {
    id: "opencode",
    label: "opencode",
    auth: "Bearer token",
    usesToken: true,
    render: (url, token) => {
      const cfg = `{\n  "mcp": {\n    "lapse": {\n      "type": "remote",\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer ${token}" },\n      "enabled": true\n    }\n  }\n}`;
      return `
      <ol class="setup-steps">
        <li>Merge into <span class="mono">~/.config/opencode/opencode.json</span>:
          <div class="copy-row"><pre>${esc(cfg)}</pre><button data-copy="${esc(cfg)}">copy</button></div>
        </li>
        <li>Restart opencode</li>
      </ol>`;
    },
  },
  {
    id: "iphone",
    label: "iPhone",
    auth: "Bearer token · quick capture",
    usesToken: true,
    render: (url, token) => {
      const captureUrl = url.replace(/\/mcp$/, "/api/capture");
      const tagPrompt =
        "Return only a CSV of two lowercase tags for the message above — nothing else. Example format: personal,reflection (change the values to fit the message).";
      return `
      <ol class="setup-steps">
        <li>New Shortcut → add <strong>Dictate Text</strong> (or bind it to the <strong>Action Button</strong>)</li>
        <li><strong>Clean up &amp; tag on-device (optional)</strong> — run the dictation through an on-device
          intelligence action (Apple Intelligence — private, no cloud) to tidy it and return tags. Feed its output to
          <span class="mono">tags</span> below. Prompt to reuse:
          <div class="copy-row"><pre>${esc(tagPrompt)}</pre><button data-copy="${esc(tagPrompt)}">copy</button></div>
        </li>
        <li>Add <strong>Get Contents of URL</strong>:
          <ul>
            <li><span class="mono">POST</span> to
              <div class="copy-row"><code>${esc(captureUrl)}</code><button data-copy="${esc(captureUrl)}">copy</button></div>
            </li>
            <li>Header <span class="mono">Authorization</span>:
              <div class="copy-row"><code>Bearer ${esc(token)}</code><button data-copy="Bearer ${esc(token)}">copy</button></div>
            </li>
            <li>Request Body <strong>JSON</strong>:
              <span class="mono">content</span> = Dictated Text ·
              <span class="mono">tags</span> = Ask Claude's output ·
              <span class="mono">space</span> = e.g. “From iPhone” (both optional)</li>
          </ul>
        </li>
        <li>Trigger from the Home Screen, Action Button, or “Hey Siri, log to Lapse”.</li>
      </ol>
      <p class="token-note">Plain capture endpoint (not MCP) — same bearer token, easiest for Shortcuts, share-sheet, or any device that can POST JSON. The Ask Claude step is optional; <span class="mono">tags</span> accepts a comma-separated string.</p>`;
    },
  },
  {
    id: "other",
    label: "Other",
    auth: "OAuth or bearer token",
    usesToken: true,
    render: (url, token) => `
      <ol class="setup-steps">
        <li>MCP endpoint (Streamable HTTP):
          <div class="copy-row"><code>${esc(url)}</code><button data-copy="${esc(url)}">copy</button></div>
        </li>
        <li>Clients with OAuth support discover it automatically — just add the URL and log in when redirected</li>
        <li>Clients without OAuth: send header
          <div class="copy-row"><code>Authorization: Bearer ${esc(token)}</code><button data-copy="Authorization: Bearer ${esc(token)}">copy</button></div>
        </li>
      </ol>`,
  },
];

function renderProviderTabs() {
  const tabs = $("provider-tabs");
  tabs.innerHTML = "";
  for (const p of PROVIDERS) {
    const btn = document.createElement("button");
    btn.textContent = p.label;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", state.provider === p.id);
    btn.addEventListener("click", () => {
      state.provider = p.id;
      renderProviderTabs();
      renderProviderPane();
    });
    tabs.append(btn);
  }
}

function renderProviderPane() {
  const p = PROVIDERS.find((x) => x.id === state.provider);
  const url = state.me.mcp_url;
  const token = state.freshToken || TOKEN_PLACEHOLDER;
  let html = `<span class="auth-badge">${esc(p.auth)}</span>` + p.render(url, token);

  if (p.usesToken) {
    html += `<div class="token-block">
      <label>Your token</label>`;
    if (state.freshToken) {
      html += `<div class="copy-row"><code>${esc(state.freshToken)}</code><button data-copy="${esc(state.freshToken)}">copy</button></div>
        <p class="token-note fresh">Copy it now — it won't be shown again after you leave this page. The snippets above already include it.</p>`;
    } else {
      html += `<p class="token-note">Tokens are stored hashed and can't be re-shown. Lost yours? Rotate — the old one stops working immediately (Claude's OAuth connection is separate and unaffected).</p>`;
    }
    html += `<div class="copy-row"><button id="token-rotate">rotate token</button></div></div>`;
  }

  $("provider-pane").innerHTML = html;

  const rotate = $("token-rotate");
  if (rotate)
    rotate.addEventListener("click", async () => {
      if (
        !confirm(
          "Rotate token? The old token stops working immediately — every client using it needs the new one."
        )
      )
        return;
      const res = await api("/api/rotate-token", { method: "POST" });
      state.freshToken = res.mcp_token;
      renderProviderPane();
    });
}

// one delegated handler for every copy button in the dialog
$("provider-pane").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  await navigator.clipboard.writeText(btn.dataset.copy);
  const original = btn.textContent;
  btn.textContent = "copied";
  setTimeout(() => (btn.textContent = original), 1200);
});

function openSettings() {
  renderProviderTabs();
  renderProviderPane();
  $("settings").showModal();
}

$("settings-close").addEventListener("click", () => $("settings").close());

// ---------- graph view (canvas force-directed tag graph) ----------

const TYPE_COLOR = {
  person: "#6ea8ff",
  project: "#b98bff",
  place: "#45d0c0",
  mood: "#f0a35e",
  topic: "#7fd97f",
};
const PLAIN_COLOR = "#8b8f9a";

const graph = {
  nodes: [],
  edges: [],
  raf: null,
  scale: 1,
  ox: 0,
  oy: 0,
  drag: null, // {node} or {pan:true, ...}
  hover: null,
  selected: null,
};

function tagColor(tag) {
  const i = tag.indexOf(":");
  return i > 0 ? TYPE_COLOR[tag.slice(0, i)] || PLAIN_COLOR : PLAIN_COLOR;
}
function tagLabel(tag) {
  const i = tag.indexOf(":");
  return i > 0 ? tag.slice(i + 1) : tag;
}

function renderGraphSpaces() {
  const bar = $("graph-spaces");
  bar.innerHTML = "";
  for (const s of state.spaces) {
    const on = state.graphSpaces === null || state.graphSpaces.has(s.id);
    const btn = document.createElement("button");
    btn.className = "gspace" + (on ? " on" : "");
    btn.textContent = s.name;
    btn.addEventListener("click", () => {
      if (state.graphSpaces === null) state.graphSpaces = new Set(state.spaces.map((x) => x.id));
      on ? state.graphSpaces.delete(s.id) : state.graphSpaces.add(s.id);
      if (state.graphSpaces.size === state.spaces.length) state.graphSpaces = null;
      const scope = state.graphSpaces === null ? "all spaces" : `${state.graphSpaces.size} space${state.graphSpaces.size === 1 ? "" : "s"}`;
      $("graph-scope").textContent = scope;
      loadGraph();
    });
    bar.append(btn);
  }
}

async function loadGraph() {
  renderGraphSpaces();
  const params = new URLSearchParams();
  if (state.graphSpaces && state.graphSpaces.size)
    params.set("spaces", [...state.graphSpaces].join(","));
  const { nodes, edges } = await api(`/api/graph?${params}`);

  $("graph-empty").classList.toggle("hidden", nodes.length > 0);

  const canvas = $("graph-canvas");
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 420;
  const maxCount = Math.max(1, ...nodes.map((n) => n.count));
  graph.nodes = nodes.map((n) => ({
    tag: n.tag,
    count: n.count,
    r: 5 + 14 * Math.sqrt(n.count / maxCount),
    x: w / 2 + (Math.random() - 0.5) * w * 0.6,
    y: h / 2 + (Math.random() - 0.5) * h * 0.6,
    vx: 0,
    vy: 0,
  }));
  const byTag = new Map(graph.nodes.map((n) => [n.tag, n]));
  graph.edges = edges
    .map((e) => ({ a: byTag.get(e.a), b: byTag.get(e.b), w: e.weight }))
    .filter((e) => e.a && e.b);
  graph.scale = 1;
  graph.ox = 0;
  graph.oy = 0;
  graph.selected = null;
  graph.ticks = 0;
  startGraphSim();
}

function startGraphSim() {
  cancelAnimationFrame(graph.raf);
  const canvas = $("graph-canvas");
  const step = () => {
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 420;
    // physics (settle then idle to save CPU)
    if (graph.ticks < 320) {
      simTick(w, h);
      graph.ticks++;
    }
    drawGraph(w, h);
    graph.raf = requestAnimationFrame(step);
  };
  step();
}

function simTick(w, h) {
  const N = graph.nodes;
  for (const n of N) {
    if (graph.drag && graph.drag.node === n) continue;
    // repulsion
    for (const m of N) {
      if (m === n) continue;
      let dx = n.x - m.x, dy = n.y - m.y;
      let d2 = dx * dx + dy * dy || 0.01;
      const f = 900 / d2;
      n.vx += dx * f;
      n.vy += dy * f;
    }
    // centering
    n.vx += (w / 2 - n.x) * 0.002;
    n.vy += (h / 2 - n.y) * 0.002;
  }
  // springs
  for (const e of graph.edges) {
    let dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
    let d = Math.hypot(dx, dy) || 0.01;
    const target = 60 + 30 / Math.sqrt(e.w);
    const f = (d - target) * 0.02;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    if (!(graph.drag && graph.drag.node === e.a)) { e.a.vx += fx; e.a.vy += fy; }
    if (!(graph.drag && graph.drag.node === e.b)) { e.b.vx -= fx; e.b.vy -= fy; }
  }
  for (const n of N) {
    if (graph.drag && graph.drag.node === n) continue;
    n.vx *= 0.85;
    n.vy *= 0.85;
    n.x += n.vx;
    n.y += n.vy;
  }
}

function drawGraph(w, h) {
  const canvas = $("graph-canvas");
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.translate(graph.ox, graph.oy);
  ctx.scale(graph.scale, graph.scale);

  const sel = graph.selected;
  const neighbors = new Set();
  if (sel) {
    neighbors.add(sel);
    for (const e of graph.edges) {
      if (e.a === sel) neighbors.add(e.b);
      if (e.b === sel) neighbors.add(e.a);
    }
  }

  // edges
  for (const e of graph.edges) {
    const active = !sel || (neighbors.has(e.a) && neighbors.has(e.b) && (e.a === sel || e.b === sel));
    ctx.strokeStyle = active ? "rgba(139,92,246,0.5)" : "rgba(138,143,154,0.12)";
    ctx.lineWidth = Math.min(3, 0.6 + e.w * 0.5);
    ctx.beginPath();
    ctx.moveTo(e.a.x, e.a.y);
    ctx.lineTo(e.b.x, e.b.y);
    ctx.stroke();
  }
  // nodes
  for (const n of graph.nodes) {
    const dim = sel && !neighbors.has(n);
    ctx.globalAlpha = dim ? 0.25 : 1;
    ctx.fillStyle = tagColor(n.tag);
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fill();
    if (n === sel) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // label for larger / selected / hovered nodes
    if (n.r > 9 || n === sel || n === graph.hover) {
      ctx.globalAlpha = dim ? 0.4 : 1;
      ctx.fillStyle = "#dde8f1";
      ctx.font = "11px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText(tagLabel(n.tag), n.x, n.y + n.r + 12);
    }
  }
  ctx.globalAlpha = 1;
}

// pointer → graph coords
function toGraph(px, py) {
  return { x: (px - graph.ox) / graph.scale, y: (py - graph.oy) / graph.scale };
}
function nodeAt(px, py) {
  const p = toGraph(px, py);
  for (let i = graph.nodes.length - 1; i >= 0; i--) {
    const n = graph.nodes[i];
    if ((n.x - p.x) ** 2 + (n.y - p.y) ** 2 <= (n.r + 4) ** 2) return n;
  }
  return null;
}

function initGraphCanvas() {
  const canvas = $("graph-canvas");
  const rectXY = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener("mousedown", (e) => {
    const [px, py] = rectXY(e);
    const n = nodeAt(px, py);
    graph.drag = n
      ? { node: n, sx: px, sy: py, moved: false }
      : { pan: true, sx: px, sy: py, ox: graph.ox, oy: graph.oy, moved: false };
  });
  window.addEventListener("mousemove", (e) => {
    if (state.view !== "graph") return;
    const [px, py] = rectXY(e);
    if (graph.drag?.node) {
      const dist = Math.hypot(px - graph.drag.sx, py - graph.drag.sy);
      if (!graph.drag.moved && dist < 4) return; // click jitter, not a drag yet
      graph.drag.moved = true;
      const p = toGraph(px, py);
      graph.drag.node.x = p.x;
      graph.drag.node.y = p.y;
      graph.drag.node.vx = graph.drag.node.vy = 0;
      graph.ticks = Math.min(graph.ticks, 200); // nudge sim awake
    } else if (graph.drag?.pan) {
      const dx = px - graph.drag.sx, dy = py - graph.drag.sy;
      if (!graph.drag.moved && Math.hypot(dx, dy) < 4) return; // ignore click jitter
      graph.drag.moved = true;
      graph.ox = graph.drag.ox + dx;
      graph.oy = graph.drag.oy + dy;
    } else {
      graph.hover = nodeAt(px, py);
      canvas.style.cursor = graph.hover ? "pointer" : "grab";
    }
  });
  window.addEventListener("mouseup", () => {
    if (!graph.drag) return;
    const d = graph.drag;
    graph.drag = null;
    if (d.moved) return; // a real drag — not a click, don't change selection
    if (d.node) {
      graph.selected = graph.selected === d.node ? null : d.node;
      updateGraphTip(graph.selected);
    } else {
      // click on empty space clears any selection
      graph.selected = null;
      updateGraphTip(null);
    }
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const [px, py] = rectXY(e);
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const p = toGraph(px, py);
      graph.scale = Math.max(0.3, Math.min(3, graph.scale * factor));
      graph.ox = px - p.x * graph.scale;
      graph.oy = py - p.y * graph.scale;
    },
    { passive: false }
  );
}

function updateGraphTip(n) {
  const tip = $("graph-tip");
  if (!n) {
    tip.classList.add("hidden");
    return;
  }
  const deg = graph.edges.filter((e) => e.a === n || e.b === n).length;
  tip.innerHTML = `<strong>${esc(n.tag)}</strong> · ${n.count} ${n.count === 1 ? "entry" : "entries"} · ${deg} link${deg === 1 ? "" : "s"}`;
  tip.classList.remove("hidden");
}

$("graph-reset").addEventListener("click", () => {
  graph.scale = 1;
  graph.ox = 0;
  graph.oy = 0;
  graph.selected = null;
  graph.ticks = 0;
  updateGraphTip(null);
});

// ---------- boot ----------

async function enterApp() {
  state.me = await api("/api/me");
  // Drop any ?auth / ?signup / ?magic param once we're in — it's stale now.
  if (location.search) history.replaceState(null, "", location.pathname);
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("avatar").textContent = state.me.email[0];
  $("account-email").textContent = state.me.email;
  initGraphCanvas();
  await loadSpaces(); // sets active space before any scoped read
  await Promise.all([loadStats(), loadTags()]);
  await loadEntries();
}

(async () => {
  try {
    await enterApp();
  } catch {
    // Not signed in. Bare "/" → send to the landing page. Only show the auth
    // form when the visitor explicitly came to log in / sign up (?auth / ?signup),
    // so the /home SIGN UP button doesn't bounce back into a redirect loop.
    const params = new URLSearchParams(location.search);
    if (params.get("magic") === "invalid") {
      showAuth();
      showAuthError("That login link expired or was already used. Request a new one.");
    } else if (params.has("auth") || params.has("signup")) {
      showAuth();
    } else {
      location.replace("/home");
    }
  }
})();
