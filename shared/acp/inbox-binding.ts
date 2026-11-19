/** Authenticated, decision-only ACP session for one host's Nucleus inbox. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

export const ACP_INBOX_FORMAT = "nucleus.acp.inbox";
export const acpInboxHostSchema = z.string().regex(/^t3code:[A-Za-z0-9_-]{1,180}$/);
export const acpInboxBindingSchema = z.object({
  format: z.literal(ACP_INBOX_FORMAT),
  version: z.literal(1),
  kind: z.literal("inbox"),
  hostId: acpInboxHostSchema,
  sessionId: z.string().uuid(),
  socketPath: z.string().min(1),
  token: z.string().min(1),
  ignorePattern: z.string().min(1).max(400).optional(),
  holdPattern: z.string().min(1).max(400).optional(),
}).strict();
export type AcpInboxBinding = z.infer<typeof acpInboxBindingSchema>;

export const acpInboxRecordSchema = acpInboxBindingSchema.omit({ socketPath: true, token: true, ignorePattern: true, holdPattern: true }).extend({
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

/** The host id is hashed for paths; a remote host cannot choose a filesystem path. */
const hostKey = (hostId: string): string => createHash("sha256").update(acpInboxHostSchema.parse(hostId)).digest("hex");
export const acpInboxDirectory = (dataHome: string, hostId: string): string => join(dataHome, "t3-inbox", hostKey(hostId));
export const acpInboxRecordPath = (dataHome: string, hostId: string): string => join(dataHome, "acp", "inboxes", `${hostKey(hostId)}.json`);
