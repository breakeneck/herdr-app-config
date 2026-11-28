// Which Claude model a terminal runs, as the mobile app tells it: `--model X` on the claude
// command line (the foreground process first, then how the terminal started), the herdr.model
// label, else Claude Code's default from ~/.claude/settings.json. "" when it isn't Claude.
import { terminals, readTextFile, home } from "herdr";

let fallback = "opus", asked = false;
function defaultModel() {
  if (!asked) {
    asked = true;
    readTextFile(`${home()}/.claude/settings.json`).then((s) => { try { const m = JSON.parse(s ?? "{}").model; if (m) fallback = String(m); } catch {} }, () => {});
  }
  return fallback;
}
const flag = (argv) => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model" && argv[i + 1]) return argv[i + 1];
    if (String(argv[i]).startsWith("--model=")) return argv[i].slice(8);
  }
  return null;
};
const isClaude = (argv) => argv.some((a) => /(^|\/)claude$/.test(String(a)) || /(^|[\s;])claude(\s|$)/.test(String(a)));

export function modelOf(address, app) {
  if (!address) return "";
  const t = terminals().find((x) => x.address === address);
  if (!t) return "";
  const fg = t.foreground?.argv ?? [], argv = t.argv ?? [];
  const claude = app === "claude-code" || t.report?.app === "claude-code" || isClaude(fg.length ? fg : argv);
  if (!claude) return "";
  return flag(fg) ?? flag(argv) ?? t.labels?.["herdr.model"] ?? defaultModel();
}
// A model's family: fable, opus, sonnet, haiku, other.
export function family(model) {
  const m = String(model || "").toLowerCase();
  return ["fable", "opus", "sonnet", "haiku"].find((f) => m.includes(f)) || (m ? "other" : "");
}
// Fable stands out (amber), Opus is quieter (violet); the light theme gets deeper shades.
export function modelColors(dark) {
  return { fable: dark ? "#f0a020" : "#b86e00", opus: dark ? "#a78bfa" : "#6d4fd8" };
}
