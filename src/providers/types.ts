/** Shared provider contracts. */

export interface ExecSpec {
  /** backend binary (resolved absolute path or PATH name) */
  bin: string;
  /** absolute workspace dir */
  workspace: string;
  /** full task text for this round */
  prompt: string;
  /** native session id to continue, or null to create a new session */
  nativeSessionId: string | null;
  /** MCP server name under which THIS bridge is installed on the host */
  bridgeServerName: string;
  /** bridge server command as registered (for codex inline disable override) */
  bridgeCommand: string;
  /** bridge server args[0] (script path) */
  bridgeServerArg: string;
}

export interface ExecOutcome {
  ok: boolean;
  answer: string | null;
  nativeSessionId: string | null;
  error?: string;
}

export interface HandoffEntry {
  kind: "command";
  command: string;
  note: string;
}

export interface PreparedExec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin: string | null;
}
