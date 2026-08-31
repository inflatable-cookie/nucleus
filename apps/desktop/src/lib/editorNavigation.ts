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
  window.dispatchEvent(new CustomEvent<ActiveEditorFile | null>("nucleus:active-editor-file-changed", {
    detail: file,
  }));
}

export function getActiveEditorFile(): ActiveEditorFile | null {
  return activeEditorFile;
}

export function requestEditorFileReveal(file: ActiveEditorFile): void {
  setActiveEditorFile(file);
  pendingReveal = file;
  window.dispatchEvent(new CustomEvent<ActiveEditorFile>("nucleus:reveal-editor-file", {
    detail: file,
  }));
}

export function consumeEditorFileReveal(): ActiveEditorFile | null {
  const reveal = pendingReveal;
  pendingReveal = null;
  return reveal;
}

/** Narrow an `nucleus:active-editor-file-changed` listener payload; the event
 *  crosses component boundaries as an untyped DOM event, so the shape is
 *  checked rather than asserted. */
export function activeEditorFileFromEvent(event: Event): ActiveEditorFile | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (detail === null || detail === undefined || typeof detail !== "object") return null;
  const value = detail as Record<string, unknown>;
  const { projectId, resourceId, fileRef, displayPath } = value;
  if (
    typeof projectId !== "string"
    || typeof resourceId !== "string"
    || typeof fileRef !== "string"
    || typeof displayPath !== "string"
  ) return null;
  return { projectId, resourceId, fileRef, displayPath };
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
