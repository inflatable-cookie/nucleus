export type ActiveEditorFile = {
  projectId: string;
  resourceId: string;
  fileRef: string;
  displayPath: string;
};

let activeEditorFile: ActiveEditorFile | null = null;
let pendingReveal: ActiveEditorFile | null = null;

export function setActiveEditorFile(file: ActiveEditorFile | null): void {
  if (sameEditorFile(activeEditorFile, file)) return;
  activeEditorFile = file;
  window.dispatchEvent(new CustomEvent("nucleus:active-editor-file-changed", {
    detail: file,
  }));
}

export function getActiveEditorFile(): ActiveEditorFile | null {
  return activeEditorFile;
}

export function requestEditorFileReveal(file: ActiveEditorFile): void {
  setActiveEditorFile(file);
  pendingReveal = file;
  window.dispatchEvent(new CustomEvent("nucleus:reveal-editor-file", {
    detail: file,
  }));
}

export function consumeEditorFileReveal(): ActiveEditorFile | null {
  const reveal = pendingReveal;
  pendingReveal = null;
  return reveal;
}

function sameEditorFile(
  left: ActiveEditorFile | null,
  right: ActiveEditorFile | null,
): boolean {
  return left?.projectId === right?.projectId
    && left?.resourceId === right?.resourceId
    && left?.fileRef === right?.fileRef
    && left?.displayPath === right?.displayPath;
}
