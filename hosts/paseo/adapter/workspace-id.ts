import { randomBytes } from 'node:crypto';
import { WorkspaceCreateRequestSchema } from '@getpaseo/protocol/messages';

/**
 * Paseo's caller-selected workspace IDs live in its own namespace. The installed
 * protocol validates `workspace.create.request` before the client sends it, so
 * an ID outside the namespace is refused locally and never reaches the daemon.
 */
export const newPaseoWorkspaceId = (): string => `wks_${randomBytes(8).toString('hex')}`;
/** The installed protocol's own field check; the field is optional, so absence never counts as accepted. */
export const paseoWorkspaceIdAccepted = (id: unknown): boolean =>
  typeof id === 'string' && WorkspaceCreateRequestSchema.shape.workspaceId.safeParse(id).success;
