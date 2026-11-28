// First Spin: keeps the three song lists up to date.
//
// Every 5 minutes it asks Last.fm for scrobbles newer than the last one it saw, counts them against a private
// memory of every song heard before, and adds a song to a list the moment it reaches its milestone:
//   discovered  = first ever play
//   returned    = second play, on a later day than the first
//   ten         = tenth play
// The memory lives in the Worker's private KV store as hashed fingerprints, never in the repo or on the website.
// The website only ever receives the 3 x 12 songs in "out".
//
// Secrets and bindings it needs: SONGS (KV namespace), LASTFM_KEY, LASTFM_USER, SEED_TOKEN.
const N = 12;
const TZ = "America/New_York";
const PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f"; // Last.fm's grey "no cover" star
const MAX_PAGES = 4;                                       // 800 new scrobbles per run is far more than 5 minutes needs

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const dayOf = (u) => dayFmt.format(new Date(u * 1000));
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

export async function fingerprint(salt, artist, title) {
  const bytes = new TextEncoder().encode(salt + "|" + norm(artist) + "|" + norm(title));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 6);
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cover(track) {
  const img = (track.image || []).find((i) => i.size === "large" && i["#text"] && !i["#text"].includes(PLACEHOLDER));
  return img ? img["#text"] : undefined;
}

