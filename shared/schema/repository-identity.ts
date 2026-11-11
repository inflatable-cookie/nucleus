import { z } from "zod";

/**
 * The per-repository validation policy is retired (Tom, 2026-11-09, task 985):
 * the repository's AGENTS.md Validate section is the only source, and prompts
 * carry one fixed line instead of injected policy text. This constant names the
 * retired field for exactly one purpose: `repository.set` still parses it so the
 * refusal below, not a generic unrecognized-key error, can name the replacement.
 */
export const RETIRED_VALIDATION_POLICY_FIELD = "validationPolicy";

export const papercutRepositorySchema = z.object({ origin: z.string().min(1), path: z.string().min(1) }).strict();

/** Stored records keep `{origin, path}`. Callers may name a repository as that object or as the origin string `papercut.list` takes; an empty path is filled from the registered checkout. */
export const REPOSITORY_IDENTITY_SHAPE = "owner/name origin or {origin, path}";

export const repositoryIdentityInputSchema = z.union([
  z.string().trim().min(1),
  z.object({ origin: z.string().trim().min(1), path: z.string().default("") }).strict(),
], { error: `expected ${REPOSITORY_IDENTITY_SHAPE}` }).transform((value): { origin: string; path: string } =>
  typeof value === "string" ? { origin: value, path: "" } : value);

/** Copy `repository` onto `repositories` or the reverse, then drop the alias so `.strict()` still holds. */
export function aliasRepositoryField(value: unknown, canonical: "repository" | "repositories"): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const alias = canonical === "repository" ? "repositories" : "repository";
  const rec = value as Record<string, unknown>;
  if (!(alias in rec)) return value;
  const next = { ...rec };
  if (next[canonical] == null) {
    const aliased = next[alias];
    next[canonical] = canonical === "repository" && Array.isArray(aliased) ? aliased[0] : aliased;
  }
  delete next[alias];
  return next;
}
