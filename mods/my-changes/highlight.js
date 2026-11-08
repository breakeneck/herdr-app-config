// Simple per-line syntax highlighter for diff rows (no multi-line state).
const kw = (s) => new Set(s.split(" "));

const C_LIKE = {
  line: ["//"],
  keywords: kw("if else for while do switch case break continue return func function fn def class struct enum protocol extension interface impl trait import export from as let var const static final public private protected internal fileprivate open override init deinit guard defer try catch throw throws async await in is nil null true false self this super new typealias where some any mut pub use mod match loop type"),
  types: /^[A-Z][A-Za-z0-9_]*$/,
};
const LANGS = {
  swift: C_LIKE, js: C_LIKE, jsx: C_LIKE, ts: C_LIKE, tsx: C_LIKE, mjs: C_LIKE, rs: C_LIKE, go: C_LIKE,
  java: C_LIKE, kt: C_LIKE, c: C_LIKE, h: C_LIKE, cpp: C_LIKE, m: C_LIKE,
  py: { line: ["#"], keywords: kw("if elif else for while def class return import from as with try except finally raise pass break continue lambda None True False and or not in is yield async await global"), types: C_LIKE.types },
  sh: { line: ["#"], keywords: kw("if then else elif fi for while do done case esac function in echo exit export local return set unset"), types: /^$/ },
  json: { line: [], keywords: kw("true false null"), types: /^$/ },
  yml: { line: ["#"], keywords: kw("true false null"), types: /^$/ },
  yaml: { line: ["#"], keywords: kw("true false null"), types: /^$/ },
  toml: { line: ["#"], keywords: kw("true false"), types: /^$/ },
  json5: { line: ["//"], keywords: kw("true false null"), types: /^$/ },
};
LANGS.zsh = LANGS.bash = LANGS.sh;

const TOKEN = /(\s+)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b0x[0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(.)/g;

export function languageFor(path) {
  const name = (path || "").split("/").pop() || "";
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return LANGS[ext] ?? null;
}

/** Returns [{text, color}] for one line; colors are theme-derived. */
export function highlight(text, lang, t) {
  if (!lang) return [{ text, color: null }];
  let code = text, comment = "";
  // A line comment outside of strings: find the earliest marker not inside a quote.
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (lang.line.some((m) => text.startsWith(m, i))) { code = text.slice(0, i); comment = text.slice(i); break; }
  }
  const out = [];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(code))) {
    const [s, ws, str, num, word] = m;
    let color = null;
    if (ws) color = null;
    else if (str) color = t.ansi2;
    else if (num) color = t.ansi3;
    else if (word) {
      if (lang.keywords.has(word)) color = t.ansi5;
      else if (lang.types.test(word)) color = t.ansi6;
      else if (code[TOKEN.lastIndex] === "(") color = t.ansi4;
    }
    const last = out[out.length - 1];
    if (last && last.color === color) last.text += s; else out.push({ text: s, color });
  }
  if (comment) out.push({ text: comment, color: t.dim });
  return out.length ? out : [{ text: text || " ", color: null }];
}
