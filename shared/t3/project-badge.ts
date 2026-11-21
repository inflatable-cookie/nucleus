import { z } from "zod";

/**
 * Generated T3 project badges for the Nucleus board (nucleus#1450).
 *
 * A board card shows the same monogram and colour as the T3 project it belongs to.
 * The rules here are a copy of the installed T3 nightly's `ProjectMonogram` (renderer
 * `t3code-0.1.12-nightly.20261120.4994`, see the constant below), so the two surfaces agree. This is the one place that
 * compatibility rule lives. When T3 changes its renderer, bump the renderer constant,
 * update the palette and the vectors in `test/t3-project-badge.test.ts` together.
 *
 * Identity, not names: a badge is matched to a Nucleus repository only by the T3
 * project's recorded `workspaceRoot`, compared on canonical paths. The badge text and
 * colour come from the T3 project's own title. A missing, ambiguous or unobservable
 * match gives no badge, and the card keeps its normal label.
 */

/** The T3 nightly whose renderer these rules copy. */
export const T3_PROJECT_BADGE_RENDERER = "t3code-0.1.12-nightly.20261120.4994";

/** The ordered palette the title hash indexes. Order is part of the rule. */
export const T3_PROJECT_BADGE_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
] as const;
export type ProjectBadgeColor = (typeof T3_PROJECT_BADGE_COLORS)[number];

/**
 * The renderer's text colours: `text-<name>-600` for light surfaces and
 * `text-<name>-400` for dark ones (Tailwind v4 oklch values, as the nightly ships them).
 */
export const T3_PROJECT_BADGE_TEXT: Record<
  ProjectBadgeColor,
  { light: string; dark: string }
> = {
  gray: {
    light: "oklch(44.6% .03 256.802)",
    dark: "oklch(70.7% .022 261.325)",
  },
  red: { light: "oklch(57.7% .245 27.325)", dark: "oklch(70.4% .191 22.216)" },
  orange: { light: "oklch(64.6% .222 41.116)", dark: "oklch(75% .183 55.934)" },
  amber: {
    light: "oklch(66.6% .179 58.318)",
    dark: "oklch(82.8% .189 84.429)",
  },
  yellow: {
    light: "oklch(68.1% .162 75.834)",
    dark: "oklch(85.2% .199 91.936)",
  },
  lime: { light: "oklch(64.8% .2 131.684)", dark: "oklch(84.1% .238 128.85)" },
  green: {
    light: "oklch(62.7% .194 149.214)",
    dark: "oklch(79.2% .209 151.711)",
  },
  emerald: {
    light: "oklch(59.6% .145 163.225)",
    dark: "oklch(76.5% .177 163.223)",
  },
  teal: { light: "oklch(60% .118 184.704)", dark: "oklch(77.7% .152 181.912)" },
  cyan: {
    light: "oklch(60.9% .126 221.723)",
    dark: "oklch(78.9% .154 211.53)",
  },
  sky: { light: "oklch(58.8% .158 241.966)", dark: "oklch(74.6% .16 232.661)" },
  blue: {
    light: "oklch(54.6% .245 262.881)",
    dark: "oklch(70.7% .165 254.624)",
  },
  indigo: {
    light: "oklch(51.1% .262 276.966)",
    dark: "oklch(67.3% .182 276.935)",
  },
  violet: {
    light: "oklch(54.1% .281 293.009)",
    dark: "oklch(70.2% .183 293.541)",
  },
  purple: {
    light: "oklch(55.8% .288 302.321)",
    dark: "oklch(71.4% .203 305.504)",
  },
  fuchsia: {
    light: "oklch(59.1% .293 322.896)",
    dark: "oklch(74% .238 322.16)",
  },
  pink: { light: "oklch(59.2% .249 .584)", dark: "oklch(71.8% .202 349.761)" },
  rose: { light: "oklch(58.6% .253 17.585)", dark: "oklch(71.2% .194 13.428)" },
};

/** The renderer's subdued background: the text colour at 14% over transparent. */
export const T3_PROJECT_BADGE_TINT =
  "color-mix(in srgb, currentColor 14%, transparent)";

/** A badge as the board draws it: two code points at most, and one palette colour. */
export interface ProjectBadge {
  readonly monogram: string;
  readonly color: ProjectBadgeColor;
}

const PROJECT_ICON_COLORS: ReadonlySet<string> = new Set(
  T3_PROJECT_BADGE_COLORS,
);
/** T3's stored monogram text rule: letters and numbers, with marks and joiners, at most 32. */
const MONOGRAM_TEXT = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}‌‍]*$/u;

function normalised(title: string): string {
  return title.normalize("NFKC").trim();
}

/**
 * The renderer's monogram. The first character comes from the first letter-or-number
 * run. The second prefers the next number in that run, else the first character of
 * the last run when there are several runs, else the run's last character. Uppercase,
 * at most two code points; `PR` when the title has no run at all.
 */
