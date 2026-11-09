// Simple per-line syntax highlighter for diff and file rows (no multi-line state).
// Three modes: "code" (C-like, PHP, Python, shell, HCL, SQL...), "markup" (HTML,
// XML, Twig, Vue/PHP templates) and "css" (CSS, SCSS, Less, Stylus).
// Mixed files (vue, php, html) pick per line: a line starting with a tag is markup.
const kw = (s) => new Set(s.split(/\s+/).filter(Boolean));
const CAPS = /^[A-Z][A-Za-z0-9_]*$/;
const NONE = /^$/;

const JS_KW = "if else for while do switch case break continue return function class extends implements interface enum import export from as let var const static public private protected readonly abstract declare namespace module type keyof typeof instanceof in of new delete void yield async await try catch finally throw this super null undefined true false default get set satisfies";
const C_KW = "if else for while do switch case break continue return func function fn def class struct enum protocol extension interface impl trait import export from as let var const static final public private protected internal fileprivate open override init deinit guard defer try catch throw throws async await in is nil null true false self this super new typealias where some any mut pub use mod match loop type package";
const PHP_KW = "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield from true false null self parent mixed void never int float bool string iterable object TRUE FALSE NULL";
const PY_KW = "if elif else for while def class return import from as with try except finally raise pass break continue lambda None True False and or not in is yield async await global nonlocal assert del self";
const SH_KW = "if then else elif fi for while until do done case esac function in echo exit export local return set unset source alias readonly shift trap cd";
const HCL_KW = "resource data variable output module provider locals terraform backend required_providers for_each count depends_on lifecycle dynamic content for in if true false null each var local";
const SQL_KW = "select from where and or not insert into values update set delete create table alter drop index primary key foreign references join left right inner outer on as group by order having limit offset distinct union all null is in like between case when then else end exists default unique constraint begin commit rollback";
const TWIG_KW = "if elseif else endif for endfor in block endblock extends include embed endembed set endset macro endmacro import from with only and or not is defined is_granted true false null apply endapply verbatim endverbatim trans endtrans";

const code = (o) => ({ mode: "code", line: ["//"], block: true, keywords: kw(C_KW), types: CAPS, ...o });
const JS = code({ keywords: kw(JS_KW) });
const PHP = code({ line: ["//", "#"], keywords: kw(PHP_KW), vars: true, ci: true });
const PY = code({ line: ["#"], block: false, keywords: kw(PY_KW) });
const SH = code({ line: ["#"], block: false, keywords: kw(SH_KW), types: NONE, vars: true });
const HCL = code({ line: ["#", "//"], keywords: kw(HCL_KW), types: NONE });
const SQL = code({ line: ["--", "#"], keywords: kw(SQL_KW), types: NONE, ci: true });
const DATA = (line) => code({ line, block: false, keywords: kw("true false null yes no on off"), types: NONE });
const MARKUP = { mode: "markup", twig: false };
const TWIG = { mode: "markup", twig: true };
const CSS = { mode: "css", line: [] };
const SCSS = { mode: "css", line: ["//"] };

const LANGS = {
  js: JS, jsx: JS, ts: JS, tsx: JS, mjs: JS, cjs: JS, mts: JS, cts: JS,
  swift: code({}), rs: code({}), go: code({}), java: code({}), kt: code({}), kts: code({}), scala: code({}), dart: code({}),
  c: code({}), h: code({}), cc: code({}), cpp: code({}), hpp: code({}), m: code({}), cs: code({}),
  php: { ...PHP, mixed: true }, phtml: { ...PHP, mixed: true },
  py: PY, rb: code({ line: ["#"], block: false, keywords: kw("def end class module if elsif else unless while until for in do return yield begin rescue ensure raise nil true false self require include extend attr_accessor") }),
  sh: SH, bash: SH, zsh: SH, fish: SH, env: SH,
  tf: HCL, tfvars: HCL, hcl: HCL,
  sql: SQL,
  json: DATA([]), json5: DATA(["//"]), jsonc: DATA(["//"]), yml: DATA(["#"]), yaml: DATA(["#"]), toml: DATA(["#"]), ini: DATA([";", "#"]), neon: DATA(["#"]),
  html: { ...MARKUP, mixed: true, inner: JS }, htm: { ...MARKUP, mixed: true, inner: JS },
  xml: MARKUP, svg: MARKUP, xsd: MARKUP, xlf: MARKUP, plist: MARKUP,
  vue: { ...MARKUP, mixed: true, inner: JS }, svelte: { ...MARKUP, mixed: true, inner: JS },
  twig: TWIG, blade: { ...TWIG, twig: true },
  css: CSS, scss: SCSS, sass: SCSS, less: SCSS, styl: { ...SCSS, mode: "css", stylus: true },
  md: { mode: "md" }, markdown: { mode: "md" },
};
const NAMES = { Dockerfile: code({ line: ["#"], block: false, keywords: kw("FROM RUN CMD COPY ADD ENV ARG WORKDIR EXPOSE ENTRYPOINT USER VOLUME LABEL AS HEALTHCHECK"), types: NONE }), Makefile: SH, ".env": SH };

