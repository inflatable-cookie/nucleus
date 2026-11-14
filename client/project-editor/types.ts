import type { Project, ProjectOwnerCandidateKind, ProjectMergeCheck, ProjectMergeInput, ProjectMergeResult, ProjectRemovalBlocker, ProjectRemoveRepositoryInput, ProjectSettings, ProjectSettingsRow, ProjectUpsertInput, RepositorySetInput } from "../../shared/contracts";
import type { ProjectManagementApi } from "../project-management-view";

export type OwnerCandidate = { id: string; title: string; workspaceId: string | null; kind: ProjectOwnerCandidateKind };
export type ProjectEditActions = {
  saveProject: (input: ProjectUpsertInput) => Promise<Project>;
  setPlanner: (input: { key: string; agentId: string | null }) => Promise<Project>;
  /** Task 1110: register a chosen live thread, or remove one named agent. */
  registerAgent: (input: { project: string; name: string; purpose: string; agentId: string }) => Promise<Project>;
  unregisterAgent: (input: { project: string; name: string }) => Promise<Project>;
  /** Null clears the override: the project inherits Per project again. */
  setSlots: (input: { projectKey: string; limit: number | null }) => Promise<unknown>;
  setRepository: (input: RepositorySetInput) => Promise<unknown>;
  park: (input: { key: string; version: number }) => Promise<Project>;
  unpark: (input: { key: string; version: number }) => Promise<Project>;
  /** One member's removal blockers (`project.removal-blockers` with `repository`). */
  repositoryBlockers: (input: { key: string; repository: string }) => Promise<ProjectRemovalBlocker[]>;
  /** Remove from Nucleus: out of the project and its one-repository project deleted, in one server step. */
  removeRepository: (input: ProjectRemoveRepositoryInput) => Promise<{ project: Project; tombstone: unknown }>;
  /** What stops a project moving into another, and what comes along (`project.merge-check`, nucleus#984). */
  mergeCheck: (input: { source: string }) => Promise<ProjectMergeCheck>;
  /** Move into, and Add repository from another project: one server step (`project.merge`). */
  merge: (input: ProjectMergeInput) => Promise<ProjectMergeResult>;
  /** Remove's preview, cancellation and delete calls; without them the trash icon is absent. */
  removal?: ProjectManagementApi;
  /** Re-read `project.settings` (and the board) after a batch of writes. */
  refresh: () => Promise<unknown>;
  candidates: { data: OwnerCandidate[] | undefined; error: unknown; isPending: boolean };
};
export type SaveOp = { run: () => Promise<unknown>; revert?: () => void };
export type ProjectSaves = ReturnType<typeof import("./save-state").useProjectSaves>;
