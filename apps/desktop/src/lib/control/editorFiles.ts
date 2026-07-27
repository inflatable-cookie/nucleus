import { invoke } from "@tauri-apps/api/core";

export type EditorFileEntry = {
  file_ref: string;
  display_path: string;
  language_hint: string;
  byte_size: number;
  writable: boolean;
};

export type EditorDirectoryEntry = {
  name: string;
  display_path: string;
  kind: "directory" | "file";
  file?: EditorFileEntry;
};

export type EditorFileSnapshot = EditorFileEntry & {
  project_id: string;
  resource_id: string;
  content: string;
  content_revision: string;
};

export type EditorFileSaveRequest = {
  project_id: string;
  resource_id: string | null;
  file_ref: string;
  display_path: string | null;
  expected_content_revision: string;
  content: string;
};

export type EditorFileCreateRequest = {
  project_id: string;
  resource_id: string | null;
  display_path: string;
  content: string;
};

export type EditorFileRenameRequest = {
  project_id: string;
  resource_id: string | null;
  file_ref: string;
  display_path: string;
  target_display_path: string;
};

export type EditorFileDeleteRequest = {
  project_id: string;
  resource_id: string | null;
  file_ref: string;
  display_path: string;
};

export type EditorFileDeleteReceipt = {
  project_id: string;
  resource_id: string;
  file_ref: string;
  display_path: string;
};

export type EditorDirectoryCreateRequest = {
  project_id: string;
  resource_id: string | null;
  display_path: string;
};

export type EditorDirectoryRenameRequest = EditorDirectoryCreateRequest & {
  target_display_path: string;
};

export type EditorDirectoryDeleteRequest = EditorDirectoryCreateRequest;

export type EditorDirectoryReceipt = {
  project_id: string;
  resource_id: string;
  display_path: string;
};

export type EditorFileMoveReceipt = {
  file_ref: string;
  display_path: string;
  target_file_ref: string;
  target_display_path: string;
  language_hint: string;
};

export type EditorDirectoryRenameReceipt = EditorDirectoryReceipt & {
  target_display_path: string;
  files: EditorFileMoveReceipt[];
};

export type EditorDirectoryDeleteReceipt = EditorDirectoryReceipt & {
  files: EditorFileDeleteReceipt[];
};

export function listEditorFiles(
  projectId: string,
  resourceId: string | null,
): Promise<EditorFileEntry[]> {
  return invoke<EditorFileEntry[]>("list_editor_files", { projectId, resourceId });
}

export function searchEditorFiles(
  projectId: string,
  resourceId: string | null,
  query: string,
  limit = 100,
): Promise<EditorFileEntry[]> {
  return invoke<EditorFileEntry[]>("search_editor_files", {
    projectId,
    resourceId,
    query,
    limit,
  });
}

export function listEditorDirectory(
  projectId: string,
  resourceId: string | null,
  directoryPath: string | null,
): Promise<EditorDirectoryEntry[]> {
  return invoke<EditorDirectoryEntry[]>("list_editor_directory", {
    projectId,
    resourceId,
    directoryPath,
  });
}

export function readEditorFile(
  projectId: string,
  resourceId: string | null,
  fileRef: string,
  displayPath: string | null = null,
): Promise<EditorFileSnapshot> {
  return invoke<EditorFileSnapshot>("read_editor_file", {
    projectId,
    resourceId,
    fileRef,
    displayPath,
  });
}

export function saveEditorFile(request: EditorFileSaveRequest): Promise<EditorFileSnapshot> {
  return invoke<EditorFileSnapshot>("save_editor_file", { request });
}

export function createEditorFile(
  request: EditorFileCreateRequest,
): Promise<EditorFileSnapshot> {
  return invoke<EditorFileSnapshot>("create_editor_file", { request });
}

export function renameEditorFile(
  request: EditorFileRenameRequest,
): Promise<EditorFileSnapshot> {
  return invoke<EditorFileSnapshot>("rename_editor_file", { request });
}

export function deleteEditorFile(
  request: EditorFileDeleteRequest,
): Promise<EditorFileDeleteReceipt> {
  return invoke<EditorFileDeleteReceipt>("delete_editor_file", { request });
}

export function createEditorDirectory(
  request: EditorDirectoryCreateRequest,
): Promise<EditorDirectoryReceipt> {
  return invoke<EditorDirectoryReceipt>("create_editor_directory", { request });
}

export function renameEditorDirectory(
  request: EditorDirectoryRenameRequest,
): Promise<EditorDirectoryRenameReceipt> {
  return invoke<EditorDirectoryRenameReceipt>("rename_editor_directory", { request });
}

export function deleteEditorDirectory(
  request: EditorDirectoryDeleteRequest,
): Promise<EditorDirectoryDeleteReceipt> {
  return invoke<EditorDirectoryDeleteReceipt>("delete_editor_directory", { request });
}
