// solve.js — a fast drop-in for makefun-site 1.0.0.
//
// Written fresh from the competition README's own spec of the dialect.
// Design (approach A, the strongest of three scored): the Markdown renderer
// is one fused single pass — block scan and inline scan share one charCode
// dispatch, escaping rides along in chunks, nothing is tokenised twice.
// Templates are precompiled once per run into a small node tree with paths
// pre-split; rendering walks a scope stack. Slugs are cached per run only.
// No state is kept between run() calls: every cache is created inside run().

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// HTML escaping: & < > " ' only, nothing else.
function esc(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESC_MAP[c]) : s;
}

// The slug rule: NFKD, combining marks dropped, A-Z lowered, each run of
// characters other than a-z and 0-9 one '-', none at either end, cut to 64
// (a '-' left at the cut dropped), 'untitled' when nothing is left.
function slugifyRaw(s) {
  let t = s;
  let ascii = true;
  for (let i = 0; i < t.length; i++) {
    if (t.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) t = t.normalize('NFKD').replace(/[\p{M}]/gu, '');
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) out += t[i];
    else if (c >= 65 && c <= 90) out += String.fromCharCode(c + 32);
    else if (out !== '' && out.charCodeAt(out.length - 1) !== 45) out += '-';
  }
  if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  }
  return out === '' ? 'untitled' : out;
}

function dateLong(d) {
  if (!d) return '';
  return (+d.slice(8, 10)) + ' ' + MONTHS[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4);
}

// Words: runs of characters other than whitespace.
function countWords(s) {
  let w = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
    if (ws) inWord = false;
    else if (!inWord) { w++; inWord = true; }
  }
  return w;
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Trim spaces and tabs at both ends.
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function dropTrailingST(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return b === s.length ? s : s.slice(0, b);
}

function isLangChar(c) {
  return (
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
    c === 95 || c === 43 || c === 45
  ); // A-Z a-z 0-9 _ + -
}

function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57);
}

// A path is names joined by '.', each from a letter or '_'.
function parsePath(text) {
  if (text === '') return null;
  const parts = text.split('.');
  for (const p of parts) {
    if (p === '') return null;
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i);
      if (i === 0 ? !isNameStart(c) : !isNameChar(c)) return null;
    }
  }
  return parts;
}

// ---------------------------------------------------------------- front matter

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28;
  if (m === 4 || m === 6 || m === 9 || m === 11) return 30;
  return 31;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_VALUE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LAYOUT_VALUE_RE = /^[a-z0-9-]+$/;

