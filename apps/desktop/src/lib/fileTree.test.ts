import { describe, expect, test } from "bun:test";
import {
  buildFileTree,
  fileTreeRefreshDirectories,
  moveFileTreeExpansionPaths,
  parseFileTreeExpansionState,
  removeFileTreeExpansionPaths,
  serializeFileTreeExpansionState,
} from "./fileTree";

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

describe("file tree refresh targeting", () => {
  test("refreshes only the shallowest affected loaded directories", () => {
    expect(fileTreeRefreshDirectories([
      "src/lib.rs",
      "src/nested/demo.rs",
      "tests/smoke.rs",
      "src/lib.rs",
    ])).toEqual(["src", "tests"]);
  });

  test("a root change subsumes nested refreshes", () => {
    expect(fileTreeRefreshDirectories([
      "README.md",
      "src/lib.rs",
    ])).toEqual([""]);
  });
});

describe("file tree expansion state", () => {
  test("round-trips project resource and directory expansion paths", () => {
    const raw = serializeFileTreeExpansionState(
      ["resource:one"],
      {
        "resource:one": ["src", "src/lib"],
        "resource:empty": [],
      },
    );

    expect(parseFileTreeExpansionState(raw)).toEqual({
      version: 1,
      expandedResources: ["resource:one"],
      expandedDirectories: {
        "resource:one": ["src", "src/lib"],
      },
    });
  });

  test("ignores corrupt or incompatible state", () => {
    expect(parseFileTreeExpansionState("{")).toBeNull();
    expect(parseFileTreeExpansionState('{"version":2}')).toBeNull();
  });

  test("moves expanded folder paths with a renamed subtree", () => {
    expect([...moveFileTreeExpansionPaths(
      ["src", "src/generated", "src/generated/nested", "tests"],
      "src/generated",
      "src/output",
    )]).toEqual(["src", "src/output", "src/output/nested", "tests"]);
  });

  test("removes a deleted folder and its expanded descendants", () => {
    expect([...removeFileTreeExpansionPaths(
      ["src", "src/generated", "src/generated/nested", "tests"],
      "src/generated",
    )]).toEqual(["src", "tests"]);
  });
});
