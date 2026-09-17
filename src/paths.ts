/**
 * Data directory layout for the bridge.
 *
 * Everything the bridge persists lives under its OWN data dir — never inside a
 * reviewed project. macOS convention: ~/Library/Application Support/<name>.
 */
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP_DIR_NAME = "agent-review-bridge";

export function dataDir(): string {
  const override = process.env.ARB_DATA_DIR?.trim();
  if (override) return override;
  return path.join(os.homedir(), "Library", "Application Support", APP_DIR_NAME);
}

export function dbPath(): string {
  return path.join(dataDir(), "state.db");
}

export function answersDir(): string {
  return path.join(dataDir(), "answers");
}

export function logsDir(): string {
  return path.join(dataDir(), "logs");
}

export function answerFileFor(discussionId: string, requestId: string): string {
  const dir = path.join(answersDir(), discussionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, `${requestId}.md`);
}

/** Inline cap for one tool result; larger answers go to a file. */
export function maxInlineBytes(): number {
  const v = Number(process.env.ARB_MAX_INLINE_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 64 * 1024;
}

export function ensureDirs(): void {
  for (const d of [dataDir(), answersDir(), logsDir()]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}
