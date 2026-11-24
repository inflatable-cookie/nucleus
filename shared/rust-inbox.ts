import { z } from "zod";

export const RUST_INBOX_PREFIX = "rust-inbox:";
export const RUST_INBOX_PATH = "/api/internal/rust-inbox";
export const rustInboxEnginePattern = /^[a-z0-9-]{1,48}$/;
export const rustInboxDecisionId = z.string().regex(/^rust-inbox:[a-z0-9-]{1,48}:[a-zA-Z0-9-]{1,64}:[1-9][0-9]{0,18}$/);
export const RUST_INBOX_ACCEPT = "Accept merge";
export const RUST_INBOX_DECLINE = "Decline";

export const rustInboxRequest = z.object({
  operation: z.enum(["ensure", "withdraw"]),
  id: rustInboxDecisionId,
  repository: z.string().max(240).regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  reference: z.string().trim().min(1).max(160),
  head: z.string().regex(/^[0-9a-f]{40}$/),
}).strict();
export type RustInboxRequest = z.infer<typeof rustInboxRequest>;

export const rustInboxReply = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.literal("accepted"), actor: z.string(), reason: z.string() }).strict(),
  z.object({ state: z.literal("declined") }).strict(),
  z.object({ state: z.literal("withdrawn") }).strict(),
]);
export type RustInboxReply = z.infer<typeof rustInboxReply>;
