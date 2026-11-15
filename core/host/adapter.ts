import type { RunUsageSource } from './types';
import type { HostAdapterIdentity } from './contract/identity';
import type { AgentObservation, HostObservation } from './contract/observation';
import type { HostRunCreation } from './contract/run-creation';
import type { HostThreadPresentation } from './contract/thread-presentation';
import type { HostThreads } from './contract/threads';
import type { HostWorkspaces } from './contract/workspaces';
import type { HostDelivery } from './contract/delivery';
import type { HostNativeQuestions } from './contract/questions';
import type { HostForgeReads } from './contract/forge';
import type { HostWorkspaceArchive } from './contract/workspace-archive';

export type { OriginAgent } from './contract/identity';
export type { AgentObservation } from './contract/observation';
export type { ExternalWorkspacePlacement, ExternalWorktreeSource, ExternalWorkspaceCatalogEntry, ExternalWorkspaceCatalog, ExternalWorkspaceSourceExpectation, ExternalWorkspaceArchiveInput, ExternalWorkspaceArchiveOutcome } from './contract/workspace-archive';

/**
 * The host adapter contract: one composed interface over the capability groups
 * a host integration supplies, so a reader finds the group it needs (identity,
 * observation, run creation, thread presentation, threads, workspaces,
 * delivery, native questions, forge reads, workspace archive) instead of one
 * flat list of optional members. `shared/host.ts` remains the host-neutral
 * `Host` contract this adapter is bridged to by `HostFacade`; both declare the
 * same capabilities today, and this one is the adapter-side surface the engine
 * calls.
 */
export interface Adapter extends RunUsageSource, HostAdapterIdentity, HostObservation, HostRunCreation,
  HostThreadPresentation, HostThreads, HostWorkspaces, HostDelivery, HostNativeQuestions, HostForgeReads,
  HostWorkspaceArchive {
  /** Host-neutral connection probe used by runtime lifecycle owners. */
  isConnected?(): boolean;
}
