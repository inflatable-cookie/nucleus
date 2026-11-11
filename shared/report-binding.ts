/** The MCP ticket path baked into a host agent record, labels, or MCP config. */
export function mcpBindingPathFromHostRecord(record: unknown): string | null {
  if (!record || typeof record !== "object") return null;
  const rec = record as Record<string, unknown>;
  if (typeof rec.mcpBindingPath === "string" && rec.mcpBindingPath) return rec.mcpBindingPath;
  const labels = rec.labels && typeof rec.labels === "object" ? rec.labels as Record<string, string> : undefined;
  // A retained thread keeps the binding path it recorded; no launch writes the old name.
  const labelled = labels?.["nucleus.mcpBindingPath"] ?? labels?.["northstar.mcpBindingPath"];
  if (labelled) return labelled;
  const config = rec.config && typeof rec.config === "object" ? rec.config as Record<string, unknown> : rec;
  const servers = config.mcpServers && typeof config.mcpServers === "object"
    ? config.mcpServers as Record<string, unknown> : null;
  if (!servers) return null;
  for (const server of Object.values(servers)) {
    if (!server || typeof server !== "object") continue;
    const args = (server as { args?: unknown }).args;
    if (!Array.isArray(args)) continue;
    const script = args.findIndex(arg => typeof arg === "string" && arg.split(/[\\/]/).pop() === "mcp-report.mjs");
    if (script >= 0 && typeof args[script + 1] === "string" && args[script + 1] !== "report")
      return args[script + 1] as string;
  }
  return null;
}
