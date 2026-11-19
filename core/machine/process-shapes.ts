/**
 * The program shapes every process proof reads, in one place.
 *
 * Two proofs ask what a command is — the owned-tool proof (a provider's standing
 * runtimes, an interpreter bound to one session) and the ACP task-parent
 * recognition (the ACP entry point, a session's standing MCP server) — and they
 * must answer the same way about the same command. Nothing here is a provider
 * name list: each set is a shape a program's own arguments prove.
 */

/** One command's arguments, without the quoting a shell would remove. */
export function commandArgv(command: string): string[] {
  return (
    command
      .trim()
      .match(/(?:"[^"]*"|'[^']*'|\S+)/g)
      ?.map((arg) => arg.replace(/^["']|["']$/g, "")) ?? []
  );
}

/** The program a path names, as the process table reports it. */
export function argvBase(arg: string | undefined): string | undefined {
  return arg?.split(/[\\/]/).pop();
}

/** A command chain starts at a shell, so a shell is never a runtime. */
export const SHELL_PROGRAMS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "cmd.exe",
  "powershell",
  "pwsh",
]);

/** Whether this command is a shell, so nothing beneath it is a runtime. */
export function isShellProgram(program: string | undefined): boolean {
  return !program || SHELL_PROGRAMS.has(program.toLowerCase());
}

/** Interpreters a provider ships to run the runtime scripts it keeps warm. */
export const INTERPRETER_PROGRAMS = new Set([
  "node",
  "nodejs",
  "deno",
  "bun",
  "python",
  "python3",
]);

/** The per-run report bridges Queue starts beside an agent session. */
export const REPORT_HELPER_SCRIPTS = ["mcp-report.mjs", "worker-report.mjs"];