function validateValue(key, value) {
  if (key === 'title' || key === 'summary') {
    if (value.charCodeAt(0) === 34) {
      // Quoted: the closing quote is the last character, and the interior
      // holds only \" and \\ escapes and no other quote.
      if (value.length < 2 || value.charCodeAt(value.length - 1) !== 34) {
        return { error: 'a quoted string is not closed' };
      }
      let out = '';
      let i = 1;
      const end = value.length - 1;
      while (i < end) {
        const c = value[i];
        if (c === '\\') {
          if (i + 1 < end && (value[i + 1] === '"' || value[i + 1] === '\\')) {
            out += value[i + 1];
            i += 2;
          } else {
            return { error: 'a quoted string holds an escape other than \\" or \\\\' };
          }
        } else if (c === '"') {
          return { error: 'a quoted string holds a stray quote' };
        } else {
          out += c;
          i++;
        }
      }
      return { value: out };
    }
    if (value.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
    return { value };
  }
  if (key === 'date') {
    if (!DATE_RE.test(value)) return { error: 'not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    const y = +value.slice(0, 4);
    const m = +value.slice(5, 7);
    const d = +value.slice(8, 10);
    if (y < 1970 || y > 2099 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
      return { error: 'not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value };
  }
  if (key === 'tags') {
    if (value.charCodeAt(0) !== 91 || value.charCodeAt(value.length - 1) !== 93) {
      return { error: 'not a list [a, b]' };
    }
    const inner = value.slice(1, -1);
    if (inner === '') return { value: [] };
    const tags = inner.split(',');
    for (let i = 0; i < tags.length; i++) {
      const t = trimST(tags[i]);
      if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
        return { error: 'an empty tag, or one holding " [ or ]' };
      }
      tags[i] = t;
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (value === 'true') return { value: true };
    if (value === 'false') return { value: false };
    return { error: 'true or false' };
  }
  if (key === 'layout') {
    if (!LAYOUT_VALUE_RE.test(value)) return { error: 'not a template name' };
    return { value };
  }
  if (key === 'slug') {
    if (value.length > 64 || !SLUG_VALUE_RE.test(value)) return { error: 'not a slug' };
    return { value };
  }
  return { value };
}

const KNOWN_KEYS = { title: 1, date: 1, tags: 1, draft: 1, layout: 1, slug: 1, summary: 1 };

// Returns { fm, body } or { error } where error is the refusal reason.
// The body is sliced out, never split and re-joined.
function parseFrontMatter(content) {
  if (!content.startsWith('---\n') && content !== '---') return { error: 'no front matter' };
  let closeEnd = -1;
  let p = 4; // just after the opening '---\n'
  while (true) {
    let eol = content.indexOf('\n', p);
    if (eol === -1) eol = content.length;
    if (
      eol - p === 3 &&
      content.charCodeAt(p) === 45 && content.charCodeAt(p + 1) === 45 && content.charCodeAt(p + 2) === 45
    ) { closeEnd = eol; break; }
    if (eol === content.length) break;
    p = eol + 1;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  const closeStart = closeEnd - 3;
  const fm = {};
  let lineNo = 2;
  p = 4;
  while (p < closeStart) {
    let eol = content.indexOf('\n', p);
    if (eol === -1 || eol > closeStart) eol = closeStart;
    const line = content.slice(p, eol);
    if (!isBlank(line) && line.charCodeAt(0) !== 35) {
      let j = 0;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if ((c >= 97 && c <= 122) || c === 95) j++;
        else break;
      }
      if (j === 0 || line.charCodeAt(j) !== 58) {
        return { error: 'line ' + lineNo + ' is not "key: value"' };
      }
      const key = line.slice(0, j);
      const rest = line.slice(j + 1);
      if (rest === '') return { error: 'key "' + key + '" has no value' };
      if (rest.charCodeAt(0) !== 32) {
        return { error: 'line ' + lineNo + ' is not "key: value"' };
      }
      const value = dropTrailingST(rest.slice(1));
      if (value === '') return { error: 'key "' + key + '" has no value' };
      if (!KNOWN_KEYS[key]) return { error: 'unknown key "' + key + '"' };
      if (Object.hasOwn(fm, key)) return { error: 'key "' + key + '" is given twice' };
      const v = validateValue(key, value);
      if (v.error) return { error: 'key "' + key + '": ' + v.error };
      fm[key] = v.value;
    }
    lineNo++;
    p = eol + 1;
  }
  if (!fm.title) return { error: 'no title' };
  return { fm, body: closeEnd === content.length ? '' : content.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- templates
//
// Node shapes (arrays, first slot is the kind):
//   ['t', text]  ['v', path, raw]  ['f', varName, path, body]
//   ['i', path, neg, then, elseOrNull]  ['c', name]
// A {% %} tag alone on its line (only spaces/tabs beside it) takes the
// whole line with it, its \n included; text, {{ }} and {{{ }}} never do.

// Strip the line (spaces + tag + \n) of every tag-alone line, keeping the tag.
function stripTagAloneLines(src) {
  const lines = src.split('\n');
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^[ \t]*(\{%(?:[^%]|%(?!\}))*%\})[ \t]*$/.exec(line);
    if (m) {
      // The tag takes the whole line with it, its \n included.
      out += m[1];
    } else {
      out += line;
      if (i < lines.length - 1) out += '\n';
    }
  }
  return out;
}

// Returns { nodes } or { error }.
function parseTemplate(src) {
  const s = stripTagAloneLines(src);
  const root = [];
  const stack = [{ body: root, kind: '' }];
  let i = 0;
  const n = s.length;
  const cur = () => stack[stack.length - 1].body;
  const pushText = (t) => { if (t !== '') cur().push(['t', t]); };
  while (i < n) {
    const o2 = s.indexOf('{{', i);
    const o3 = s.indexOf('{{{', i);
    const ot = s.indexOf('{%', i);
    let k = -1;
    let kind = 0; // 1 = {{{, 2 = {{, 3 = {%
    if (o3 !== -1 && (k === -1 || o3 < k)) { k = o3; kind = 1; }
    if (o2 !== -1 && (k === -1 || o2 < k)) { k = o2; kind = 2; }
    if (ot !== -1 && (k === -1 || ot < k)) { k = ot; kind = 3; }
    if (k === -1) { pushText(s.slice(i)); break; }
    if (k > i) pushText(s.slice(i, k));
    if (kind === 1) {
      const e = s.indexOf('}}}', k + 3);
      if (e === -1) return { error: 'unclosed {{{' };
      const path = parsePath(s.slice(k + 3, e).trim());
      if (!path) return { error: 'bad path' };
      cur().push(['v', path, true]);
      i = e + 3;
    } else if (kind === 2) {
      const e = s.indexOf('}}', k + 2);
      if (e === -1) return { error: 'unclosed {{' };
      const path = parsePath(s.slice(k + 2, e).trim());
      if (!path) return { error: 'bad path' };
      cur().push(['v', path, false]);
      i = e + 2;
    } else {
      const e = s.indexOf('%}', k + 2);
      if (e === -1) return { error: 'unclosed {%' };
      const tag = s.slice(k + 2, e).trim();
      i = e + 2;
      const top = stack[stack.length - 1];
      if (tag === 'else') {
        if (top.kind !== 'if' || top.node[4] !== null) return { error: 'unexpected else' };
        top.node[4] = [];
        top.body = top.node[4];
      } else if (tag === 'endif') {
        if (top.kind !== 'if') return { error: 'unexpected endif' };
        stack.pop();
      } else if (tag === 'endfor') {
        if (top.kind !== 'for') return { error: 'unexpected endfor' };
        stack.pop();
      } else if (tag.startsWith('for ')) {
        const m = /^for ([A-Za-z_][A-Za-z0-9_]*) in (.+)$/.exec(tag);
        if (!m) return { error: 'unknown tag' };
        const path = parsePath(m[2].trim());
        if (!path) return { error: 'bad path' };
        const node = ['f', m[1], path, []];
        cur().push(node);
        stack.push({ body: node[3], kind: 'for', elseBody: null });
      } else if (tag.startsWith('if ')) {
        const m = /^if (not )?(.+)$/.exec(tag);
        if (!m) return { error: 'unknown tag' };
        const path = parsePath(m[2].trim());
        if (!path) return { error: 'bad path' };
        const node = ['i', path, !!m[1], [], null];
        cur().push(node);
        stack.push({ body: node[3], kind: 'if', elseBody: null, node });
      } else if (tag.startsWith('include ')) {
        const m = /^include "([^"]*)"$/.exec(tag);
        if (!m) return { error: 'unknown tag' };
        cur().push(['c', m[1]]);
      } else {
        return { error: 'unknown tag' };
      }
    }
  }
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    return { error: top.kind === 'for' ? 'unclosed for' : 'unclosed if' };
  }
  return { nodes: root };
}

// ---------------------------------------------------------------- inline + links

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// Characters a backslash can escape: \ ` * _ [ ] ( ) # + - . ! >
function isEscapable(c) {
  return (
    c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 ||
    c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 ||
    c === 33 || c === 62
  );
}

function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) return true;
  }
  return false;
}

