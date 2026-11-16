/**
 * The settings domain's public surface: the capability scales, the usage and
 * grant authority, the routing explanation, the pool, the dispatch and timing
 * limits, and the two legacy key renames. This barrel keeps every import path
 * (`shared/schema/settings`) unchanged.
 */
export * from "./capability";
export * from "./usage";
export * from "./routing";
export * from "./pool";
export * from "./capacity";
export * from "./legacy";
