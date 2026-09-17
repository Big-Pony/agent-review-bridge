/**
 * CLI binary resolution that does NOT rely on the host's PATH.
 *
 * GUI-launched hosts (e.g. the ZCode desktop app) spawn MCP servers with the
 * system default PATH, which lacks ~/.local/bin — a bare `spawn("codex")`
 * then fails with ENOENT even though the user's shell finds it fine. We
 * therefore resolve each CLI explicitly: env override → PATH scan → known
 * install locations.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function resolveCliBin(name: "codex" | "claude", envOverride: string | undefined): string | null {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (p: string | undefined | null) => {
    if (p && !seen.has(p)) { seen.add(p); candidates.push(p); }
  };

  // 1) explicit override wins
  push(envOverride?.trim() || null);

  // 2) every PATH entry (works when the host itself has a sane PATH)
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir) push(path.join(dir, name));
  }

  // 3) known install locations for this machine layout
  const home = os.homedir();
  const known: Array<[string, string[]]> = [
    ["codex", [
      path.join(home, ".local/bin/codex"),
      path.join(home, ".codex/packages/standalone/current/bin/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
    ]],
    ["claude", [
      path.join(home, ".local/bin/claude"),
      path.join(home, ".local/share/claude/versions"), // versioned dir handled below
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]],
  ];
  for (const p of known.find(([n]) => n === name)![1]) push(p);

  // claude's native installer may only expose ~/.local/share/claude/versions/<ver> dirs
  if (name === "claude") {
    try {
      const versionsDir = path.join(home, ".local/share/claude/versions");
      if (existsSync(versionsDir)) {
        // pick the newest versioned executable
        const entries = readdirSync(versionsDir) as string[];
        for (const v of entries.sort().reverse()) push(path.join(versionsDir, v));
      }
    } catch { /* best-effort */ }
  }

  for (const c of candidates) {
    if (isExecutableFile(c)) return c;
  }
  return null;
}
