const $ = (id) => document.getElementById(id);

const state = {
  mode: "login", // or "signup"
  entries: [],
  offset: 0,
  limit: 50,
  activeTag: null,
  me: null,
  freshToken: null, // MCP token, present only right after signup/rotation
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

function setAuthMode(mode) {
  state.mode = mode;
  $("auth-submit").textContent = mode === "login" ? "Log in" : "Sign up";
  $("auth-toggle-label").textContent = mode === "login" ? "No account?" : "Have an account?";
  $("auth-toggle-link").textContent = mode === "login" ? "Sign up" : "Log in";
  $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("auth-error").classList.add("hidden");
}

$("auth-toggle-link").addEventListener("click", (e) => {
  e.preventDefault();
  setAuthMode(state.mode === "login" ? "signup" : "login");
});

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = JSON.stringify({ email: $("email").value, password: $("password").value });
  try {
    const res = await api(state.mode === "login" ? "/api/login" : "/api/signup", {
      method: "POST",
      body,
    });
    if (res.mcp_token) state.freshToken = res.mcp_token; // shown once — keep for this page load
    await enterApp();
    if (state.freshToken) openSettings(); // new signup: surface the token immediately
  } catch (err) {
    const messages = {
      invalid_credentials: "Wrong email or password.",
      email_taken: "That email already has an account.",
      password_too_short: "Password needs at least 8 characters.",
      invalid_email: "That doesn't look like an email.",
      rate_limited: "Too many attempts — wait a minute, then retry.",
    };
    const el = $("auth-error");
    el.textContent = messages[err.message] || "Something went wrong. Try again.";
    el.classList.remove("hidden");
  }
});

$("logout-link").addEventListener("click", async (e) => {
  e.preventDefault();
  await api("/api/logout", { method: "POST" });
  location.reload();
});

// ---------- journal ----------

function renderEntry(entry) {
  const el = document.createElement("article");
  el.className = "entry";
  const time = document.createElement("time");
  const d = new Date(entry.timestamp);
  time.textContent = isNaN(d) ? entry.timestamp : d.toLocaleString(undefined, {
    weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  const p = document.createElement("p");
  p.textContent = entry.content;
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

function renderFeed(entries, { append = false } = {}) {
  const feed = $("feed");
  if (!append) feed.innerHTML = "";
  for (const e of entries) feed.append(renderEntry(e));
  $("empty").classList.toggle("hidden", feed.children.length > 0);
  $("load-more").classList.toggle(
    "hidden",
    entries.length < state.limit || state.activeTag || $("search").value
  );
}

async function loadEntries({ append = false } = {}) {
  const q = $("search").value.trim();
  const params = new URLSearchParams({ limit: state.limit });
  if (q) params.set("q", q);
  else if (state.activeTag) params.set("tag", state.activeTag);
  else if (append) params.set("offset", state.offset);
  const entries = await api(`/api/entries?${params}`);
  if (append) state.offset += entries.length;
  else state.offset = entries.length;
  renderFeed(entries, { append });
}

async function loadTags() {
  const tags = await api("/api/tags");
  const bar = $("tag-bar");
  bar.innerHTML = "";
  for (const { tag, count } of tags.slice(0, 20)) {
    const btn = document.createElement("button");
    btn.textContent = `${tag} ${count}`;
    btn.classList.toggle("active", state.activeTag === tag);
    btn.addEventListener("click", () => {
      state.activeTag = state.activeTag === tag ? null : tag;
      $("search").value = "";
      loadTags();
      loadEntries();
    });
    bar.append(btn);
  }
}

async function loadStats() {
  const s = await api("/api/stats");
  $("stats-line").textContent = s.total_entries
    ? `${s.total_entries} entries · ${s.entries_last_7_days} this week`
    : "";
}

let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  state.activeTag = null;
  searchTimer = setTimeout(() => {
    loadTags();
    loadEntries();
  }, 250);
});

$("load-more").addEventListener("click", () => loadEntries({ append: true }));

// ---------- settings ----------

function renderToken() {
  const el = $("mcp-token");
  if (state.freshToken) {
    el.textContent = state.freshToken;
    $("token-copy").classList.remove("hidden");
    $("token-note").textContent =
      "Copy it now — it won't be shown again after you leave this page.";
  } else {
    el.textContent = "(hidden — stored hashed)";
    $("token-copy").classList.add("hidden");
  }
}

function openSettings() {
  $("mcp-url").textContent = state.me.mcp_url;
  renderToken();
  $("settings").showModal();
}

$("settings-link").addEventListener("click", (e) => {
  e.preventDefault();
  openSettings();
});
$("settings-close").addEventListener("click", () => $("settings").close());
$("token-rotate").addEventListener("click", async () => {
  if (
    !confirm(
      "Rotate token? The old token stops working immediately — you'll need to update the connector in Claude settings."
    )
  )
    return;
  const res = await api("/api/rotate-token", { method: "POST" });
  state.freshToken = res.mcp_token;
  renderToken();
});
$("token-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.freshToken);
  $("token-copy").textContent = "copied";
  setTimeout(() => ($("token-copy").textContent = "copy"), 1200);
});

// ---------- boot ----------

async function enterApp() {
  state.me = await api("/api/me");
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  await Promise.all([loadEntries(), loadTags(), loadStats()]);
}

(async () => {
  try {
    await enterApp();
  } catch {
    showAuth();
  }
})();