async function recentSince(env, cursor) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      "https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&format=json&limit=200" +
      `&user=${encodeURIComponent(env.LASTFM_USER)}&api_key=${encodeURIComponent(env.LASTFM_KEY)}&from=${cursor}&page=${page}`;
    const res = await fetch(url, { headers: { "User-Agent": "first-spin/1.0" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error("lastfm " + res.status);
    const j = await res.json();
    if (j.error) throw new Error("lastfm error " + j.error);
    const rt = j.recenttracks || {};
    const tracks = Array.isArray(rt.track) ? rt.track : rt.track ? [rt.track] : [];
    for (const t of tracks) {
      if (t["@attr"] && t["@attr"].nowplaying) continue; // still playing: no timestamp yet, picked up next time
      if (!t.date || !t.date.uts) continue;
      const uts = Number(t.date.uts);
      if (uts > cursor) out.push({ uts, title: t.name, artist: (t.artist && t.artist["#text"]) || "", album: (t.album && t.album["#text"]) || "", art: cover(t) });
    }
    const total = Number((rt["@attr"] && rt["@attr"].totalPages) || 1);
    if (page >= total) break;
  }
  return out.sort((a, b) => a.uts - b.uts);
}

async function setStatus(env, obj) {
  try { await env.SONGS.put("status", JSON.stringify({ at: Math.floor(Date.now() / 1000), ...obj })); } catch (e) { /* the status page is a convenience only */ }
}

export async function updateSongs(env) {
  if (!env.SONGS) return { skipped: "no storage bound (SONGS)" };
  let result;
  try { result = await runUpdate(env); }
  catch (err) { await setStatus(env, { error: String(err).slice(0, 200) }); throw err; }
  await setStatus(env, result);
  return result;
}

async function runUpdate(env) {
  const missing = ["LASTFM_KEY", "LASTFM_USER"].filter((k) => !env[k]);
  if (missing.length) return { skipped: "missing setting: " + missing.join(", ") };
  const [cursorRaw, salt, outRaw] = await Promise.all([env.SONGS.get("cursor"), env.SONGS.get("salt"), env.SONGS.get("out")]);
  if (!cursorRaw || !salt || !outRaw) return { skipped: "not seeded yet" };
  const cursor = Number(cursorRaw);
  const out = JSON.parse(outRaw);

  const fresh = await recentSince(env, cursor);
  if (!fresh.length) return { added: 0 };

  const shards = new Map(), dirty = new Set();
  const load = async (name) => {
    if (!shards.has(name)) shards.set(name, (await env.SONGS.get("s:" + name, "json")) || {});
    return shards.get(name);
  };
  let newSongs = 0;
  for (const t of fresh) {
    const h = await fingerprint(salt, t.artist, t.title);
    const shard = await load(h.slice(0, 2));
    const id = h.slice(2);
    const e = shard[id] || [0, 0, 0, 0]; // [plays, first, second, tenth]
    e[0] += 1;
    let list = null;
    if (e[0] === 1) { e[1] = t.uts; list = "discovered"; newSongs++; }
    else if (e[0] === 2) { e[2] = t.uts; if (dayOf(t.uts) > dayOf(e[1])) list = "returned"; }
    else if (e[0] === 10) { e[3] = t.uts; list = "ten"; }
    shard[id] = e;
    dirty.add(h.slice(0, 2));
    if (list) {
      const item = { title: t.title, artist: t.artist, album: t.album, when: t.uts, plays: e[0] };
      if (t.art) item.art = t.art;
      out[list] = [item, ...(out[list] || [])].slice(0, N);
    }
  }
  const last = fresh[fresh.length - 1].uts;
  out.totals = { ...(out.totals || {}), scrobbles: ((out.totals && out.totals.scrobbles) || 0) + fresh.length, songs: ((out.totals && out.totals.songs) || 0) + newSongs, to: last };

  // memory first, then the lists, then the bookmark: if anything fails midway the next run simply redoes it
  await Promise.all([...dirty].map((name) => env.SONGS.put("s:" + name, JSON.stringify(shards.get(name)))));
  await env.SONGS.put("out", JSON.stringify(out));
  await env.SONGS.put("cursor", String(last));
  return { added: fresh.length, newSongs };
}

// ---- web side ----
export async function statusResponse(env) {
  const raw = env.SONGS ? await env.SONGS.get("status") : null;
  const cursor = env.SONGS ? await env.SONGS.get("cursor") : null;
  const body = raw ? JSON.parse(raw) : { note: "The updater has not run yet (it runs every 5 minutes)." };
  if (body.at) body.ranAt = new Date(body.at * 1000).toISOString();
  if (cursor) body.lastScrobbleSeen = new Date(Number(cursor) * 1000).toISOString();
  body.hasStorage = !!env.SONGS; body.hasKey = !!env.LASTFM_KEY; body.hasUser = !!env.LASTFM_USER; body.hasSeedToken = !!env.SEED_TOKEN;
  return new Response(JSON.stringify(body, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

export async function songsResponse(env, json, request) {
  const raw = env.SONGS ? await env.SONGS.get("out") : null;
  if (!raw) return json(request, { ok: false, error: "not ready" }, 404, 0);
  return json(request, { ok: true, ...JSON.parse(raw) }, 200, 60);
}

const SEED_PAGE = `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>First Spin setup</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px">
<h1>First Spin setup</h1>
<p>One-time upload of the private starting file. It goes only to this Worker.</p>
<p><label>Password (SEED_TOKEN)<br><input id="t" type="password" style="width:100%;padding:8px"></label></p>
<p><label>Seed file<br><input id="f" type="file" accept=".json"></label></p>
<p><button id="go" style="padding:10px 18px;font-size:16px">Upload</button></p>
<pre id="log" style="white-space:pre-wrap"></pre>
<script>
const log=m=>document.getElementById('log').textContent=m;
async function post(token,body){
  const r=await fetch('/seed',{method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok)throw new Error('The Worker answered '+r.status+': '+await r.text());
}
document.getElementById('go').onclick=async()=>{
  try{
    const token=document.getElementById('t').value.trim(),file=document.getElementById('f').files[0];
    if(!token||!file){log('Enter the password and choose the file.');return}
    log('Reading the file…');
    const seed=JSON.parse(await file.text()),names=Object.keys(seed.shards);
    for(let i=0;i<names.length;i+=30){
      const part={};names.slice(i,i+30).forEach(n=>part[n]=seed.shards[n]);
      await post(token,{shards:part});log('Uploaded '+Math.min(i+30,names.length)+' of '+names.length+'…');
    }
    await post(token,{salt:seed.salt,out:seed.out,cursor:seed.cursor});
    log('Done. The song lists will update on their own from now on. You can close this page.');
  }catch(e){log('Something went wrong: '+e.message)}
};
</script></body>`;

export async function seedHandler(request, env, json) {
  if (request.method === "GET") {
    return new Response(SEED_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex", "Cache-Control": "no-store" } });
  }
  if (request.method !== "POST") return new Response("method", { status: 405 });
  const auth = request.headers.get("Authorization") || "";
  if (!env.SEED_TOKEN || auth !== "Bearer " + env.SEED_TOKEN) return new Response("unauthorized", { status: 401 });
  if (!env.SONGS) return new Response("no storage bound", { status: 500 });
  let body;
  try { body = await request.json(); } catch (e) { return new Response("bad json", { status: 400 }); }
  const names = Object.keys(body.shards || {});
  if (names.length > 40) return new Response("too many shards at once", { status: 400 });
  for (const n of names) if (!/^[0-9a-f]{2}$/.test(n)) return new Response("bad shard name", { status: 400 });
  await Promise.all(names.map((n) => env.SONGS.put("s:" + n, JSON.stringify(body.shards[n]))));
  if (body.salt) await env.SONGS.put("salt", String(body.salt));
  if (body.out) await env.SONGS.put("out", JSON.stringify(body.out));
  if (body.cursor) await env.SONGS.put("cursor", String(body.cursor)); // last, so updates only start once everything is in
  return new Response("ok", { status: 200 });
}
