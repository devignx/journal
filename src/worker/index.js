import * as store from "./lib/db.js";
import * as oauth from "./lib/oauth.js";
import { handleMcp } from "./lib/mcp.js";
import {
  createSessionCookieValue,
  parseSessionCookieValue,
  getCookie,
  sessionSetCookieHeader,
} from "./lib/auth.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers });
}

// True when this IP exhausted the given limiter. Fails open if the
// binding is missing (e.g. older local dev state) — auth still works.
async function ipLimited(limiter, request) {
  if (!limiter) return false;
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const { success } = await limiter.limit({ key: ip });
  return !success;
}

function rateLimitPage() {
  return new Response("Too many attempts. Wait a minute, then retry.", {
    status: 429,
    headers: { "Content-Type": "text/plain", "Retry-After": "60" },
  });
}

async function sessionUser(request, env) {
  const userId = await parseSessionCookieValue(env.SESSION_SECRET, getCookie(request, "session"));
  return userId ? store.getUserById(env.DB, userId) : null;
}

async function sessionHeaders(env, userId, url) {
  const value = await createSessionCookieValue(env.SESSION_SECRET, userId);
  return { "Set-Cookie": sessionSetCookieHeader(value, { secure: url.protocol === "https:" }) };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // ---------- OAuth (claude.ai connectors authenticate this way) ----------
    if (pathname.startsWith("/.well-known/oauth-authorization-server") && method === "GET")
      return oauth.authServerMetadata(url.origin);
    if (pathname.startsWith("/.well-known/oauth-protected-resource") && method === "GET")
      return oauth.protectedResourceMetadata(url.origin);
    if (pathname === "/register" && method === "POST") return oauth.register(request, env.DB);
    if (pathname === "/authorize" && method === "GET")
      return oauth.authorizeGet(request, env.DB, url);
    if (pathname === "/authorize" && method === "POST") {
      if (await ipLimited(env.AUTH_LIMITER, request)) return rateLimitPage();
      return oauth.authorizePost(request, env.DB);
    }
    if (pathname === "/token" && method === "POST") {
      if (await ipLimited(env.TOKEN_LIMITER, request))
        return json({ error: "rate_limited", error_description: "Too many requests" }, 429, {
          "Retry-After": "60",
        });
      return oauth.token(request, env.DB);
    }

    // ---------- MCP (bearer: OAuth access token OR personal lapse_ token) ----------
    if (pathname === "/mcp") {
      if (method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const auth = request.headers.get("Authorization") || "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      let user = null;
      if (bearer) {
        user = bearer.startsWith("jat_")
          ? await oauth.getUserByAccessToken(env.DB, bearer)
          : await store.getUserByToken(env.DB, bearer);
      }
      if (!user) {
        return json(
          {
            jsonrpc: "2.0",
            error: { code: -32001, message: "Unauthorized: invalid or missing bearer token" },
            id: null,
          },
          401,
          {
            "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
          }
        );
      }
      return handleMcp(request, env.DB, user.id);
    }

    // ---------- auth API ----------
    if (pathname === "/api/signup" && method === "POST") {
      if (await ipLimited(env.AUTH_LIMITER, request))
        return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
      const { email, password } = await request.json().catch(() => ({}));
      if (!EMAIL_RE.test(email || "")) return json({ error: "invalid_email" }, 400);
      if (!password || password.length < 8)
        return json({ error: "password_too_short", detail: "Minimum 8 characters" }, 400);
      try {
        const { user, token } = await store.createUser(env.DB, email, password);
        return json(
          { id: user.id, email: user.email, mcp_token: token }, // token shown once
          200,
          await sessionHeaders(env, user.id, url)
        );
      } catch (err) {
        if (String(err).includes("UNIQUE")) return json({ error: "email_taken" }, 409);
        throw err;
      }
    }

    if (pathname === "/api/login" && method === "POST") {
      if (await ipLimited(env.AUTH_LIMITER, request))
        return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
      const { email, password } = await request.json().catch(() => ({}));
      const user = await store.authenticate(env.DB, email || "", password || "");
      if (!user) return json({ error: "invalid_credentials" }, 401);
      return json({ id: user.id, email: user.email }, 200, await sessionHeaders(env, user.id, url));
    }

    if (pathname === "/api/logout" && method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": sessionSetCookieHeader("", { clear: true }) });
    }

    // ---------- session-authed API ----------
    if (pathname.startsWith("/api/")) {
      const user = await sessionUser(request, env);
      if (!user) return json({ error: "not_authenticated" }, 401);

      if (pathname === "/api/me" && method === "GET") {
        return json({
          email: user.email,
          mcp_url: `${url.origin}/mcp`,
          // token is hashed at rest — not retrievable; rotate to get a new one
        });
      }

      if (pathname === "/api/rotate-token" && method === "POST") {
        const token = await store.rotateToken(env.DB, user.id);
        return json({ mcp_token: token }); // shown once; old token dead
      }

      // ----- spaces -----
      if (pathname === "/api/spaces" && method === "GET") {
        return json(await store.listSpaces(env.DB, user.id));
      }
      if (pathname === "/api/spaces" && method === "POST") {
        const { name } = await request.json().catch(() => ({}));
        if (!name || !String(name).trim()) return json({ error: "name_required" }, 400);
        try {
          return json(await store.createSpace(env.DB, user.id, name));
        } catch (err) {
          if (String(err).includes("UNIQUE")) return json({ error: "name_taken" }, 409);
          throw err;
        }
      }
      const spaceMatch = pathname.match(/^\/api\/spaces\/(\d+)$/);
      if (spaceMatch) {
        const spaceId = Number(spaceMatch[1]);
        if (method === "PATCH") {
          const { name } = await request.json().catch(() => ({}));
          if (!name || !String(name).trim()) return json({ error: "name_required" }, 400);
          const renamed = await store.renameSpace(env.DB, user.id, spaceId, name);
          return renamed ? json(renamed) : json({ error: "not_found" }, 404);
        }
        if (method === "DELETE") {
          const res = await store.deleteSpace(env.DB, user.id, spaceId);
          if (res.ok) return json({ ok: true });
          return json({ error: res.reason }, res.reason === "not_found" ? 404 : 400);
        }
      }

      // Resolve the space for entry/tag/stat reads: ?space=<id>, else default.
      const spaceParam = url.searchParams.get("space");
      const spaceId = await store.resolveSpaceId(env.DB, user.id, {
        spaceId: spaceParam ? Number(spaceParam) : null,
      });

      if (pathname === "/api/entries" && method === "GET") {
        const q = url.searchParams.get("q");
        const tag = url.searchParams.get("tag");
        const start = url.searchParams.get("start");
        const end = url.searchParams.get("end");
        const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
        const offset = Number(url.searchParams.get("offset")) || 0;
        let entries;
        if (q) entries = await store.searchEntries(env.DB, user.id, spaceId, q, limit);
        else if (tag) entries = await store.getByTag(env.DB, user.id, spaceId, tag, limit);
        else if (start && end)
          entries = await store.getByDateRange(env.DB, user.id, spaceId, start, end);
        else entries = await store.getRecent(env.DB, user.id, spaceId, limit, offset);
        return json(entries);
      }

      const entryMatch = pathname.match(/^\/api\/entries\/(\d+)$/);
      if (entryMatch && method === "DELETE") {
        const deleted = await store.deleteEntry(env.DB, user.id, Number(entryMatch[1]));
        return deleted ? json({ ok: true }) : json({ error: "not_found" }, 404);
      }

      if (pathname === "/api/tags" && method === "GET") {
        return json(await store.listTags(env.DB, user.id, spaceId));
      }

      if (pathname === "/api/stats" && method === "GET") {
        return json(await store.getStats(env.DB, user.id, spaceId));
      }

      return json({ error: "not_found" }, 404);
    }

    if (pathname === "/healthz") return json({ ok: true });

    // Anything else: static assets handle it (wrangler [assets]).
    return env.ASSETS.fetch(request);
  },
};
