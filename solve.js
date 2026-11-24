// solve.js — a fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Reimplements the reference generator's behaviour from its README and code: the
// strict front matter, the Markdown subset, the template dialect, the slug rule and
// the build report. The speed comes from a fused single-pass Markdown renderer (no
// token objects), bulk HTML escaping instead of per-character escaping, substring
// front-matter parsing instead of split-and-rejoin, and memoised slugs and dates.
// No dependencies, no I/O, no clock, no randomness: run(input) is a pure function
// of its input, and the same input always yields the same output.

// ---------------------------------------------------------------- text basics

/** The HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST = /[&<>"']/;

/**
 * `s` with & < > " ' escaped. Most strings hold no escapable character, so a
 * cheap test skips the replace entirely for them; only strings that actually
 * contain one pay for the replacement pass.
 */
function esc(s) {
  return ESCAPE_TEST.test(s) ? s.replace(ESCAPE_RE, (c) => ESCAPES[c]) : s;
}

/** Whether char code `c` is JavaScript whitespace (\s), exactly. */
function isWS(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** `s` with spaces and tabs at both ends dropped. */
function trimST(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

/** Whether `s` holds only spaces and tabs (or is empty). */
function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * The words of a body: its runs of non-whitespace characters. Counted over the
 * whole body at once — a word cannot span a newline, so this equals the sum
 * over lines, with one call per document instead of one per line. ASCII text
 * takes the fast path: every printable ASCII character above the space is a
 * word character, so only control characters and non-ASCII code points need
 * the full whitespace test.
 */
function countWords(s) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 32) {
      if (c === 32 || (c >= 9 && c <= 13)) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    } else if (c < 127) {
      if (!inWord) {
        inWord = true;
        n++;
      }
    } else if (isWS(c)) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- slugs, dates

const MARK_RE = /\p{M}/gu;
const NONALNUM_RE = /[^a-z0-9]+/g;
const EDGE_DASH_RE = /^-+|-+$/g;
const TAIL_DASH_RE = /-+$/;
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Pure ASCII text skips the normalisation pass (it is the identity there); the
 * result is memoised, since titles, tags and headings repeat across a site.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let s = text;
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) s = s.normalize('NFKD').replace(MARK_RE, '');
  s = s.toLowerCase().replace(NONALNUM_RE, '-').replace(EDGE_DASH_RE, '');
  s = s.slice(0, 64).replace(TAIL_DASH_RE, '');
  const out = s === '' ? 'untitled' : s;
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(d) {
  let hit = dateCache.get(d);
  if (hit === undefined) {
    hit = `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
    dateCache.set(d, hit);
  }
  return hit;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A title/summary value: "..." with \" and \\ its only escapes, or bare. */
function parseStringValue(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { e: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { e: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { e: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { v: out };
  }
  if (raw.charCodeAt(0) === 91) return { e: 'a bare string opens on [' };
  return { v: raw };
}

/** Whether `raw` is a real day from 1970-01-01 to 2099-12-31, written YYYY-MM-DD. */
function validDate(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
  const m = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
  const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
  return y >= 1970 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** A tags value: `[a, b, c]`, each name trimmed, none empty or holding " [ or ]. */
function parseTagsValue(raw) {
  if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { e: 'key "tags": not a list [a, b]' };
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { v: [] };
  const tags = [];
  for (let p of inner.split(',')) {
    p = p.trim();
    if (p === '') return { e: 'key "tags": an empty tag, or one holding " [ or ]' };
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i);
      if (c === 34 || c === 91 || c === 93) return { e: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    tags.push(p);
  }
  return { v: tags };
}

/** Whether `s` is a template name: a-z, 0-9 and `-`, at least one character. */
function isLayoutName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug: a-z and 0-9, single `-` between, at most 64 characters. */
function isSlugValue(s) {
  if (s.length === 0 || s.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return !prevDash;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. The body is taken as a substring — never split and
 * rejoined — and only the front-matter lines themselves are split.
 */
function parseFrontMatter(text) {
  if (text.length < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) return { error: 'no front matter' };
  if (text.length > 3 && text.charCodeAt(3) !== 10) return { error: 'no front matter' };
  let closeLine = -1;
  let bodyStart = -1;
  const nl = text.indexOf('\n---\n', 3);
  if (nl !== -1) {
    closeLine = nl + 1;
    bodyStart = nl + 5;
  } else if (text.length >= 7 && text.endsWith('\n---')) {
    closeLine = text.length - 3;
    bodyStart = text.length;
  } else return { error: 'the front matter is not closed' };
  const data = {};
  const lines = closeLine === 4 ? [] : text.slice(4, closeLine - 1).split('\n');
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${j + 2} is not "key: value"` };
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    if (e < raw.length) raw = raw.slice(0, e);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    if (key === 'title' || key === 'summary') {
      const r = parseStringValue(raw);
      if (r.e !== undefined) return { error: `key "${key}": ${r.e}` };
      data[key] = r.v;
    } else if (key === 'date') {
      if (!validDate(raw)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      data[key] = raw;
    } else if (key === 'tags') {
      const r = parseTagsValue(raw);
      if (r.e !== undefined) return { error: r.e };
      data[key] = r.v;
    } else if (key === 'draft') {
      if (raw === 'true') data[key] = true;
      else if (raw === 'false') data[key] = false;
      else return { error: 'key "draft": true or false' };
    } else if (key === 'layout') {
      if (!isLayoutName(raw)) return { error: 'key "layout": not a template name' };
      data[key] = raw;
    } else {
      if (!isSlugValue(raw)) return { error: 'key "slug": not a slug' };
      data[key] = raw;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

/** The first index in [from, end) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j + wlen <= end; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single `*` in [from, end) — one whose run is not `**` — outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `rel`, a link's path, resolved from the directory segments `dirSegs`, or null when it climbs above the root. */
function resolveRel(dirSegs, rel) {
  const parts = dirSegs.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * A link's href: a target with a scheme, opening on `/` or `#`, is kept as written;
 * any other is a path from the source's directory, resolved to a page's url or a
 * static file's url, or reported as a broken link and kept as written.
 */
function resolveLink(target, L) {
  const c0 = target.charCodeAt(0);
  if (c0 === 47 || c0 === 35) return target;
  if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
    let j = 1;
    while (j < target.length) {
      const c = target.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) j++;
      else break;
    }
    if (j < target.length && target.charCodeAt(j) === 58) return target;
  }
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  if (rel === '') {
    L.broken.add(`broken-link ${L.src} -> ${target}`);
    return target;
  }
  const path = resolveRel(L.dirSegs, rel);
  if (path !== null) {
    const pg = L.bySource.get(path);
    if (pg !== undefined) return pg.url + frag;
    if (L.statics.has(path)) return `${L.base}/${path}${frag}`;
  }
  L.broken.add(`broken-link ${L.src} -> ${target}`);
  return target;
}

/** The characters that can start an inline construct: backslash, backtick, star, bracket. */
const SPECIAL_RE = /[\\`*[]/g;

/**
 * `s[a..b)` rendered inline: code spans, strong, emphasis, links and backslash
 * escapes, everything else escaped. A regex jump finds the next special character
 * instead of scanning one character at a time, plain runs between specials are
 * escaped in one regex pass each, and nested spans recurse on bounds of the same
 * string, so no substring is ever copied for the recursion itself. The shared
 * jump regex is safe under recursion: every loop pass sets its lastIndex first.
 */
function inlineRange(s, a, b, L) {
  let out = '';
  let i = a;
  let plain = a;
  while (i < b) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    const j = m !== null && m.index < b ? m.index : b;
    i = j;
    if (i >= b) break;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < b && ESCAPABLE.has(s[i + 1])) {
        if (i > plain) out += esc(s.slice(plain, i));
        out += esc(s[i + 1]);
        i += 2;
        plain = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < b && k > i + 1) {
        if (i > plain) out += esc(s.slice(plain, i));
        out += `<code>${esc(s.slice(i + 1, k))}</code>`;
        i = k + 1;
        plain = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 42) {
      if (i + 1 < b && s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2, b);
        if (k !== -1 && k > i + 2) {
          if (i > plain) out += esc(s.slice(plain, i));
          out += `<strong>${inlineRange(s, i + 2, k, L)}</strong>`;
          i = k + 2;
          plain = i;
          continue;
        }
        i += 2;
        continue;
      }
      const k = findSingleStar(s, i + 1, b);
      if (k !== -1 && k > i + 1) {
        if (i > plain) out += esc(s.slice(plain, i));
        out += `<em>${inlineRange(s, i + 1, k, L)}</em>`;
        i = k + 1;
        plain = i;
        continue;
      }
      i++;
      continue;
    }
    // c === 91, '['
    const k = findUnescaped(s, ']', i + 1, b);
    let m2 = -1;
    if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) m2 = s.indexOf(')', k + 2);
    if (m2 !== -1 && m2 < b) {
      const target = s.slice(k + 2, m2);
      if (target !== '' && !WS_RE.test(target)) {
        if (i > plain) out += esc(s.slice(plain, i));
        out += `<a href="${esc(resolveLink(target, L))}">${inlineRange(s, i + 1, k, L)}</a>`;
        i = m2 + 1;
        plain = i;
        continue;
      }
    }
    i++;
  }
  if (b > plain) out += esc(s.slice(plain, b));
  return out;
}

/** A whole string rendered inline. */
function inlineStr(s, L) {
  return inlineRange(s, 0, s.length, L);
}

// --- block line tests (each the manual form of the reference's line regex) ---

/** A fence's language, or null when `line` does not open a fence. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingAt(line) {
  let c = 0;
  while (c < line.length && line.charCodeAt(c) === 35) c++;
  if (c === 0 || c > 6 || c >= line.length) return null;
  const s = line.charCodeAt(c);
  if (s !== 32 && s !== 9) return null;
  let a = c;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: c, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null when `line` does not open one. */
function bulletAt(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 !== 45 && c0 !== 42) || line.charCodeAt(1) !== 32) return null;
  return trimST(line.slice(2));
}

/** An ordered item's number and text, or null when `line` does not open one. */
function orderedAt(line) {
  let d = 0;
  while (d < line.length) {
    const c = line.charCodeAt(d);
    if (c >= 48 && c <= 57) d++;
    else break;
  }
  if (d === 0 || d > 9) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  let num = 0;
  for (let k = 0; k < d; k++) num = num * 10 + (line.charCodeAt(k) - 48);
  return { start: num, text: trimST(line.slice(d + 2)) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let sp = 0;
  while (sp < line.length && line.charCodeAt(sp) === 32) sp++;
  if (sp < 2 || sp >= line.length) return false;
  return !isWS(line.charCodeAt(sp));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsPara(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingAt(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/**
 * A body rendered in one pass over its lines: its HTML (each block on its own
 * lines, a "\n" after the last), its table of contents (every level 2 and 3
 * heading), its excerpt (the first paragraph's inline HTML, or "") and its word
 * count (counted over the whole body at once, which equals the sum over lines).
 */
function renderBody(body, L) {
  const lines = body.split('\n');
  const out = [];
  const toc = [];
  let excerpt = '';
  let haveExcerpt = false;
  const ids = new Set();
  const words = countWords(body);
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    // Dispatch on the first character: most lines are paragraph lines, and only
    // a few first characters can start anything else.
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    if (c0 === -1) {
      i++;
      continue;
    }
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      // An indented line is paragraph text; fall through to the paragraph below.
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        let j = i + 1;
        while (j < n && !isFenceClose(lines[j])) j++;
        const cls = lang === '' ? '' : ` class="language-${lang}"`;
        const seg = j > i + 1 ? `${esc(lines.slice(i + 1, j).join('\n'))}\n` : '';
        out.push(`<pre><code${cls}>${seg}</code></pre>`);
        i = j + 1;
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingAt(line);
      if (hd !== null) {
        const id = uniqSlug(slugify(hd.text), ids);
        const html = inlineStr(hd.text, L);
        out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out.push('<hr>');
        i++;
        continue;
      }
      const b = bulletAt(line);
      if (b !== null) {
        const items = [[b]];
        i++;
        while (i < n) {
          const m = bulletAt(lines[i]);
          if (m !== null) {
            items.push([m]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimST(lines[i]));
            i++;
          } else break;
        }
        let html = '<ul>\n';
        for (const parts of items) html += `<li>${inlineStr(parts.join('\n'), L)}</li>\n`;
        out.push(`${html}</ul>`);
        continue;
      }
    } else if (c0 === 62) {
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let s = lines[i].slice(1);
        if (s.charCodeAt(0) === 32) s = s.slice(1);
        s = trimST(s);
        if (s !== '') parts.push(s);
        i++;
      }
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>');
      else {
        const joined = parts.join('\n');
        out.push(`<blockquote>\n<p>${inlineStr(joined, L)}</p>\n</blockquote>`);
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const o = orderedAt(line);
      if (o !== null) {
        const items = [[o.text]];
        i++;
        while (i < n) {
          const m = orderedAt(lines[i]);
          if (m !== null) {
            items.push([m.text]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimST(lines[i]));
            i++;
          } else break;
        }
        const open = o.start !== 1 ? `<ol start="${o.start}">` : '<ol>';
        let html = `${open}\n`;
        for (const parts of items) html += `<li>${inlineStr(parts.join('\n'), L)}</li>\n`;
        out.push(`${html}</ol>`);
        continue;
      }
    }
    const parts = [trimST(line)];
    i++;
    while (i < n && !endsPara(lines[i])) {
      parts.push(trimST(lines[i]));
      i++;
    }
    const html = inlineStr(parts.join('\n'), L);
    if (!haveExcerpt) {
      excerpt = html;
      haveExcerpt = true;
    }
    out.push(`<p>${html}</p>`);
  }
  return { html: out.length === 0 ? '' : `${out.join('\n')}\n`, toc, excerpt, words };
}

// ---------------------------------------------------------------- templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function splitPath(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const closer = raw ? '}}}' : '}}';
      const start = open + (raw ? 3 : 2);
      const close = src.indexOf(closer, start);
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: splitPath(name, src.slice(start, close).trim()) });
      i = close + closer.length;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlank(src.slice(lineStart, open)) && isBlank(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') {
      body.push({ kind: 'text', text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ kind: tok.t, path: tok.path });
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: splitPath(name, m[2]), body: [] };
      // One vars object and one loop object per for node, reused by every
      // iteration of every render instead of allocated per iteration.
      // Re-entrancy (a template including itself through the loop body) stays
      // correct because each execution saves and restores them on exit. The
      // scope wrapper itself is fresh per execution: reusing it would let a
      // re-entrant execution make the scope its own parent and loop forever.
      node.loop = { index: 0, first: false, last: false, length: 0 };
      node.vars = { loop: node.loop };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: splitPath(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookupPath(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function valueText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(valueText).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }); includes nest at most 8 deep. */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var': {
        const v = lookupPath(scope, n.path);
        out += typeof v === 'string' ? esc(v) : esc(valueText(v));
        break;
      }
      case 'raw': {
        const v = lookupPath(scope, n.path);
        out += typeof v === 'string' ? v : valueText(v);
        break;
      }
      case 'if': {
        const branch = isTruthy(lookupPath(scope, n.path)) !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookupPath(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        const loop = n.loop;
        const vars = n.vars;
        const prevItem = vars[n.name];
        const prevIndex = loop.index;
        const prevFirst = loop.first;
        const prevLast = loop.last;
        const prevLength = loop.length;
        const child = { vars, parent: scope };
        loop.length = len;
        // A loop variable named "loop" never reaches the scope: the reference
        // builds { [name]: item, loop: {...} }, where the later loop key wins.
        const bindItem = n.name !== 'loop';
        for (let k = 0; k < len; k++) {
          if (bindItem) vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          out += renderNodes(n.body, child, ctx, depth);
        }
        if (bindItem) vars[n.name] = prevItem;
        loop.index = prevIndex;
        loop.first = prevFirst;
        loop.last = prevLast;
        loop.length = prevLength;
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < 8) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED_DIRS = ['posts', 'tags', 'page'];

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s, cards) {
  const card = s.post ? cards.get(s) : cardOf(s);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
function buildSite(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the checks, in order: refused, the generator's own
  // directories, a post with no date, a layout that is no parsed template, draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each page's slug, made unique in its directory, in source order.
  const takenByDir = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED_DIRS : []);
      takenByDir.set(dir, taken);
    }
    const slug = uniqSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title), taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const md = renderBody(s.body, {
      dirSegs: dir === '' ? [] : dir.split('/'),
      bySource,
      statics: staticPaths,
      base,
      broken,
      src: s.path,
    });
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags, grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags;
    if (tags !== undefined) {
      for (const name of tags) {
        const slug = slugify(name);
        if (!seen.has(slug)) {
          seen.add(slug);
          out.push(name);
        }
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const renderInto = (name, scope) => {
    const nodes = templates.get(name);
    return nodes === undefined ? null : renderNodes(nodes, scope, ctx, 0);
  };
  const pageVars = { site, tags: allTags, recent, page: null };
  const pageScope = { vars: pageVars, parent: null };
  for (const s of kept) {
    pageVars.page = pageOf(s, cards);
    output[`${s.outDir}/index.html`] = renderInto(s.layout, pageScope);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  const indexVars = { site, tags: allTags, recent, posts: null, pager: null };
  const indexScope = { vars: indexVars, parent: null };
  for (let k = 1; k <= pages; k++) {
    indexVars.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    indexVars.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = renderInto('index', indexScope);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  const tagVars = { site, tags: allTags, recent, tag: null };
  const tagScope = { vars: tagVars, parent: null };
  for (const t of tags) {
    tagVars.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = renderInto('tag', tagScope);
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = renderInto('tags', { vars: { site, tags: allTags, recent }, parent: null });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input, computed faster. */
export function run(input) {
  return buildSite(input);
}