// Resolve a link target from the source's directory. Returns the href, and
// records a broken link when the target names neither a built page nor a
// static file.
function resolveHref(target, ctx) {
  const cached = ctx.hrefs.get(target);
  if (cached !== undefined) return cached;
  let out;
  if (SCHEME_RE.test(target)) out = target;
  else {
    const c0 = target.charCodeAt(0);
    if (c0 === 47 || c0 === 35) out = target; // opens on '/' or '#'
    else {
      const hash = target.indexOf('#');
      const pathPart = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? null : target.slice(hash + 1);
      if (ctx.dirStack === null) ctx.dirStack = ctx.dir === '' ? [] : ctx.dir.split('/');
      const stack = ctx.dirStack.slice();
      const segs = pathPart.split('/');
      for (const seg of segs) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') { if (stack.length > 0) stack.pop(); continue; }
        stack.push(seg);
      }
      const resolved = stack.join('/');
      let href = ctx.pages.get(resolved);
      if (href === undefined) {
        if (ctx.statics.has(resolved)) href = ctx.base + '/' + resolved;
        else {
          ctx.broken.add('broken-link ' + ctx.source + ' -> ' + target);
          out = target;
        }
      }
      if (out === undefined) out = frag === null ? href : href + '#' + frag;
    }
  }
  ctx.hrefs.set(target, out);
  return out;
}

// Fused inline scan: escapes, code spans, strong, emphasis and links in one
// left-to-right pass over the text. The scan itself is native: a regex finds
// the next special character, and the plain run before it goes out as one
// slice. Appends to out.
// Renders the inline markup of s[start..end) into out. The slice is never
// copied: plain runs are sliced only when pushed, and nested constructs
// recurse over sub-ranges of the same string.
function renderInlineInto(s, ctx, out, start, end) {
  const re = /[\\`*\[&<>"']/g;
  let i = start;
  re.lastIndex = start;
  let mm;
  while ((mm = re.exec(s)) !== null) {
    const k = mm.index;
    if (k >= end) break;
    const c = s.charCodeAt(k);
    if (c === 92) { // backslash
      if (k + 1 < end && isEscapable(s.charCodeAt(k + 1))) {
        if (k > i) out.push(s.slice(i, k));
        const e = s.charCodeAt(k + 1);
        out.push(e === 62 ? '&gt;' : s[k + 1]);
        i = k + 2;
        re.lastIndex = i;
      }
      continue; // otherwise the backslash is itself, left in the plain run
    }
    if (c === 96) { // backtick: code span
      const j = s.indexOf('`', k + 1);
      if (j !== -1 && j < end && j > k + 1) {
        if (k > i) out.push(s.slice(i, k));
        out.push('<code>', esc(s.slice(k + 1, j)), '</code>');
        i = j + 1;
        re.lastIndex = i;
      }
      continue; // otherwise the backtick is itself
    }
    if (c === 42) { // *
      if (k + 1 < end && s.charCodeAt(k + 1) === 42) { // strong: next ** not escaped
        let j = s.indexOf('**', k + 2);
        while (j !== -1 && j + 2 <= end) {
          let b = 0;
          for (let q = j - 1; q >= start && s.charCodeAt(q) === 92; q--) b++;
          if (b % 2 === 0) break; // the ** is not escaped
          j = s.indexOf('**', j + 1);
        }
        if (j !== -1 && j + 2 <= end && j > k + 2) {
          if (k > i) out.push(s.slice(i, k));
          out.push('<strong>');
          renderInlineInto(s, ctx, out, k + 2, j);
          out.push('</strong>');
          i = j + 2;
          re.lastIndex = i;
        } else {
          // No closer: both stars are literal; skip past them.
          re.lastIndex = k + 2;
        }
      } else { // emphasis: the next lone * — a ** pair is one unit, never
        // a closer, and an escaped star does not bar the closer after it.
        let p = k + 1;
        let closer = -1;
        while (p < end) {
          const ck = s.charCodeAt(p);
          if (ck === 92) { p += 2; continue; }
          if (ck === 42) {
            if (p + 1 < end && s.charCodeAt(p + 1) === 42) { p += 2; continue; }
            closer = p;
            break;
          }
          p++;
        }
        if (closer !== -1) {
          if (k > i) out.push(s.slice(i, k));
          out.push('<em>');
          renderInlineInto(s, ctx, out, k + 1, closer);
          out.push('</em>');
          i = closer + 1;
          re.lastIndex = i;
        }
      }
      continue;
    }
    if (c === 91) { // [ : link
      let p = k + 1;
      let close = -1;
      while (p < end) {
        if (s.charCodeAt(p) === 92) { p += 2; continue; }
        if (s.charCodeAt(p) === 93) { close = p; break; }
        p++;
      }
      if (close !== -1 && close + 1 < end && s.charCodeAt(close + 1) === 40) {
        const q = s.indexOf(')', close + 2);
        if (q !== -1 && q < end && q > close + 2) {
          const target = s.slice(close + 2, q);
          if (!hasWhitespace(target)) {
            if (k > i) out.push(s.slice(i, k));
            out.push('<a href="', esc(resolveHref(target, ctx)), '">');
            renderInlineInto(s, ctx, out, k + 1, close);
            out.push('</a>');
            i = q + 1;
            re.lastIndex = i;
          }
        }
      }
      continue; // otherwise the [ is itself
    }
    // & < > " ' : one-character escapes.
    if (k > i) out.push(s.slice(i, k));
    out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
    i = k + 1;
    re.lastIndex = i;
  }
  if (i < end) out.push(s.slice(i, end));
}

