import { describe, expect, test } from "bun:test";
import {
  admitEditorFileSwitch,
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
});
