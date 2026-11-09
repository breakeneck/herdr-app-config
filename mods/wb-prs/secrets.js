// Tokens (Jira, Trello, GitLab): kept in the macOS Keychain through `security`, as generic
// passwords (service = herdr-jira / herdr-trello / herdr-gitlab, account = the mod's id).
// Other systems aren't supported yet: getSecret answers null, setSecret throws UNSUPPORTED, and
// panels show UNSUPPORTED instead of a token form. Secrets are never written to a file or logged.
// SAME FILE in every mod that uses it. The canonical copy is mods/wb-tasks/secrets.js:
// edit it there, then run `scripts/sync-helpers.sh --write` to copy it over the others.
//
// ponytail: `exec` has no stdin, and `security add-generic-password -w` without a value prompts on a
// tty a mod doesn't have, so the secret is passed as the argument after -w: it is in `security`'s
// argv for the moment it runs (visible to local `ps` only). Reads come back on stdout, never argv.

import { exec, window } from "herdr";

export const UNSUPPORTED = "Saving tokens needs the macOS Keychain; other systems aren't supported yet.";

// True on macOS (the Keychain is always this computer's: exec runs locally). Sync, so render can ask.
export function supported() {
  try { return window().platform === "macos"; } catch { return false; }
}

// The secret saved for service + account, or null (none saved, or not supported here).
export async function getSecret(service, account) {
  if (!supported()) return null;
  const r = await exec("security", ["find-generic-password", "-s", service, "-a", account, "-w"]).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() || null : null;
}

// The first item saved for a service, whatever its account: { account, secret }, or null.
// For migrating the first builds, which named the account differently.
export async function findSecret(service) {
  if (!supported()) return null;
  const [item, secret] = await Promise.all([
    exec("security", ["find-generic-password", "-s", service]).catch(() => null),
    exec("security", ["find-generic-password", "-s", service, "-w"]).catch(() => null),
  ]);
  const account = /"acct"<blob>="([^"]*)"/.exec(item?.stdout ?? "")?.[1];
  return account && secret?.code === 0 ? { account, secret: secret.stdout.trim() } : null;
}

// Saves (or replaces) the secret. Throws Error(UNSUPPORTED) off macOS, "Keychain: …" if it failed.
export async function setSecret(service, account, value) {
  if (!supported()) throw new Error(UNSUPPORTED);
  const r = await exec("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w", value]);
  if (r.code !== 0) throw new Error(`Keychain: ${(r.stderr || r.stdout).trim()}`);
}

// Removes the secret; true if one was removed.
export async function deleteSecret(service, account) {
  if (!supported()) return false;
  const r = await exec("security", ["delete-generic-password", "-s", service, "-a", account]).catch(() => null);
  return r?.code === 0;
}
