// One Worker, two jobs.
//
// 1. Every 5 minutes, start the subway-wait GitHub Actions workflow (unchanged).
//    Needs one secret, GH_TOKEN (fine-grained token: this repo only, Actions: read & write).
// 2. Answer GET /writing with the latest article from a feed, for the "My Latest Writing" card on the website.
//    Browsers can't read Substack directly (CORS), so the website asks this Worker instead.
//    The answer is kept for about 15 minutes, and if the feed is briefly down the last good answer is served.
//
// To list writing from another place later, add one line to SOURCES below, then use /writing?source=<name>.
import { parseFeed, decodeEntities } from "./feed.js";
import { updateSongs, songsResponse, seedHandler, statusResponse } from "./songs.js";

const SOURCES = {
  substack: { url: "https://mpg603.substack.com/feed", home: "https://mpg603.substack.com" },
};
const DEFAULT_SOURCE = "substack";

const FRESH_SECONDS = 15 * 60;            // how long an answer is reused without asking the feed again
const STALE_SECONDS = 30 * 24 * 60 * 60;  // how long the last good answer is kept in case the feed is down
const BROWSER_SECONDS = 5 * 60;           // how long a visitor's browser may reuse an answer
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_FEED_BYTES = 3 * 1024 * 1024;

// Only these websites may read the answer from a browser.
const ALLOWED_ORIGINS = ["https://miguelpg.org", "https://www.miguelpg.org", "https://mpg603.github.io"];
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dispatch(env));
    // First Spin: refresh the song lists (does nothing until the storage and secrets are set up)
    ctx.waitUntil(updateSongs(env).then((r) => console.log("songs", JSON.stringify(r))).catch((e) => console.log("songs failed", String(e))));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/writing") return writing(request, ctx, url);
    if (url.pathname === "/songs") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
      return songsResponse(env, json, request);
    }
    if (url.pathname === "/seed") return seedHandler(request, env, json);
    if (url.pathname === "/songs-status") return statusResponse(env);
    return new Response("subway-trigger is running", { status: 200 });
  },
};

async function dispatch(env) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "subway-update",
    },
    body: JSON.stringify({ ref: env.GH_REF }),
  });
  if (res.status !== 204) console.log("dispatch failed", res.status, await res.text());
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const h = { Vary: "Origin" };
  if (origin && (ALLOWED_ORIGINS.includes(origin) || LOCAL_ORIGIN.test(origin))) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, OPTIONS";
  }
  return h;
}

function json(request, body, status, cacheSeconds) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheSeconds ? `public, max-age=${cacheSeconds}` : "no-store",
      ...corsHeaders(request),
    },
  });
}

async function writing(request, ctx, url) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== "GET" && request.method !== "HEAD") return json(request, { ok: false, error: "method" }, 405, 0);

  const name = url.searchParams.get("source") || DEFAULT_SOURCE;
  const source = Object.hasOwn(SOURCES, name) ? SOURCES[name] : null;
  if (!source) return json(request, { ok: false, error: "unknown source" }, 404, 0);

  const cache = caches.default;
  const freshKey = new Request(`https://writing-cache.internal/${name}/fresh`);
  const staleKey = new Request(`https://writing-cache.internal/${name}/stale`);

  const hit = await cache.match(freshKey);
  if (hit) return json(request, await hit.json(), 200, BROWSER_SECONDS);

  try {
    const res = await fetch(source.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; miguelpg-writing/1.0; +https://miguelpg.org)",
        Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error("feed returned " + res.status);
    const len = Number(res.headers.get("Content-Length") || 0);
    if (len > MAX_FEED_BYTES) throw new Error("feed too large");
    const xml = await res.text();
    if (xml.length > MAX_FEED_BYTES) throw new Error("feed too large");

    const parsed = parseFeed(xml);
    // no picture in the feed: read the article page's own preview image (og:image), which every Substack post sets
    if (!parsed.item.image) {
      try {
        const pr = await fetch(parsed.item.link, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; miguelpg-writing/1.0; +https://miguelpg.org)", Accept: "text/html" },
          signal: AbortSignal.timeout(6000),
        });
        if (pr.ok) {
          const head = (await pr.text()).slice(0, 200000);
          const tag = /<meta\b[^>]*\bproperty\s*=\s*["']og:image["'][^>]*>/i.exec(head) || /<meta\b[^>]*\bname\s*=\s*["']twitter:image["'][^>]*>/i.exec(head);
          const m = tag && /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag[0]);
          const u = m ? decodeEntities(m[1]).trim() : "";
          if (/^https:\/\//i.test(u)) parsed.item.image = u;
        }
      } catch (e) { /* the card simply shows without a picture */ }
    }
    const body = {
      ok: true,
      source: name,
      site: { title: parsed.site.title, link: parsed.site.link || source.home },
      item: parsed.item,
      fetchedAt: new Date().toISOString(),
    };
    const store = (key, seconds) =>
      cache.put(key, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${seconds}` } }));
    ctx.waitUntil(Promise.all([store(freshKey, FRESH_SECONDS), store(staleKey, STALE_SECONDS)]));
    return json(request, body, 200, BROWSER_SECONDS);
  } catch (err) {
    console.log("writing feed failed", name, String(err));
    // The feed is down or changed: serve the last good answer if there is one, and let the browser ask again soon.
    const old = await cache.match(staleKey);
    if (old) return json(request, { ...(await old.json()), stale: true }, 200, 60);
    return json(request, { ok: false, error: "feed unavailable", site: { link: source.home } }, 502, 0);
  }
}
