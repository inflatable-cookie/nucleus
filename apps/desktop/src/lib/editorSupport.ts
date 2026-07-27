import type { Extension } from "@codemirror/state";

export const SUPPORTED_EDITOR_LANGUAGES = [
  "css",
  "html",
  "javascript",
  "json",
  "markdown",
  "rust",
  "typescript",
] as const;

export type EditorFileSwitchAdmission = "confirm" | "ignore" | "open";
export type ExternalEditorFileAction = "ignore" | "preserve_buffer" | "reload";

export function filterEditorFiles<T extends { display_path: string }>(
  files: readonly T[],
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return normalizedQuery
    ? files.filter((file) => file.display_path.toLocaleLowerCase().includes(normalizedQuery))
    : [...files];
}

export function admitEditorFileSwitch(
  currentFileRef: string | undefined,
  requestedFileRef: string,
  dirty: boolean,
): EditorFileSwitchAdmission {
  if (!requestedFileRef || requestedFileRef === currentFileRef) return "ignore";
  return dirty ? "confirm" : "open";
}

export function isEditorFileConflict(message: string | null): boolean {
  return message?.toLocaleLowerCase().includes("editor file conflict") ?? false;
}

export function editorFileWatchTouchesPath(
  changedPaths: readonly string[],
  displayPath: string,
): boolean {
  const target = normalizeDisplayPath(displayPath);
  return changedPaths.some((path) => {
    const changed = normalizeDisplayPath(path);
    return changed === "" || changed === target || target.startsWith(`${changed}/`);
  });
}

export function classifyExternalEditorFileChange(
  baselineRevision: string,
  baselineContent: string,
  buffer: string,
  diskRevision: string,
): ExternalEditorFileAction {
  if (diskRevision === baselineRevision) return "ignore";
  return buffer === baselineContent ? "reload" : "preserve_buffer";
}

export type EditorDraftRecovery = "discard" | "restore" | "conflict";

export function classifyEditorDraftRecovery(
  baseRevision: string,
  baseContent: string,
  draftContent: string,
  diskRevision: string,
  diskContent: string,
): EditorDraftRecovery {
  if (draftContent === baseContent || draftContent === diskContent) {
    return "discard";
  }
  return baseRevision === diskRevision ? "restore" : "conflict";
}

export function isSupportedEditorLanguage(languageHint: string): boolean {
  return (SUPPORTED_EDITOR_LANGUAGES as readonly string[]).includes(languageHint);
}

function normalizeDisplayPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

export async function loadEditorLanguage(languageHint: string): Promise<Extension> {
  switch (languageHint) {
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    default:
      return [];
  }
}
