import type { Project, ProjectSettingsRow } from "../shared/contracts";

/* Repository naming and refusal text shared by the Projects list, Add project and an opened project. */

export type ProjectRepository = Project["repositories"][number];
export const identityOf = (repo: ProjectRepository) => repo.origin ?? repo.path;
export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
/** A repository's name: its `owner/name`, else its folder name. A checkout path never shows. */
export const repositoryLabel = (repo: ProjectRepository) => repo.origin || folderName(repo.path) || "Repository";

/**
 * Repositories still in implicit projects: the `repo-<hash>` project made on first
 * sight of a repository, holding only it and still named after it. The store lets
 * a named project absorb one of these and refuses a repository in any other
 * project, so only these are offered. A renamed implicit project counts as named.
 */
export function implicitRepositories(rows: readonly ProjectSettingsRow[]): ProjectRepository[] {
  return rows
    .filter(entry => /^repo-[0-9a-f]{20}$/.test(entry.project.key) && entry.project.repositories.length === 1
      && entry.project.name === folderName(identityOf(entry.project.repositories[0]!)))
    .map(entry => entry.project.repositories[0]!)
    .sort((a, b) => repositoryLabel(a).localeCompare(repositoryLabel(b), undefined, { sensitivity: "base" }));
}

/** The key for a new project: a slug of its name, with a numeric suffix when another project has it. Never shown. */
export function projectKeyFor(name: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  let slug = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  if (!/^[a-z]/.test(slug)) slug = slug ? `project-${slug}` : "project";
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
}

/** A refusal in the server's words, with host paths cut to their last folder. */
export function withoutHostPaths(text: string): string {
  return text.replace(/(?:~|\/(?:Users|Volumes|home|private|var|tmp|opt|srv|mnt))(?:\/[^\s'"`,;:()]+)+/g, path => folderName(path));
}

export const OWNER_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * One command field to `argv`, split like a shell: whitespace separates words,
 * single quotes are literal, double quotes honour `\"` and `\\`, and a backslash
 * outside quotes takes the next character. No expansion of any kind.
 */
export function splitCommand(text: string): { argv: string[] } | { error: string } {
  const argv: string[] = [];
  let word = "", inWord = false, quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === "'") { if (ch === "'") quote = null; else word += ch; continue; }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) word += text[++i];
      else word += ch;
      continue;
    }
    if (/\s/.test(ch)) { if (inWord) { argv.push(word); word = ""; inWord = false; } continue; }
    inWord = true;
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\") { if (i + 1 < text.length) word += text[++i]; }
    else word += ch;
  }
  if (quote) return { error: "a quote is not closed" };
  if (inWord) argv.push(word);
  return { argv };
}

/** `argv` back to one command line that `splitCommand` reads as the same words. */
export function joinCommand(argv: readonly string[]): string {
  return argv.map(arg => /^[A-Za-z0-9_\-.,/:=@%+]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`).join(" ");
}
