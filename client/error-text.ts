import { formatSchemaRefusal } from "../shared/schema-refusal";

/**
 * The board's error text: a schema refusal renders as its one-line shape
 * ("question: Too big: expected string to have <=4000 characters"), never as
 * the raw issues dump the serialised Zod error carries. Everything else keeps
 * the error's own message.
 */
export function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null && Array.isArray((error as { issues?: unknown }).issues))
    return formatSchemaRefusal(error);
  return error instanceof Error ? error.message : String(error);
}

/**
 * One board read's failure in plain words: which read failed and why. The
 * header shows this instead of the raw refusal, so an over-long record reads
 * as "Decisions failed to load: question: …", never as a schema dump.
 */
export function readErrorText(source: string, error: unknown): string {
  return `${source} failed to load: ${readErrorDetail(error)}`;
}

/**
 * A stored board error (the state's own error string) may itself be a
 * serialised schema refusal from before the header formatted refusals. Parse
 * that shape back to the one-line refusal instead of showing the raw dump.
 */
export function storedBoardErrorText(detail: string): string {
  return `Board state needs attention: ${readErrorDetail(detail)}`;
}

function readErrorDetail(error: unknown): string {
  if (typeof error === "string") {
    const trimmed = error.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        // The serialised shape is the issues array itself.
        const issues = Array.isArray(parsed) ? parsed : (parsed as { issues?: unknown }).issues;
        if (Array.isArray(issues)) return formatSchemaRefusal({ issues });
      } catch { /* not a refusal dump; show the string itself */ }
    }
    return error;
  }
  return errorText(error);
}
