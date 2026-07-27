import { invoke } from "@tauri-apps/api/core";

export type ScmWorkingCopyInspectionRequest = {
  project_id: string;
  resource_id: string;
};

export type ScmWorkingCopyChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "type_changed"
  | "unknown";

export type ScmWorkingCopyFileStatus = {
  path: string;
  original_path: string | null;
  index_status: string;
  worktree_status: string;
  change_kind: ScmWorkingCopyChangeKind;
  staged: boolean;
  unstaged: boolean;
  file_ref: string | null;
};

export type ScmWorkingCopyInspection = {
  project_id: string;
  resource_id: string;
  state: "ready" | "unavailable";
  branch: string | null;
  upstream: string | null;
  head_oid: string | null;
  ahead: number;
  behind: number;
  files: ScmWorkingCopyFileStatus[];
  status_fingerprint: string | null;
  error: string | null;
};

export type ScmWorkingCopyDiffScope = "all" | "staged" | "working";

export type ScmWorkingCopyDiffRequest = {
  project_id: string;
  resource_id: string;
  path: string;
  scope: ScmWorkingCopyDiffScope;
};

export type ScmWorkingCopyDiff = {
  project_id: string;
  resource_id: string;
  path: string;
  original_path: string | null;
  change_kind: ScmWorkingCopyChangeKind;
  staged: boolean;
  unstaged: boolean;
  file_ref: string | null;
  patch: string | null;
  additions: number;
  deletions: number;
  notice: string | null;
};

export type ScmWorkingCopyMutationAction = "stage" | "unstage";

export type ScmWorkingCopyMutationRequest = {
  project_id: string;
  resource_id: string;
  action: ScmWorkingCopyMutationAction;
  paths: string[];
  expected_status_fingerprint: string;
  idempotency_key: string;
};

export type ScmWorkingCopyMutationReceipt = {
  schema_version: number;
  receipt_id: string;
  project_id: string;
  resource_id: string;
  action: ScmWorkingCopyMutationAction;
  paths: string[];
  expected_status_fingerprint: string;
  before_status_fingerprint: string;
  after_status_fingerprint: string;
  idempotency_key: string;
  request_fingerprint: string;
  operator_ref: string;
  execution_host_ref: string;
  replayed: boolean;
};

export type ScmWorkingCopyMutationResult = {
  receipt: ScmWorkingCopyMutationReceipt;
  inspection: ScmWorkingCopyInspection;
};

export type ScmWorkingCopyCommitRequest = {
  project_id: string;
  resource_id: string;
  message: string;
  expected_status_fingerprint: string;
  idempotency_key: string;
};

export type ScmWorkingCopyCommitReceipt = {
  schema_version: number;
  receipt_id: string;
  project_id: string;
  resource_id: string;
  staged_paths: string[];
  message_digest: string;
  expected_status_fingerprint: string;
  before_status_fingerprint: string;
  after_status_fingerprint: string;
  previous_head_oid: string | null;
  commit_oid: string;
  idempotency_key: string;
  request_fingerprint: string;
  operator_ref: string;
  execution_host_ref: string;
  replayed: boolean;
};

export type ScmWorkingCopyCommitResult = {
  receipt: ScmWorkingCopyCommitReceipt;
  inspection: ScmWorkingCopyInspection;
};

export function inspectScmWorkingCopies(
  requests: ScmWorkingCopyInspectionRequest[],
): Promise<ScmWorkingCopyInspection[]> {
  return invoke<ScmWorkingCopyInspection[]>("inspect_scm_working_copies", { requests });
}

export function readScmWorkingCopyDiff(
  request: ScmWorkingCopyDiffRequest,
): Promise<ScmWorkingCopyDiff> {
  return invoke<ScmWorkingCopyDiff>("read_scm_working_copy_diff_command", { request });
}

export function mutateScmWorkingCopy(
  request: ScmWorkingCopyMutationRequest,
): Promise<ScmWorkingCopyMutationResult> {
  return invoke<ScmWorkingCopyMutationResult>("mutate_scm_working_copy_command", { request });
}

export function commitScmWorkingCopy(
  request: ScmWorkingCopyCommitRequest,
): Promise<ScmWorkingCopyCommitResult> {
  return invoke<ScmWorkingCopyCommitResult>("commit_scm_working_copy_command", { request });
}
