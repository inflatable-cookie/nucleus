import type { EditorFileEntry } from "./control/editorFiles";

export type FileTreeNode = {
  name: string;
  path: string;
  kind: "directory" | "file";
  file: EditorFileEntry | null;
  children: FileTreeNode[];
};

export type FileTreeExpansionState = {
  version: 1;
  expandedResources: string[];
  expandedDirectories: Record<string, string[]>;
};

const MAX_PERSISTED_EXPANSIONS = 2_048;

export function parseFileTreeExpansionState(raw: string | null): FileTreeExpansionState | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1) return null;

    const expandedResources = stringArray(value.expandedResources);
    const rawDirectories = isRecord(value.expandedDirectories)
      ? value.expandedDirectories
      : {};
    const expandedDirectories = Object.fromEntries(
      Object.entries(rawDirectories)
        .filter(([, paths]) => Array.isArray(paths))
        .slice(0, MAX_PERSISTED_EXPANSIONS)
        .map(([resourceId, paths]) => [resourceId, stringArray(paths)]),
    );

    return {
      version: 1,
      expandedResources,
      expandedDirectories,
    };
  } catch {
    return null;
  }
}

export function serializeFileTreeExpansionState(
  expandedResources: Iterable<string>,
  expandedDirectories: Record<string, Iterable<string>>,
): string {
  const directories = Object.fromEntries(
    Object.entries(expandedDirectories)
      .map(([resourceId, paths]) => [
        resourceId,
        [...new Set(paths)].slice(0, MAX_PERSISTED_EXPANSIONS),
      ])
      .filter(([, paths]) => paths.length > 0),
  );
  return JSON.stringify({
    version: 1,
    expandedResources: [...new Set(expandedResources)].slice(0, MAX_PERSISTED_EXPANSIONS),
    expandedDirectories: directories,
  } satisfies FileTreeExpansionState);
}

export function fileTreeRefreshDirectories(paths: readonly string[]): string[] {
  const directories = [...new Set(paths.map((path) => {
    const normalized = path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    const separator = normalized.lastIndexOf("/");
    return separator < 0 ? "" : normalized.slice(0, separator);
  }))].sort((left, right) =>
    pathDepth(left) - pathDepth(right) || left.localeCompare(right)
  );

  return directories.filter((directory, index) =>
    !directories.slice(0, index).some((parent) =>
      parent === "" || directory === parent || directory.startsWith(`${parent}/`)
    )
  );
}

export function moveFileTreeExpansionPaths(
  paths: Iterable<string>,
  displayPath: string,
  targetDisplayPath: string,
): Set<string> {
  const prefix = `${displayPath}/`;
  return new Set([...paths].map((path) => {
    if (path === displayPath) return targetDisplayPath;
    return path.startsWith(prefix)
      ? `${targetDisplayPath}/${path.slice(prefix.length)}`
      : path;
  }));
}

export function removeFileTreeExpansionPaths(
  paths: Iterable<string>,
  displayPath: string,
): Set<string> {
  const prefix = `${displayPath}/`;
  return new Set(
    [...paths].filter((path) => path !== displayPath && !path.startsWith(prefix)),
  );
}

export function buildFileTree(files: EditorFileEntry[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const file of files) {
    const parts = file.display_path.split("/").filter(Boolean);
    let level = root;
    let path = "";

    parts.forEach((name, index) => {
      path = path ? `${path}/${name}` : name;
      const kind = index === parts.length - 1 ? "file" : "directory";
      let node = level.find((candidate) => candidate.name === name && candidate.kind === kind);
      if (!node) {
        node = {
          name,
          path,
          kind,
          file: kind === "file" ? file : null,
          children: [],
        };
        level.push(node);
      }
      level = node.children;
    });
  }

  sortFileTree(root);
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string"))]
    .slice(0, MAX_PERSISTED_EXPANSIONS);
}

function pathDepth(path: string): number {
  return path ? path.split("/").length : 0;
}

function sortFileTree(nodes: FileTreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
  nodes.forEach((node) => sortFileTree(node.children));
}
