/**
 * Host-run env retention rule (Spec 035): durable records keep env key names
 * only. Values live in one ephemeral launch file per unlaunched run. This is
 * the defensive net for every persisted write of request or submission data.
 */

export const HOST_RUN_REDACTED = "[redacted]";

const SECRET_KEY = /(TOKEN|PASSWORD|PASSWD|SECRET|KEY|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;

export const isSecretShapedKey = (name: string): boolean => SECRET_KEY.test(name);

/** Sorted, de-duplicated env key names. */
export function hostRunEnvKeys(env: Record<string, unknown> | null | undefined): string[] {
  return Object.keys(env ?? {}).sort();
}

/**
 * Deep copy with every `env` record reduced to `envKeys` and every other
 * secret-shaped string value replaced by a fixed marker. Idempotent.
 */
export function redactHostRunData<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  const source = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(source)) {
    if (key === "env" && item !== null && typeof item === "object" && !Array.isArray(item)) {
      const keys = new Set(hostRunEnvKeys(item as Record<string, unknown>));
      for (const name of Array.isArray(source.envKeys) ? source.envKeys as string[] : []) keys.add(String(name));
      out.envKeys = [...keys].sort();
      continue;
    }
    if (key === "envKeys" && "env" in source) continue; // merged above
    out[key] = typeof item === "string" && isSecretShapedKey(key) ? HOST_RUN_REDACTED : redact(item);
  }
  return out;
}