export function languageFor(path) {
  const name = (path || "").split("/").pop() || "";
  if (NAMES[name]) return NAMES[name];
  if (name.startsWith(".env")) return SH;
  if (name.endsWith(".blade.php")) return { ...TWIG, mixed: true, inner: PHP };
  if (name.endsWith(".html.twig")) return TWIG;
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return LANGS[ext] ?? null;
}

// Pieces [{text, color}] merged when neighbours share a color.
function push(out, text, color) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.color === color) last.text += text; else out.push({ text, color });
}

// Splits a line into code and comment segments, skipping markers inside quotes.
function segments(text, lang) {
  const segs = [];
  const trimmed = text.trimStart();
  if (lang.block && (trimmed.startsWith("* ") || trimmed === "*" || trimmed.startsWith("*/") || trimmed.startsWith("/**"))) {
    const end = text.indexOf("*/");
    if (end < 0) return [{ comment: true, text }];
    segs.push({ comment: true, text: text.slice(0, end + 2) });
    text = text.slice(end + 2);
  }
  let quote = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (lang.line.some((m) => text.startsWith(m, i))) {
      // "#" as a comment only where it can't be a PHP attribute (#[...]) or a CSS color.
      if (text[i] === "#" && text[i + 1] === "[") continue;
      segs.push({ text: text.slice(start, i) }, { comment: true, text: text.slice(i) });
      return segs;
    }
    if (lang.block && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      segs.push({ text: text.slice(start, i) });
      const stop = end < 0 ? text.length : end + 2;
      segs.push({ comment: true, text: text.slice(i, stop) });
      start = stop; i = stop - 1;
    }
  }
  segs.push({ text: text.slice(start) });
  return segs;
}

const CODE_TOKEN = /(\s+)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b0x[0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b)|(\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]*\}?)|(@[A-Za-z_][\w.]*)|(<\?php|<\?=|\?>)|([A-Za-z_][A-Za-z0-9_]*)|(.)/g;

