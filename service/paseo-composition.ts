import { paseoAdapterClass } from "../hosts/paseo";
import { HostPolicies } from "../core/host/host-policies";
import type { HostPolicyConstructor } from "../core/host";

/** Explicit composition used by isolated adapter fixtures. */
export const PaseoAdapter = paseoAdapterClass(HostPolicies as unknown as HostPolicyConstructor);
export type PaseoAdapter = InstanceType<typeof PaseoAdapter>;
export { externalWorkspaceArchivePlacement } from "../core/workspaces/external-workspace-placement";
export type { ExternalWorkspaceCatalogView } from "../core/workspaces/external-workspace-placement";
export { observationFromInventoryEntry } from "../hosts/paseo";
export type * from "../core/host";
