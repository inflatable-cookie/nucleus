import { describe, expect, test } from "bun:test";
import { buildFileTree } from "./fileTree";

describe("buildFileTree", () => {
  test("projects flat admitted files into sorted directory nodes", () => {
    const tree = buildFileTree([
      {
        file_ref: "file:z",
        display_path: "src/z.ts",
        language_hint: "typescript",
        byte_size: 1,
        writable: true,
      },
      {
        file_ref: "file:readme",
        display_path: "README.md",
        language_hint: "markdown",
        byte_size: 1,
        writable: true,
      },
      {
        file_ref: "file:a",
        display_path: "src/a.ts",
        language_hint: "typescript",
        byte_size: 1,
        writable: true,
      },
    ]);

    expect(tree.map((node) => [node.kind, node.name])).toEqual([
      ["directory", "src"],
      ["file", "README.md"],
    ]);
    expect(tree[0]?.children.map((node) => node.name)).toEqual(["a.ts", "z.ts"]);
    expect(tree[0]?.children[0]?.file?.file_ref).toBe("file:a");
  });

  test("returns an empty tree when a resource has no admitted files", () => {
    expect(buildFileTree([])).toEqual([]);
  });
});