export function projectBadgeMonogram(title: string): string {
  const runs = normalised(title).match(/[\p{L}\p{N}]+/gu) ?? [];
  const first = runs[0];
  if (!first) return "PR";
  const characters = Array.from(first);
  const head = characters[0] ?? "P";
  const second =
    characters.slice(1).find((character) => /\p{N}/u.test(character)) ??
    (runs.length > 1
      ? Array.from(runs[runs.length - 1] ?? "")[0]
      : characters[characters.length - 1]) ??
    head;
  return Array.from(`${head}${second}`.toUpperCase()).slice(0, 2).join("");
}

/**
 * The renderer's colour: a 31-multiplier hash of the lowercased (en-US) title, reduced
 * modulo the palette length at each step. An empty title hashes as `project`.
 */
export function projectBadgeColor(title: string): ProjectBadgeColor {
  const text = normalised(title).toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const character of text)
    index =
      (index * 31 + (character.codePointAt(0) ?? 0)) %
      T3_PROJECT_BADGE_COLORS.length;
  return T3_PROJECT_BADGE_COLORS[index] ?? "blue";
}

/** The generated badge for a T3 project title. Derive from the exact T3 title, never a display name. */
export function generatedProjectBadge(title: string): ProjectBadge {
  return {
    monogram: projectBadgeMonogram(title),
    color: projectBadgeColor(title),
  };
}

/**
 * The fields of a T3 project observation this module reads. `projectIcon` is the
 * nightly's stored icon metadata. Only a monogram is reused: its text and colour are the
 * operator's own choice and can be matched safely. A lucide or emoji icon, or any
 * `faviconPath`, applies instead of a generated badge, and this module never fetches an
 * image path, so those projects keep the normal label.
 */
export interface ObservedT3Project {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
  /** T3's stored icon metadata, unparsed here: any value other than a monogram keeps the normal label. */
  readonly projectIcon?: unknown;
  /** Any favicon path, whatever its shape, keeps the normal label. */
  readonly faviconPath?: unknown;
}

/**
 * The badge a T3 project shows, or null when T3's own metadata means the card must
 * keep its normal label.
 */
export function projectBadgeFor(
  project: ObservedT3Project,
): ProjectBadge | null {
  const icon = project.projectIcon;
  if (icon !== undefined && icon !== null) {
    if (
      typeof icon !== "object" ||
      (icon as { kind?: unknown }).kind !== "monogram"
    )
      return null;
    const { text, color } = icon as { text?: unknown; color?: unknown };
    if (
      typeof text !== "string" ||
      !MONOGRAM_TEXT.test(text) ||
      Array.from(text).length > 32 ||
      typeof color !== "string" ||
      !PROJECT_ICON_COLORS.has(color)
    )
      return null;
    return { monogram: text, color: color as ProjectBadgeColor };
  }
  if (project.faviconPath !== undefined && project.faviconPath !== null)
    return null;
  return generatedProjectBadge(project.title);
}

/** One T3 host's observed projects, as its last read saw them. */
export interface ProjectObservation {
  readonly hostId: string;
  readonly projects: readonly ObservedT3Project[];
}

/** A Nucleus task's host and repository, the two facts a badge is matched by. */
export interface BadgeTaskRef {
  readonly hostId: string;
  readonly repoPath: string;
}

/** Badges by host, then by repository path. */
export type ProjectBadgeMap = Record<string, Record<string, ProjectBadge>>;

/** Badges by repository path, for records without a dispatched task host (nucleus#1490). */
export type RepositoryBadgeMap = Record<string, ProjectBadge>;

/** The board's wire shape for a badge map, validated wherever a board is parsed. */
export const projectBadgeSchema = z
  .object({
    monogram: z.string().min(1).max(32),
    color: z.enum(T3_PROJECT_BADGE_COLORS),
  })
  .strict();
export const projectBadgeMapSchema = z.record(
  z.string(),
  z.record(z.string(), projectBadgeSchema),
);
export const repositoryBadgeMapSchema = z.record(
  z.string(),
  projectBadgeSchema,
);

interface ActiveObservedProject {
  readonly project: ObservedT3Project;
  readonly root: string;
}

function activeObservedProjects(
  projects: readonly ObservedT3Project[],
  canonical: (path: string) => string,
): ActiveObservedProject[] {
  return projects
    .filter(
      (project) => project.archivedAt == null && project.deletedAt == null,
    )
    .map((project) => ({ project, root: canonical(project.workspaceRoot) }));
}

function unambiguousBadgeForRoot(
  active: readonly ActiveObservedProject[],
  root: string,
): ProjectBadge | null {
  const matches = active.filter((candidate) => candidate.root === root);
  if (matches.length !== 1) return null;
  return projectBadgeFor(matches[0]!.project);
}

/**
 * Match each task's repository to its host's T3 project by canonical `workspaceRoot`.
 * Only active projects count (not archived or deleted). A repository matched by no
 * project, or by more than one, gets no badge. Hosts with no observation give none.
 * `canonical` resolves a path (the service passes realpath); it must not touch the host.
 */
