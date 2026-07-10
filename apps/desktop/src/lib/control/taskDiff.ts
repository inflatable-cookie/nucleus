import { invoke } from "@tauri-apps/api/core";

export type TaskDiffOverviewRequest = {
  project_id: string;
  task_id: string;
  work_item_id: string;
  diff_id: string;
};

export type TaskDiffFilePatchRequest = TaskDiffOverviewRequest & {
  file_ref: string;
};

export type TaskDiffCounts = {
  added: number;
  modified: number;
  deleted: number;
  metadata_only: number;
};

export type TaskDiffFile = {
  file_ref: string;
  display_path: string;
  change_kind: "added" | "modified" | "deleted" | "metadata_only";
};

export type TaskDiffOverview = {
  diff_id: string;
  summary: string;
  counts: TaskDiffCounts;
  coverage: "complete" | "partial" | "unavailable";
  truncated: boolean;
  attribution_notice: string | null;
  files: TaskDiffFile[];
};

export type TaskDiffFilePatch = {
  diff_id: string;
  file_ref: string;
  display_path: string;
  change_kind: TaskDiffFile["change_kind"];
  state:
    | "available"
    | "truncated"
    | "binary"
    | "oversized"
    | "missing"
    | "expired"
    | "partial";
  patch: string | null;
  additions: number;
  deletions: number;
  truncated: boolean;
  coverage: TaskDiffOverview["coverage"];
  attribution_notice: string | null;
};

export function readTaskDiffOverview(
  request: TaskDiffOverviewRequest,
): Promise<TaskDiffOverview> {
  return invoke<TaskDiffOverview>("read_task_diff_overview", { request });
}

export function readTaskDiffFilePatch(
  request: TaskDiffFilePatchRequest,
): Promise<TaskDiffFilePatch> {
  return invoke<TaskDiffFilePatch>("read_task_diff_file_patch", { request });
}
