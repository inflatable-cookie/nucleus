/** Agent identity labels. Conflicting identities are never guessed. */
export type WireLabel =
  | "task"
  | "run"
  | "role"
  | "mcpBinding"
  | "mcpBindingPath"
  | "reviewer"
  | "decider";

/** Canonical stored keys shared by every host adapter and launch path. */
export const WIRE_LABEL_KEYS: Readonly<Record<WireLabel, `nucleus.${WireLabel}`>> = {
  task: "nucleus.task",
  run: "nucleus.run",
  role: "nucleus.role",
  mcpBinding: "nucleus.mcpBinding",
  mcpBindingPath: "nucleus.mcpBindingPath",
  reviewer: "nucleus.reviewer",
  decider: "nucleus.decider",
};
export const WIRE_PLUGIN_LABEL_KEY = "nucleus.plugin" as const;
const WIRE_KEYS = Object.keys(WIRE_LABEL_KEYS) as WireLabel[];

/** The label a live thread carries: every launch writes only `nucleus.*`. */
export function wireLabel(
  labels: Record<string, string> | null | undefined,
  key: WireLabel,
): string | undefined {
  validateWireLabels(labels);
  return labels?.[WIRE_LABEL_KEYS[key]];
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
  return labels?.[WIRE_LABEL_KEYS[key]] ?? labels?.[`northstar.${key}`];
}
export function validateWireLabels(
  labels: Record<string, string> | null | undefined,
): void {
  for (const key of WIRE_KEYS) {
    // A retained thread carries one identity; a split one is history, never a guess.
    const current = labels?.[WIRE_LABEL_KEYS[key]], recorded = labels?.[`northstar.${key}`];
    if (current !== undefined && recorded !== undefined && current !== recorded)
      throw new Error(`Conflicting nucleus and northstar ${key} labels`);
  }
  if (
    labels?.[WIRE_PLUGIN_LABEL_KEY] !== undefined &&
    labels[WIRE_PLUGIN_LABEL_KEY] !== "nucleus"
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
  const labels: Record<string, string> = { [WIRE_PLUGIN_LABEL_KEY]: "nucleus" };
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) labels[WIRE_LABEL_KEYS[key as WireLabel]] = value;
  return labels;
}