function renderInline(s, ctx) {
  const out = [];
  renderInlineInto(s, ctx, out, 0, s.length);
  return out.join('');
}

// Renders s[start..end) to a string (headings, toc, excerpts).
function renderInlineRange(s, ctx, start, end) {
  const out = [];
  renderInlineInto(s, ctx, out, start, end);
  return out.join('');
}

// ---------------------------------------------------------------- Markdown

// Renders one body to HTML. Returns { html, excerpt, toc, words }.
// Works on line ranges of the body string: no split, no per-line slices,
// and paragraphs whose lines need no trimming render straight from the
// body range (lines joined by single \n are exactly the joined text).
function renderMarkdown(body, ctx) {
  const words = countWords(body);
  const n = body.length;
  const out = [];
  let excerpt = '';
  const toc = [];
  const headingCounts = new Map();
  const uniqueHeadingSlug = (text) => {
    const base = slugifyRaw(text);
    const seen = headingCounts.get(base) || 0;
    headingCounts.set(base, seen + 1);
    return seen === 0 ? base : base + '-' + (seen + 1);
  };
  const lineEnd = (ls) => {
    const e = body.indexOf('\n', ls);
    return e === -1 ? n : e;
  };
  const isBlankRange = (ls, le) => {
    for (let p = ls; p < le; p++) {
      const c = body.charCodeAt(p);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  };
  const lineNeedsTrim = (ls, le) => {
    if (ls >= le) return false;
    const a = body.charCodeAt(ls);
    const b = body.charCodeAt(le - 1);
    return a === 32 || a === 9 || b === 32 || b === 9;
  };
  // Fence open on [ls, le): ``` + language chars + spaces/tabs only.
  // Returns the end of the language text, or -1.
  const fenceLangEnd = (ls, le) => {
    if (
      body.charCodeAt(ls) !== 96 || body.charCodeAt(ls + 1) !== 96 ||
      body.charCodeAt(ls + 2) !== 96
    ) return -1;
    let k = ls + 3;
    while (k < le && isLangChar(body.charCodeAt(k))) k++;
    const langEnd = k;
    while (k < le && (body.charCodeAt(k) === 32 || body.charCodeAt(k) === 9)) k++;
    return k === le ? langEnd : -1;
  };
  // Fence close on [ls, le): ``` + spaces/tabs only.
  const fenceClose = (ls, le) => {
    if (
      body.charCodeAt(ls) !== 96 || body.charCodeAt(ls + 1) !== 96 ||
      body.charCodeAt(ls + 2) !== 96
    ) return false;
    let k = ls + 3;
    while (k < le) {
      const c = body.charCodeAt(k);
      if (c !== 32 && c !== 9) return false;
      k++;
    }
    return true;
  };
  // Heading on [ls, le): 1-6 '#', a space/tab, non-blank text.
  // Returns [h, textStart, textEnd] (text already trimmed) or null.
  const headingOf = (ls, le) => {
    let h = 0;
    while (ls + h < le && body.charCodeAt(ls + h) === 35) h++;
    if (h < 1 || h > 6) return null;
    if (ls + h >= le) return null;
    const c = body.charCodeAt(ls + h);
    if (c !== 32 && c !== 9) return null;
    let a = ls + h;
    let b = le;
    while (a < b && (body.charCodeAt(a) === 32 || body.charCodeAt(a) === 9)) a++;
    while (b > a && (body.charCodeAt(b - 1) === 32 || body.charCodeAt(b - 1) === 9)) b--;
    if (a >= b) return null;
    return [h, a, b];
  };
  // Thematic break on [ls, le): --- or ***, then spaces/tabs only.
  const isHr = (ls, le) => {
    if (
      !(
        (body.charCodeAt(ls) === 45 && body.charCodeAt(ls + 1) === 45 && body.charCodeAt(ls + 2) === 45) ||
        (body.charCodeAt(ls) === 42 && body.charCodeAt(ls + 1) === 42 && body.charCodeAt(ls + 2) === 42)
      )
    ) return false;
    let k = ls + 3;
    while (k < le) {
      const c = body.charCodeAt(k);
      if (c !== 32 && c !== 9) return false;
      k++;
    }
    return true;
  };
  let pos = 0;
  while (pos < n) {
    const ls = pos;
    const le = lineEnd(ls);
    const next = le === n ? n : le + 1;
    if (isBlankRange(ls, le)) { pos = next; continue; }
    const c0 = body.charCodeAt(ls);
    // Fence: ``` + optional language, then spaces/tabs only.
    const langEnd = fenceLangEnd(ls, le);
    if (langEnd !== -1) {
      const lang = body.slice(ls + 3, langEnd);
      pos = next;
      let closeLs = -1;
      let p = pos;
      while (p < n) {
        const cls = p;
        const cle = lineEnd(p);
        if (fenceClose(cls, cle)) { closeLs = cls; break; }
        p = cle === n ? n : cle + 1;
      }
      let fenced;
      if (closeLs === -1) {
        fenced = body.slice(pos);
        if (fenced !== '') fenced += '\n';
        pos = n;
      } else {
        // The slice ends on the \n before the closing fence line, which is
        // the trailing \n the body lines each carry.
        fenced = body.slice(pos, closeLs);
        pos = lineEnd(closeLs) === n ? n : lineEnd(closeLs) + 1;
      }
      out.push('<pre><code' + (lang !== '' ? ' class="language-' + lang + '"' : '') + '>' + esc(fenced) + '</code></pre>\n');
      continue;
    }
    // Heading: 1-6 '#', at least one space/tab, then text.
    if (c0 === 35) {
      const hd = headingOf(ls, le);
      if (hd !== null) {
        const h = hd[0];
        const text = body.slice(hd[1], hd[2]);
        const id = uniqueHeadingSlug(text);
        const inner = renderInline(text, ctx);
        out.push('<h' + h + ' id="' + id + '">' + inner + '</h' + h + '>\n');
        if (h === 2 || h === 3) toc.push({ level: h, id, html: inner });
        pos = next;
        continue;
      }
    }
    // Thematic break: --- or ***, then spaces/tabs only.
    if (isHr(ls, le)) {
      out.push('<hr>\n');
      pos = next;
      continue;
    }
    // Blockquote: the lines opening on '>', each with the '>' and one space
    // after it dropped, then trimmed; the empty ones dropped. The rest join
    // into a single paragraph.
    if (c0 === 62) {
      const items = [];
      while (pos < n) {
        const l0 = pos;
        const l1 = lineEnd(pos);
        if (body.charCodeAt(l0) !== 62) break;
        let a = l0 + 1;
        if (a < l1 && body.charCodeAt(a) === 32) a++;
        while (a < l1 && (body.charCodeAt(a) === 32 || body.charCodeAt(a) === 9)) a++;
        let b = l1;
        while (b > a && (body.charCodeAt(b - 1) === 32 || body.charCodeAt(b - 1) === 9)) b--;
        if (a < b) items.push(body.slice(a, b));
        pos = l1 === n ? n : l1 + 1;
      }
      out.push('<blockquote>\n');
      if (items.length > 0) out.push('<p>' + renderInline(items.join('\n'), ctx) + '</p>\n');
      out.push('</blockquote>\n');
      continue;
    }
    // List: '- ', '* ' (bullet) or digits + '. ' (ordered).
    let ordered = false;
    let startNum = 0;
    let markerLen = 0;
    if ((c0 === 45 || c0 === 42) && body.charCodeAt(ls + 1) === 32) {
      markerLen = 2;
    } else if (c0 >= 48 && c0 <= 57) {
      let d = ls;
      while (d < le && body.charCodeAt(d) >= 48 && body.charCodeAt(d) <= 57) d++;
      if (d < le && body.charCodeAt(d) === 46 && body.charCodeAt(d + 1) === 32) {
        ordered = true;
        startNum = +body.slice(ls, d);
        markerLen = d - ls + 2;
      }
    }
    if (markerLen > 0) {
      const isSameKind = (l0, l1) => {
        const a = body.charCodeAt(l0);
        if (ordered) {
          if (a < 48 || a > 57) return false;
          let d = l0;
          while (d < l1 && body.charCodeAt(d) >= 48 && body.charCodeAt(d) <= 57) d++;
          return d < l1 && body.charCodeAt(d) === 46 && body.charCodeAt(d + 1) === 32;
        }
        return (a === 45 || a === 42) && body.charCodeAt(l0 + 1) === 32;
      };
      const itemMarkerLen = (l0, l1) => {
        if (ordered) {
          let d = l0;
          while (d < l1 && body.charCodeAt(d) >= 48 && body.charCodeAt(d) <= 57) d++;
          return d - l0 + 2;
        }
        return 2;
      };
      const items = [];
      let curA = ls + markerLen;
      let curB = le;
      while (curB > curA && (body.charCodeAt(curB - 1) === 32 || body.charCodeAt(curB - 1) === 9)) curB--;
      let curExtra = null;
      const pushItem = () => {
        items.push(curExtra === null ? [curA, curB] : curExtra);
      };
      pos = next;
      while (pos < n) {
        const l0 = pos;
        const l1 = lineEnd(pos);
        const nx = l1 === n ? n : l1 + 1;
        if (isSameKind(l0, l1)) {
          pushItem();
          curA = l0 + itemMarkerLen(l0, l1);
          curB = l1;
          while (curB > curA && (body.charCodeAt(curB - 1) === 32 || body.charCodeAt(curB - 1) === 9)) curB--;
          curExtra = null;
          pos = nx;
        } else if (
          l1 - l0 >= 2 && body.charCodeAt(l0) === 32 && body.charCodeAt(l0 + 1) === 32 &&
          !isBlankRange(l0, l1)
        ) {
          let a = l0;
          let b = l1;
          while (a < b && (body.charCodeAt(a) === 32 || body.charCodeAt(a) === 9)) a++;
          while (b > a && (body.charCodeAt(b - 1) === 32 || body.charCodeAt(b - 1) === 9)) b--;
          const t = body.slice(a, b);
          curExtra = (curExtra === null ? body.slice(curA, curB) : curExtra) + '\n' + t;
          pos = nx;
        } else break;
      }
      pushItem();
      out.push(ordered && startNum !== 1 ? '<ol start="' + startNum + '">\n' : ordered ? '<ol>\n' : '<ul>\n');
      for (const it of items) {
        if (typeof it === 'string') {
          out.push('<li>' + renderInline(it, ctx) + '</li>\n');
        } else {
          out.push('<li>');
          renderInlineInto(body, ctx, out, it[0], it[1]);
          out.push('</li>\n');
        }
      }
      out.push(ordered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    // Paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    let pLs = ls;
    let pLe = le;
    let pTrim = lineNeedsTrim(ls, le);
    let p = next;
    while (p < n) {
      const cls = p;
      const cle = lineEnd(p);
      if (isBlankRange(cls, cle)) break;
      const p0 = body.charCodeAt(cls);
      if (p0 === 96 && fenceLangEnd(cls, cle) !== -1) break;
      if (p0 === 35) {
        const hd = headingOf(cls, cle);
        if (hd !== null) break;
      }
      if (isHr(cls, cle)) break;
      pTrim = pTrim || lineNeedsTrim(cls, cle);
      pLe = cle;
      p = cle === n ? n : cle + 1;
    }
    pos = p;
    if (pTrim) {
      // Some line needs trimming: fall back to the trimmed-lines join.
      const lines2 = [];
      let q = pLs;
      while (q <= pLe) {
        const qe = lineEnd(q);
        lines2.push(trimST(body.slice(q, qe)));
        q = qe === n ? n + 1 : qe + 1;
      }
      const inner = renderInline(lines2.join('\n'), ctx);
      if (excerpt === '') excerpt = inner;
      out.push('<p>' + inner + '</p>\n');
    } else if (excerpt === '') {
      const tmp = [];
      renderInlineInto(body, ctx, tmp, pLs, pLe);
      excerpt = tmp.join('');
      out.push('<p>' + excerpt + '</p>\n');
    } else {
      out.push('<p>');
      renderInlineInto(body, ctx, out, pLs, pLe);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), excerpt, toc, words };
}

// ---------------------------------------------------------------- template render

function lookupPath(path, scopes, root) {
  const first = path[0];
  let val;
  let found = false;
  for (let k = scopes.length - 1; k >= 0; k--) {
    const f = scopes[k];
    if (first === 'loop') { val = f.loop; found = true; break; }
    if (first === f.name) { val = f.value; found = true; break; }
  }
  if (!found) {
    if (!Object.hasOwn(root, first)) return undefined;
    val = root[first];
  }
  for (let i = 1; i < path.length; i++) {
    if (val === null || val === undefined) return undefined;
    if (!Object.hasOwn(val, path[i])) return undefined;
    val = val[path[i]];
  }
  return val;
}

function stringForm(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += stringForm(v[i]);
    }
    return s;
  }
  return '';
}

function isTruthy(v) {
  if (v === undefined || v === null || v === false || v === '' || v === 0) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

// Constant-template analysis: a template whose output is fixed for the
// whole run — every path it can reference resolves to site/tags/recent (or
// a loop variable bound over such a path), including through includes.
// Returns Map name -> longest include chain below it (0 = no includes),
// for constant templates only. A chain makes the template uncacheable at
// depths where the depth cap would have cut its subtree.
function constTemplateInfo(templates) {
  const memo = new Map();
  const pathConst = (path, bound) => {
    const first = path[0];
    if (first === 'loop') return bound.get('loop') === true;
    if (bound.has(first)) return bound.get(first);
    return first === 'site' || first === 'tags' || first === 'recent';
  };
  const nodesConst = (nodes, bound, visiting) => {
    let chain = 0;
    for (const nd of nodes) {
      if (nd[0] === 'v') {
        if (!pathConst(nd[1], bound)) return null;
      } else if (nd[0] === 'f') {
        const pc = pathConst(nd[2], bound);
        const b2 = new Map(bound);
        b2.set(nd[1], pc);
        b2.set('loop', pc);
        const sub = nodesConst(nd[3], b2, visiting);
        if (sub === null) return null;
        if (sub > chain) chain = sub;
      } else if (nd[0] === 'i') {
        if (!pathConst(nd[1], bound)) return null;
        const a = nodesConst(nd[3], bound, visiting);
        if (a === null) return null;
        const b = nd[4] ? nodesConst(nd[4], bound, visiting) : 0;
        if (b === null) return null;
        if (a > chain) chain = a;
        if (b > chain) chain = b;
      } else if (nd[0] === 'c') {
        const sub = isConst(nd[1], visiting);
        if (sub === null) return null;
        const c = sub + 1;
        if (c > chain) chain = c;
      }
    }
    return chain;
  };
  const isConst = (name, visiting) => {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) return null;
    const tpl = templates.get(name);
    if (!tpl) return null;
    visiting.add(name);
    const chain = nodesConst(tpl, new Map(), visiting);
    visiting.delete(name);
    memo.set(name, chain);
    return chain;
  };
  const out = new Map();
  for (const name of templates.keys()) {
    const chain = isConst(name, new Set());
    if (chain !== null) out.set(name, chain);
  }
  return out;
}

function renderNodes(nodes, scopes, root, templates, depth, out, tctx) {
  for (const node of nodes) {
    const kind = node[0];
    if (kind === 't') out.push(node[1]);
    else if (kind === 'v') {
      const s = stringForm(lookupPath(node[1], scopes, root));
      out.push(node[2] ? s : esc(s));
    } else if (kind === 'f') {
      const arr = lookupPath(node[2], scopes, root);
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i++) {
          scopes.push({
            name: node[1],
            value: arr[i],
            loop: { index: i + 1, first: i === 0, last: i === arr.length - 1, length: arr.length },
          });
          renderNodes(node[3], scopes, root, templates, depth, out, tctx);
          scopes.pop();
        }
      }
    } else if (kind === 'i') {
      const t = isTruthy(lookupPath(node[1], scopes, root));
      const branch = (node[2] ? !t : t) ? node[3] : node[4];
      if (branch) renderNodes(branch, scopes, root, templates, depth, out, tctx);
    } else if (kind === 'c') {
      if (depth < 8) {
        const child = templates.get(node[1]);
        if (child) {
          // Constant includes render the same string on every page: render
          // once per run and reuse, as long as the depth cap would not have
          // cut the cached (full-depth) rendering short.
          if (tctx && tctx.info.has(node[1]) && depth + tctx.info.get(node[1]) < 8) {
            let s = tctx.cache.get(node[1]);
            if (s === undefined) {
              s = renderTemplate(child, root, templates, tctx);
              tctx.cache.set(node[1], s);
            }
            out.push(s);
          } else {
            renderNodes(child, scopes, root, templates, depth + 1, out, tctx);
          }
        }
      }
    }
  }
}