export function matchProjectBadges(input: {
  readonly tasks: readonly BadgeTaskRef[];
  readonly observations: readonly ProjectObservation[];
  readonly canonical?: (path: string) => string;
}): ProjectBadgeMap {
  const canonical = input.canonical ?? ((path: string) => path);
  const out: ProjectBadgeMap = {};
  const observed = new Map(
    input.observations.map((observation) => [observation.hostId, observation]),
  );
  const repos = new Map<string, Set<string>>();
  for (const task of input.tasks) {
    if (!observed.has(task.hostId)) continue;
    const set = repos.get(task.hostId) ?? new Set<string>();
    set.add(task.repoPath);
    repos.set(task.hostId, set);
  }
  for (const [hostId, repoPaths] of repos) {
    const active = activeObservedProjects(
      observed.get(hostId)!.projects,
      canonical,
    );
    for (const repoPath of repoPaths) {
      const badge = unambiguousBadgeForRoot(active, canonical(repoPath));
      if (!badge) continue;
      (out[hostId] ??= {})[repoPath] = badge;
    }
  }
  return out;
}

/**
 * Match each repository path against all live T3 project observations by canonical
 * `workspaceRoot`, without a dispatched task host (nucleus#1490). Only active T3
 * projects count (not archived or deleted); zero matches or more than one match across
 * all live observations leaves the repository without a badge.
 */
export function matchRepositoryBadges(input: {
  readonly repoPaths: readonly string[];
  readonly observations: readonly ProjectObservation[];
  readonly canonical?: (path: string) => string;
}): RepositoryBadgeMap {
  const canonical = input.canonical ?? ((path: string) => path);
  const active = input.observations.flatMap((observation) =>
    activeObservedProjects(observation.projects, canonical),
  );
  const out: RepositoryBadgeMap = {};
  for (const repoPath of new Set(input.repoPaths)) {
    if (!repoPath) continue;
    const badge = unambiguousBadgeForRoot(active, canonical(repoPath));
    if (badge) out[repoPath] = badge;
  }
  return out;
}

/** Whether a surface colour is dark, by its relative luminance. Light badges use the 600 text. */
export function isDarkSurface(hex: string): boolean {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return true;
  const value = parseInt(match[1]!, 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance =
    0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance < 0.4;
}

/** The text colour for a badge on a surface of the given mode. */
export function projectBadgeText(badge: ProjectBadge, dark: boolean): string {
  return T3_PROJECT_BADGE_TEXT[badge.color][dark ? "dark" : "light"];
}

/**
 * The OKLCH palette above is the owner: these helpers convert one pinned entry to
 * sRGB at the presentation boundary, so the browser build (react-native-web,
 * which drops `oklch()` and `color-mix()` through its `normalizeColor`) draws the
 * same assigned colour. No second palette lives here; every value derives from
 * `T3_PROJECT_BADGE_TEXT`.
 */
const OKLCH_PATTERN = /^oklch\(\s*([0-9.]+)%\s+([0-9.]+)\s+([0-9.]+)\s*\)$/;

/** The sRGB channels of one pinned OKLCH entry, each 0-255. Out-of-gamut clamps. */
export function oklchToRgbChannels(oklch: string): {
  r: number;
  g: number;
  b: number;
} {
  const match = OKLCH_PATTERN.exec(oklch.trim());
  if (!match) throw new Error(`Unsupported OKLCH colour: ${oklch}`);
  const light = parseFloat(match[1]!) / 100;
  const chroma = parseFloat(match[2]!);
  const hue = (parseFloat(match[3]!) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = Math.pow(light + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(light - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(light - 0.0894841775 * a - 1.291485548 * b, 3);
  const linear = {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
  const encode = (value: number): number => {
    const clamped = Math.min(1, Math.max(0, value));
    const gamma =
      clamped <= 0.0031308
        ? 12.92 * clamped
        : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, gamma)) * 255);
  };
  return { r: encode(linear.r), g: encode(linear.g), b: encode(linear.b) };
}

/** The 14% tint as an explicit alpha, matching `T3_PROJECT_BADGE_TINT`. */
export const PROJECT_BADGE_TINT_ALPHA = 0.14;

/** The browser-safe foreground for a badge: the pinned entry converted to sRGB. */
export function projectBadgeWebForeground(
  badge: ProjectBadge,
  dark: boolean,
): string {
  const { r, g, b } = oklchToRgbChannels(projectBadgeText(badge, dark));
  return `rgb(${r}, ${g}, ${b})`;
}

/** The browser-safe tint for a badge: the same converted entry at 14% alpha. */
export function projectBadgeWebTint(
  badge: ProjectBadge,
  dark: boolean,
): string {
  const { r, g, b } = oklchToRgbChannels(projectBadgeText(badge, dark));
  return `rgba(${r}, ${g}, ${b}, ${PROJECT_BADGE_TINT_ALPHA})`;
}

/** The browser-safe badge style: converted foreground plus the explicit 14% tint. */
export function projectBadgeWebStyle(
  badge: ProjectBadge,
  dark: boolean,
): { color: string; backgroundColor: string } {
  return {
    color: projectBadgeWebForeground(badge, dark),
    backgroundColor: projectBadgeWebTint(badge, dark),
  };
}
