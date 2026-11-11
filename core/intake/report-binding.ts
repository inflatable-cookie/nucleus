export { mcpBindingPathFromHostRecord } from '../../shared/report-binding';
import {
  pathIsUnderDataHome as pathIsUnderDataHomeImpl,
  runIdMismatchRefusal as runIdMismatchRefusalImpl,
} from "../../shared/service/report-binding.mjs";

export function pathIsUnderDataHome(path: string, dataHome: string): boolean {
  return pathIsUnderDataHomeImpl(path, dataHome);
}
export function runIdMismatchRefusal(input: {
  toolName: string;
  boundRunId: string;
  namedRunId: string;
  kind: "report" | "ask" | "message";
  bindingUnderDataHome: boolean;
}): string {
  return runIdMismatchRefusalImpl(input);
}

/** Keep the retained thread, or start the role on a fresh one. Unknown path or home keeps. */
export type ReportBindingReuse = "keep" | "fresh";
export function reportBindingReuseDecision(facts: {
  bindingPath?: string | null;
  dataHome?: string | null;
}): ReportBindingReuse {
  if (!facts.bindingPath || !facts.dataHome) return "keep";
  return pathIsUnderDataHome(facts.bindingPath, facts.dataHome) ? "keep" : "fresh";
}

/** The MCP ticket path a live `node mcp-report.mjs <path>` process still holds. */
export function mcpBindingPathFromProcessCommand(command: string, bindingKey?: string): string | null {
  const args = command.trim().match(/(?:"[^"]*"|'[^']*'|\S+)/g)?.map(arg => arg.replace(/^["']|["']$/g, "")) ?? [];
  const script = args.findIndex(arg => arg.split(/[\\/]/).pop() === "mcp-report.mjs");
  if (script < 0 || script + 1 >= args.length) return null;
  const path = args[script + 1];
  if (!path || path === "report") return null;
  if (bindingKey && !path.includes(`mcp-${bindingKey}`)) return null;
  return path;
}

export function mcpBindingPathFromProcessListing(
  processes: { command: string }[] | null | undefined,
  bindingKey?: string,
): string | null {
  if (!processes?.length) return null;
  for (const process of processes) {
    const path = mcpBindingPathFromProcessCommand(process.command, bindingKey);
    if (path) return path;
  }
  return null;
}
