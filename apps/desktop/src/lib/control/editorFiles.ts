import { invoke } from "@tauri-apps/api/core";

export type EditorFileEntry = {
  file_ref: string;
  display_path: string;
  language_hint: string;
  byte_size: number;
  writable: boolean;
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
  expected_content_revision: string;
  content: string;
};

export function listEditorFiles(
  projectId: string,
  resourceId: string | null,
): Promise<EditorFileEntry[]> {
  return invoke<EditorFileEntry[]>("list_editor_files", { projectId, resourceId });
}

export function readEditorFile(
  projectId: string,
  resourceId: string | null,
  fileRef: string,
): Promise<EditorFileSnapshot> {
  return invoke<EditorFileSnapshot>("read_editor_file", { projectId, resourceId, fileRef });
}

export function saveEditorFile(request: EditorFileSaveRequest): Promise<EditorFileSnapshot> {
  return invoke<EditorFileSnapshot>("save_editor_file", { request });
}
