/** Agent identity labels. Conflicting identities are never guessed. */
export type WireLabel =
  | "task"
  | "run"
  | "role"
  | "mcpBinding"
  | "mcpBindingPath"
  | "reviewer"
  | "decider";

const WIRE_KEYS = [
  "task",
  "run",
  "role",
  "mcpBinding",
  "mcpBindingPath",
  "reviewer",
  "decider",
] as const;

/** The label a live thread carries: every launch writes only `nucleus.*`. */
export function wireLabel(
  labels: Record<string, string> | null | undefined,
  key: WireLabel,
): string | undefined {
  validateWireLabels(labels);
  return labels?.[`nucleus.${key}`];
}
/**
 * The stored-history read: threads created before Nucleus keep the `northstar.*`
 * labels they were launched with, and no launch writes them any more. Only
 * archived, terminal and closed-out records take this read.
 */
export function historicalWireLabel(
  labels: Record<string, string> | null | undefined,
  key: WireLabel,
): string | undefined {
  validateWireLabels(labels);
  return labels?.[`nucleus.${key}`] ?? labels?.[`northstar.${key}`];
}
export function validateWireLabels(
  labels: Record<string, string> | null | undefined,
): void {
  for (const key of WIRE_KEYS) {
    // A retained thread carries one identity; a split one is history, never a guess.
    const current = labels?.[`nucleus.${key}`], recorded = labels?.[`northstar.${key}`];
    if (current !== undefined && recorded !== undefined && current !== recorded)
      throw new Error(`Conflicting nucleus and northstar ${key} labels`);
  }
  if (
    labels?.["nucleus.plugin"] !== undefined &&
    labels["nucleus.plugin"] !== "nucleus"
  )
    throw new Error("Invalid nucleus plugin label");
  // Threads created before Nucleus recorded the old plugin value; it stays readable.
  if (
    labels?.["northstar.plugin"] !== undefined &&
    labels["northstar.plugin"] !== "northstar-queue"
  )
    throw new Error("Invalid northstar plugin label");
}
/** The labels one launch writes: `nucleus` and its keys, nothing else. */
export function wireLabels(
  values: Partial<Record<WireLabel, string>>,
): Record<string, string> {
  const labels: Record<string, string> = { "nucleus.plugin": "nucleus" };
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) labels[`nucleus.${key}`] = value;
  return labels;
}
