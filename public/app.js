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

$("menu-logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
});

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

function renderEntry(entry) {
  const el = document.createElement("article");
  el.className = "entry";
  const time = document.createElement("time");
  const d = new Date(entry.timestamp);
  time.textContent = isNaN(d)
    ? entry.timestamp
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const p = document.createElement("p");
  appendLinkified(p, entry.content);
  el.append(time, p);
  if (entry.tags && entry.tags.length) {
    const tags = document.createElement("div");
    tags.className = "entry-tags";
    for (const t of entry.tags) {
      const s = document.createElement("span");
      s.textContent = t;
      tags.append(s);
    }
    el.append(tags);
  }
  return el;
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
  const filtered = $("search").value.trim() || state.activeTag;
  $("load-more").classList.toggle(
    "hidden",
    filtered || state.entries.length >= state.totalEntries
  );
  renderCount();
}

function renderCount() {
  const q = $("search").value.trim();
  let text;
  if (q) text = `${state.entries.length} matching “${q}”`;
  else if (state.activeTag) text = `${state.entries.length} tagged ${state.activeTag}`;
  else text = `${state.totalEntries} ${state.totalEntries === 1 ? "entry" : "entries"}`;
  $("entry-count").textContent = text;
}

// ---------- data loading ----------

async function loadEntries({ append = false } = {}) {
  const q = $("search").value.trim();
  const params = withSpace(new URLSearchParams({ limit: state.limit }));
  if (q) params.set("q", q);
  else if (state.activeTag) params.set("tag", state.activeTag);
  else if (append) params.set("offset", state.offset);
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
  await loadEntries();
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
    await loadSpaces(); // refresh space list + entry counts
    await Promise.all([loadStats(), loadTags()]);
    await loadEntries(); // keeps current space, tag, search, sort
  } finally {
    setTimeout(() => btn.classList.remove("spinning"), 500);
  }
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
      return `
      <ol class="setup-steps">
        <li>New Shortcut → add <strong>Dictate Text</strong> (or Ask for Input / Text)</li>
        <li>Add <strong>Get Contents of URL</strong>, set:
          <ul>
            <li>URL — <span class="mono">POST</span> to
              <div class="copy-row"><code>${esc(captureUrl)}</code><button data-copy="${esc(captureUrl)}">copy</button></div>
            </li>
            <li>Header <span class="mono">Authorization</span>:
              <div class="copy-row"><code>Bearer ${esc(token)}</code><button data-copy="Bearer ${esc(token)}">copy</button></div>
            </li>
            <li>Request Body <strong>JSON</strong>: <span class="mono">content</span> = the dictated text (optional <span class="mono">space</span>, <span class="mono">tags</span>)</li>
          </ul>
        </li>
        <li>Trigger from the Home Screen, Action Button, or “Hey Siri, log to Lapse”.</li>
      </ol>
      <p class="token-note">Uses the plain capture endpoint (not MCP) — same bearer token, easiest for Shortcuts, share-sheet, or any device that can POST JSON.</p>`;
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

// ---------- boot ----------

async function enterApp() {
  state.me = await api("/api/me");
  // Drop any ?auth / ?signup / ?magic param once we're in — it's stale now.
  if (location.search) history.replaceState(null, "", location.pathname);
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("avatar").textContent = state.me.email[0];
  $("account-email").textContent = state.me.email;
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
