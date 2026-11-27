// Turns an RSS 2.0 or Atom feed into the one "latest article" the website shows.
// Plain string work only (no dependencies), written to stay well inside the free Worker CPU limit even on a large Substack feed:
// it finds the newest entry from the small header of each entry, and only reads the body of that one.

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "\u2013", mdash: "\u2014",
  hellip: "\u2026", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D", middot: "\u00B7",
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(n) || n < 32 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return " ";
      return String.fromCodePoint(n);
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

// HTML (or text) to safe plain text: scripts and styles dropped, tags removed, entities decoded, whitespace collapsed.
// The website only ever shows the result with textContent, so nothing in it can run.
export function toText(html) {
  if (!html) return "";
  let s = String(html)
    .replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|figure|figcaption)>/gi, " ")
    .replace(/<[^>]*>/g, "");
  s = decodeEntities(s).replace(/[\u0000-\u001f\u007f\u200b\u2028\u2029]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

export function truncate(s, n) {
  if (s.length <= n) return s;
  let cut = s.lastIndexOf(" ", n);
  if (cut < n * 0.6) cut = n;
  return s.slice(0, cut).replace(/[\s,;:\u2013\u2014-]+$/, "") + "\u2026";
}

function blocks(xml, tag) {
  const out = [];
  const open = "<" + tag, close = "</" + tag + ">";
  let i = 0;
  for (;;) {
    const a = xml.indexOf(open, i);
    if (a < 0) break;
    if (!/[\s>\/]/.test(xml.charAt(a + open.length))) { i = a + open.length; continue; }
    const b = xml.indexOf(close, a);
    if (b < 0) break;
    out.push(xml.slice(a, b + close.length));
    i = b + close.length;
  }
  return out;
}

function openTag(b, tag, from = 0) {
  const open = "<" + tag;
  let a = b.indexOf(open, from);
  while (a >= 0 && !/[\s>\/]/.test(b.charAt(a + open.length))) a = b.indexOf(open, a + 1);
  if (a < 0) return null;
  const gt = b.indexOf(">", a);
  return gt < 0 ? null : { start: a, gt, tag: b.slice(a, gt + 1) };
}

// Text inside <tag>...</tag>. CDATA is taken as is; anything else has its XML entities decoded.
function field(b, tag) {
  const t = openTag(b, tag);
  if (!t) return null;
  if (b.charAt(t.gt - 1) === "/") return "";
  const end = b.indexOf("</" + tag + ">", t.gt);
  if (end < 0) return null;
  const raw = b.slice(t.gt + 1, end).trim();
  if (raw.startsWith("<![CDATA[")) return raw.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
  return decodeEntities(raw);
}

function attr(tag, name) {
  const m = new RegExp("\\b" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')", "i").exec(tag);
  return m ? decodeEntities(m[2] !== undefined ? m[2] : m[3]) : null;
}

// RSS puts the address in <link>text</link>; Atom puts it in <link href="..." rel="alternate"/>.
function linkOf(b) {
  const plain = field(b, "link");
  if (plain && /^https?:\/\//i.test(plain.trim())) return plain.trim();
  let best = null, from = 0;
  for (;;) {
    const t = openTag(b, "link", from);
    if (!t) break;
    const href = attr(t.tag, "href"), rel = (attr(t.tag, "rel") || "alternate").toLowerCase();
    if (href && rel === "alternate") return href.trim();
    if (href && !best) best = href.trim();
    from = t.gt;
  }
  return best;
}

function safeUrl(u) {
  if (!u) return null;
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
  } catch { return null; }
}

// The opening paragraphs of an article as plain text. Only <p> elements are read, so pictures, headings,
// lists, buttons and the "Subscribe" boxes Substack inserts are left out.
function openingParagraphs(html, want) {
  const out = [];
  let total = 0;
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  const src = html.slice(0, 30000);
  let m;
  while (total < want && (m = re.exec(src))) {
    if (/button-wrapper|subscri|share|footnote|caption/i.test(m[1])) continue;
    const t = toText(m[2]);
    if (t.length < 2) continue;
    if (t.length < 120 && /^(subscribe|share|upgrade|thanks for reading|this post is public|leave a comment|give a gift)/i.test(t)) continue;
    out.push(t);
    total += t.length + 1;
  }
  // an enormous first paragraph (or no <p> tags at all): fall back to the start of the plain text
  if (!out.length) return toText(html.slice(0, 4000));
  return out.join(" ");
}

export function parseFeed(xml, opts = {}) {
  const excerptChars = opts.excerptChars || 420;
  if (typeof xml !== "string" || xml.length < 40) throw new Error("empty feed");
  let items = blocks(xml, "item");
  const atom = items.length === 0;
  if (atom) items = blocks(xml, "entry");
  if (items.length === 0) throw new Error("no entries in feed");

  // Newest by publication date (not simply the first one listed).
  let best = null, bestTime = -Infinity;
  for (const it of items) {
    const ci = it.indexOf(atom ? "<content" : "<content:encoded");
    const head = ci > 0 && !atom ? it.slice(0, ci) : it;
    const raw = atom ? (field(head, "published") || field(head, "updated")) : (field(head, "pubDate") || field(head, "dc:date"));
    const t = raw ? Date.parse(raw.trim()) : NaN;
    if (Number.isFinite(t) && t > bestTime) { bestTime = t; best = it; }
  }
  if (!best) { best = items[0]; bestTime = NaN; }

  const title = toText(field(best, "title") || "");
  const link = safeUrl(linkOf(best));
  if (!title || !link) throw new Error("entry has no title or link");

  const description = field(best, atom ? "summary" : "description");
  const content = field(best, atom ? "content" : "content:encoded");
  let subtitle = "", excerpt = "";
  if (content) {
    subtitle = truncate(toText(description || ""), 200);
    excerpt = truncate(openingParagraphs(content, excerptChars), excerptChars);
  } else {
    excerpt = truncate(toText(description || ""), excerptChars);
  }
  if (excerpt && subtitle && excerpt.startsWith(subtitle.replace(/\u2026$/, ""))) subtitle = "";

  const first = items.length ? xml.indexOf(atom ? "<entry" : "<item") : xml.length;
  const channelHead = xml.slice(0, first > 0 ? first : xml.length);
  const siteTitle = toText(field(channelHead, "title") || "");
  const siteLink = safeUrl(linkOf(channelHead));

  return {
    site: { title: siteTitle, link: siteLink },
    item: {
      title,
      link,
      date: Number.isFinite(bestTime) ? new Date(bestTime).toISOString() : null,
      subtitle,
      excerpt,
    },
  };
}
