import type { EditorFileEntry } from "./control/editorFiles";

export type FileTreeNode = {
  name: string;
  path: string;
  kind: "directory" | "file";
  file: EditorFileEntry | null;
  children: FileTreeNode[];
};

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

function sortFileTree(nodes: FileTreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
  nodes.forEach((node) => sortFileTree(node.children));
}
