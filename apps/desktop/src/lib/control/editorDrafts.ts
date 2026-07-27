import { invoke } from "@tauri-apps/api/core";
import type { EditorFileSnapshot } from "./editorFiles";

export type EditorDraftDto = {
  schema_version: 1;
  snapshot: EditorFileSnapshot;
  content: string;
};

export function loadEditorDraft(
  projectId: string,
  resourceId: string,
  fileRef: string,
): Promise<EditorDraftDto | null> {
  return invoke<EditorDraftDto | null>("editor_draft_load", {
    projectId,
    resourceId,
    fileRef,
  });
}

export function saveEditorDraft(draft: EditorDraftDto): Promise<void> {
  return invoke<void>("editor_draft_save", { draft });
}

export function deleteEditorDraft(
  projectId: string,
  resourceId: string,
  fileRef: string,
): Promise<void> {
  return invoke<void>("editor_draft_delete", {
    projectId,
    resourceId,
    fileRef,
  });
}