function codeLine(text, lang, t, out) {
  for (const seg of segments(text, lang)) {
    if (seg.comment) { push(out, seg.text, t.dim); continue; }
    const s = seg.text;
    CODE_TOKEN.lastIndex = 0;
    let m;
    while ((m = CODE_TOKEN.exec(s))) {
      const [all, ws, str, num, variable, deco, tag, word] = m;
      let color = null;
      if (ws) color = null;
      else if (str) color = t.ansi2;
      else if (num) color = t.ansi3;
      else if (variable) color = lang.vars ? t.ansi1 : null;
      else if (deco) color = t.ansi3;
      else if (tag) color = t.ansi5;
      else if (word) {
        const prev = s[m.index - 1], next = s.slice(CODE_TOKEN.lastIndex).match(/^\s*(\(|:(?!:))/);
        if (lang.keywords.has(word) || (lang.ci && lang.keywords.has(word.toLowerCase()))) color = t.ansi5;
        else if (lang.types.test(word)) color = t.ansi6;
        else if (next?.[1] === "(") color = t.ansi4;
        else if (prev === "." || (prev === ">" && s[m.index - 2] === "-")) color = t.ansi6;
      }
      push(out, all, color);
    }
  }
}

const MARKUP_TOKEN = /(\s+)|(<!--.*?(?:-->|$)|\{#.*?(?:#\}|$))|(<\/?[A-Za-z][\w:.-]*|<!DOCTYPE|<!doctype)|(\/?>)|(\{\{-?|-?\}\}|\{%-?|-?%\})|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|([:@#]?[A-Za-z_][\w:.\-]*(?=\s*=))|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w-]*)|(&[a-z#0-9]+;)|(.)/g;

function markupLine(text, lang, t, out) {
  MARKUP_TOKEN.lastIndex = 0;
  let m, twig = false;
  while ((m = MARKUP_TOKEN.exec(text))) {
    const [all, ws, comment, tag, close, delim, str, attr, num, word, entity] = m;
    let color = null;
    if (ws) color = null;
    else if (comment) color = t.dim;
    else if (tag) color = t.ansi4;
    else if (close) color = t.ansi4;
    else if (delim) { color = t.ansi5; twig = delim.includes("{"); }
    else if (str) color = t.ansi2;
    else if (attr) color = t.ansi6;
    else if (num) color = twig ? t.ansi3 : null;
    else if (entity) color = t.ansi3;
    else if (word && twig && lang.twig && TWIG_KW_SET.has(word)) color = t.ansi5;
    else if (word && twig) color = text[MARKUP_TOKEN.lastIndex] === "(" ? t.ansi4 : t.ansi1;
    push(out, all, color);
  }
}
const TWIG_KW_SET = kw(TWIG_KW);

const CSS_TOKEN = /(\s+)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(#[0-9a-fA-F]{3,8}\b)|(-?\b\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|pt)?\b)|([$@][\w-]+)|(--[\w-]+)|(!important)|([.#&][\w-]*|::?[\w-]+)|([\w-]+(?=\s*:(?!:)))|([\w-]+(?=\())|([\w-]+)|(.)/g;

function cssLine(text, lang, t, out) {
  const decl = !/[{,]\s*$/.test(text) && /:/.test(text);
  for (const seg of segments(text, { line: lang.line, block: true })) {
    if (seg.comment) { push(out, seg.text, t.dim); continue; }
    const s = seg.text;
    CSS_TOKEN.lastIndex = 0;
    let m;
    while ((m = CSS_TOKEN.exec(s))) {
      const [all, ws, str, hex, num, at, custom, imp, sel, prop, fn] = m;
      let color = null;
      if (ws) color = null;
      else if (str) color = t.ansi2;
      else if (hex || num) color = t.ansi3;
      else if (at) color = t.ansi5;
      else if (custom) color = t.ansi6;
      else if (imp) color = t.ansi1;
      else if (sel) color = decl && sel.startsWith(":") ? null : t.ansi4;
      else if (prop) color = t.ansi6;
      else if (fn) color = t.ansi4;
      else if (lang.stylus && !decl && /^\s*[\w-]+\s+\S/.test(s) && m.index === s.search(/\S/)) color = t.ansi6;
      push(out, all, color);
    }
  }
}

function mdLine(text, t, out) {
  if (/^\s*#{1,6}\s/.test(text)) return push(out, text, t.ansi4);
  if (/^\s*```/.test(text)) return push(out, text, t.dim);
  const re = /(`[^`]*`?)|(\*\*[^*]+\*\*)|(\[[^\]]*\]\([^)]*\))|([^`*[]+|.)/g;
  let m;
  while ((m = re.exec(text))) push(out, m[0], m[1] ? t.ansi2 : m[2] ? t.ansi5 : m[3] ? t.ansi4 : null);
}

/** Returns [{text, color}] for one line; colors are theme-derived. */
export function highlight(text, lang, t) {
  if (!lang) return [{ text, color: null }];
  const out = [];
  if (lang.mode === "md") mdLine(text, t, out);
  else if (lang.mode === "css") cssLine(text, lang, t, out);
  else if (lang.mode === "markup" && lang.mixed) {
    if (/^\s*<[\/!A-Za-z]/.test(text) || /\{\{|\{%/.test(text)) markupLine(text, lang, t, out);
    else codeLine(text, lang.inner ?? JS, t, out);
  } else if (lang.mode === "markup") markupLine(text, lang, t, out);
  else if (lang.mixed && /^\s*<(?!\?)[\/!A-Za-z]/.test(text)) markupLine(text, { twig: false }, t, out);
  else codeLine(text, lang, t, out);
  return out.length ? out : [{ text: text || " ", color: null }];
}
