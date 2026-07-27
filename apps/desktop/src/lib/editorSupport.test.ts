import { describe, expect, test } from "bun:test";
import {
  admitEditorFileSwitch,
  classifyExternalEditorFileChange,
  classifyEditorDraftRecovery,
  editorFileWatchTouchesPath,
  filterEditorFiles,
  isEditorFileConflict,
  isSupportedEditorLanguage,
  loadEditorLanguage,
} from "./editorSupport";

describe("editor support", () => {
  test("filters admitted paths without changing host results", () => {
    const files = [{ display_path: "src/App.svelte" }, { display_path: "README.md" }];

    expect(filterEditorFiles(files, " app ")).toEqual([{ display_path: "src/App.svelte" }]);
    expect(filterEditorFiles(files, "MD")).toEqual([{ display_path: "README.md" }]);
    expect(files).toHaveLength(2);
  });

  test("requires confirmation only when a dirty buffer would be replaced", () => {
    expect(admitEditorFileSwitch("current", "current", true)).toBe("ignore");
    expect(admitEditorFileSwitch("current", "next", false)).toBe("open");
    expect(admitEditorFileSwitch("current", "next", true)).toBe("confirm");
  });

  test("falls back to plain text for unknown host hints", async () => {
    expect(isSupportedEditorLanguage("rust")).toBe(true);
    expect(isSupportedEditorLanguage("toml")).toBe(false);
    expect(await loadEditorLanguage("toml")).toEqual([]);
  });

  test("recognizes only the host stale-write conflict", () => {
    expect(isEditorFileConflict("editor file conflict: content changed since it was opened")).toBe(true);
    expect(isEditorFileConflict("editor file read failed")).toBe(false);
  });

  test("matches exact files and changed parent directories", () => {
    expect(editorFileWatchTouchesPath(["src/lib.rs"], "src/lib.rs")).toBe(true);
    expect(editorFileWatchTouchesPath(["src"], "src/nested/lib.rs")).toBe(true);
    expect(editorFileWatchTouchesPath([""], "src/lib.rs")).toBe(true);
    expect(editorFileWatchTouchesPath(["README.md"], "src/lib.rs")).toBe(false);
    expect(editorFileWatchTouchesPath(["source"], "src/lib.rs")).toBe(false);
  });

  test("reloads clean buffers and preserves dirty ones", () => {
    expect(classifyExternalEditorFileChange("rev:one", "base", "base", "rev:two"))
      .toBe("reload");
    expect(classifyExternalEditorFileChange("rev:one", "base", "edited", "rev:two"))
      .toBe("preserve_buffer");
    expect(classifyExternalEditorFileChange("rev:one", "base", "edited", "rev:one"))
      .toBe("ignore");
  });

  test("restores drafts only against their original disk revision", () => {
    expect(classifyEditorDraftRecovery("rev:1", "base", "draft", "rev:1", "base"))
      .toBe("restore");
    expect(classifyEditorDraftRecovery("rev:1", "base", "draft", "rev:2", "disk"))
      .toBe("conflict");
    expect(classifyEditorDraftRecovery("rev:1", "base", "base", "rev:1", "base"))
      .toBe("discard");
    expect(classifyEditorDraftRecovery("rev:1", "base", "disk", "rev:2", "disk"))
      .toBe("discard");
  });
});