function renderTemplate(nodes, root, templates, tctx) {
  const out = [];
  renderNodes(nodes, [], root, templates, 0, out, tctx);
  return out.join('');
}

// ---------------------------------------------------------------- the build

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function run(input) {
  const site = input.site;
  const base = site.base_url.replace(/\/+$/, '');
  const slugCache = new Map();
  const slugOf = (s) => {
    let r = slugCache.get(s);
    if (r === undefined) { r = slugifyRaw(s); slugCache.set(s, r); }
    return r;
  };
  const report = new Set();

  // Sources first: files sorted by path in code-unit order.
  const files = input.files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const statics = new Set();
  const sources = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const content = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, content });
    } else {
      statics.add(f.path);
    }
  }

  // Templates, parsed in code-unit order of name.
  const templates = new Map();
  const templateNames = Object.keys(input.templates).sort();
  for (const name of templateNames) {
    const parsed = parseTemplate(input.templates[name]);
    if (parsed.error) report.add('template "' + name + '": ' + parsed.error);
    else templates.set(name, parsed.nodes);
  }
  // Constant-include cache: templates whose output is fixed for the run
  // render once and are reused on every page.
  const tctx = { info: constTemplateInfo(templates), cache: new Map() };

  // Front matter + checks, in order: front matter, directory, post date,
  // layout, draft. First failure is the one reported.
  const kept = [];
  for (const src of sources) {
    const parsed = parseFrontMatter(src.content);
    if (parsed.error) { report.add('refused ' + src.path + ': ' + parsed.error); continue; }
    const fm = parsed.fm;
    const isPost = src.path.startsWith('posts/');
    const dir = isPost ? 'posts' : dirOf(src.path);
    if (!isPost && (src.path.startsWith('tags/') || src.path.startsWith('page/'))) {
      report.add('refused ' + src.path + ': ' + dirOf(src.path) + '/ is the generator\'s own');
      continue;
    }
    if (isPost && !fm.date) { report.add('refused ' + src.path + ': a post needs a date'); continue; }
    const layout = fm.layout || (isPost ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.add('refused ' + src.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    if (fm.draft === true) { report.add('draft ' + src.path); continue; }
    kept.push({ path: src.path, fm, body: parsed.body, isPost, dir, layout });
  }

  // Permalinks: slug unique per directory in source order.
  const takenByDir = new Map();
  takenByDir.set('', new Set(['posts', 'tags', 'page']));
  const pagesBySource = new Map();
  for (const rec of kept) {
    let taken = takenByDir.get(rec.dir);
    if (!taken) { taken = new Set(); takenByDir.set(rec.dir, taken); }
    const baseSlug = rec.fm.slug || slugOf(rec.fm.title);
    let slug = baseSlug;
    let n = 2;
    while (taken.has(slug)) { slug = baseSlug + '-' + n; n++; }
    taken.add(slug);
    rec.slug = slug;
    rec.url = base + '/' + (rec.dir === '' ? '' : rec.dir + '/') + slug + '/';
    rec.outPath = (rec.dir === '' ? '' : rec.dir + '/') + slug + '/index.html';
    pagesBySource.set(rec.path, rec.url);
  }

  // Markdown for every kept source (links resolve against all pages).
  const broken = new Set();
  for (const rec of kept) {
    const ctx = {
      // Link targets resolve from the source's own directory.
      dir: dirOf(rec.path),
      dirStack: null, // split once, copied per link
      hrefs: new Map(), // target -> resolved href (same source, same result)
      pages: pagesBySource,
      statics,
      base,
      broken,
      source: rec.path,
    };
    const md = renderMarkdown(rec.body, ctx);
    rec.html = md.html;
    rec.excerpt = md.excerpt;
    rec.toc = md.toc;
    rec.words = md.words;
  }
  for (const line of broken) report.add(line);

  // Collections: posts newest date first, equal dates by slug.
  const posts = kept.filter((r) => r.isPost).sort((a, b) => {
    if (a.fm.date !== b.fm.date) return a.fm.date < b.fm.date ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  // Tags: walked in collection order, first spelling kept, ordered by count
  // desc then slug.
  const tagBySlug = new Map();
  for (const post of posts) {
    const seen = new Set();
    for (const name of post.fm.tags || []) {
      const slug = slugOf(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = tagBySlug.get(slug);
      if (!tag) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', count: 0, posts: [] };
        tagBySlug.set(slug, tag);
      }
      tag.posts.push(post);
      tag.count++;
    }
  }
  const tags = [...tagBySlug.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const tagsList = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.count }));

  // A page's tags link to the tag of the same slug (the tag's own name and
  // url), or have the url "" where no post has that tag.
  const tagLinks = (rec) => {
    const out = [];
    const seen = new Set();
    for (const name of rec.fm.tags || []) {
      const slug = slugOf(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const tag = tagBySlug.get(slug);
      out.push(tag ? { name: tag.name, slug, url: tag.url } : { name, slug, url: '' });
    }
    return out;
  };

  const cardCache = new Map();
  const cardOf = (rec) => {
    let card = cardCache.get(rec);
    if (card) return card;
    card = {
      title: rec.fm.title,
      url: rec.url,
      date: rec.fm.date || '',
      date_long: dateLong(rec.fm.date || ''),
      summary: rec.fm.summary || '',
      excerpt: rec.excerpt,
      reading_minutes: Math.max(1, Math.ceil(rec.words / 200)),
      tags: tagLinks(rec),
    };
    cardCache.set(rec, card);
    return card;
  };

  const recent = posts.slice(0, site.recent).map(cardOf);
  const siteCtx = { title: site.title, base_url: base };

  const pageObj = new Map();
  for (let i = 0; i < posts.length; i++) {
    const rec = posts[i];
    const newer = i > 0 ? posts[i - 1] : null;
    const older = i < posts.length - 1 ? posts[i + 1] : null;
    const neighbour = (p) => (p ? {
      title: p.fm.title, url: p.url, date: p.fm.date || '', date_long: dateLong(p.fm.date || ''),
    } : null);
    pageObj.set(rec, {
      ...cardOf(rec),
      slug: rec.slug,
      content: rec.html,
      toc: rec.toc,
      newer: neighbour(newer),
      older: neighbour(older),
      is_post: true,
    });
  }
  for (const rec of kept) {
    if (rec.isPost) continue;
    pageObj.set(rec, {
      ...cardOf(rec),
      slug: rec.slug,
      content: rec.html,
      toc: rec.toc,
      newer: null,
      older: null,
      is_post: false,
    });
  }

  const out = Object.create(null);
  let nPages = 0;
  let nPosts = 0;
  for (const rec of kept) {
    const nodes = templates.get(rec.layout);
    const root = { site: siteCtx, tags: tagsList, recent, page: pageObj.get(rec) };
    out[rec.outPath] = renderTemplate(nodes, root, templates, tctx);
    if (rec.isPost) nPosts++;
    else nPages++;
  }

  // Index pages through `index`, per_page posts a page, at least one.
  const perPage = site.per_page && site.per_page >= 1 ? site.per_page : 1;
  const totalPages = Math.max(1, Math.ceil(posts.length / perPage));
  const indexNodes = templates.get('index');
  if (indexNodes) {
    for (let n = 1; n <= totalPages; n++) {
      const slice = posts.slice((n - 1) * perPage, n * perPage);
      const pager = {
        number: n,
        total: totalPages,
        url: n === 1 ? base + '/' : base + '/page/' + n + '/',
        newer_url: n > 1 ? (n - 1 === 1 ? base + '/' : base + '/page/' + (n - 1) + '/') : '',
        older_url: n < totalPages ? base + '/page/' + (n + 1) + '/' : '',
      };
      const root = {
        site: siteCtx, tags: tagsList, recent,
        posts: slice.map(cardOf), pager,
      };
      out[n === 1 ? 'index.html' : 'page/' + n + '/index.html'] = renderTemplate(indexNodes, root, templates, tctx);
    }
  }

  // Tag pages through `tag`, and the tags index through `tags`.
  const tagNodes = templates.get('tag');
  if (tagNodes) {
    for (const tag of tags) {
      const root = {
        site: siteCtx, tags: tagsList, recent,
        tag: {
          name: tag.name, slug: tag.slug, url: tag.url, count: tag.count,
          posts: tag.posts.map(cardOf),
        },
      };
      out['tags/' + tag.slug + '/index.html'] = renderTemplate(tagNodes, root, templates, tctx);
    }
  }
  const tagsNodes = templates.get('tags');
  if (tagsNodes) {
    out['tags/index.html'] = renderTemplate(tagsNodes, { site: siteCtx, tags: tagsList, recent }, templates, tctx);
  }

  // Static files at their own path, unless a built page shadows one.
  let nStatics = 0;
  for (const f of files) {
    if (f.path.endsWith('.md')) continue;
    if (Object.hasOwn(out, f.path)) {
      report.add('shadowed ' + f.path + ': a built page has its path');
      continue;
    }
    out[f.path] = f.content;
    nStatics++;
  }

  const lines = [...report].sort();
  lines.push('built ' + nPages + ' pages, ' + nPosts + ' posts, ' + tags.length + ' tags and ' + nStatics + ' static files');
  out['build-report.txt'] = lines.join('\n') + '\n';
  return out;
}
