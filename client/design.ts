/*
 * Design tokens for the board's shared React Native components. The scale is the
 * point: spacing 4/8/12/16/24/32, five type steps with line height at least 1.3,
 * and colour roles that map the host theme. Shared components read these instead
 * of literals. A new literal needs a reason in review (test/client-design-tokens
 * flags one). Values below the smallest spacing step use `space.xxs / 2`
 * rather than a new step: the scale stays six steps and the half step keeps
 * hairline padding and tight stacks at their drawn size.
 */
import type { BoardTheme } from "./shell/types";

export type Colors = BoardTheme["colors"];

export const space = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32 } as const;

export const type = {
  /** Captions, save status, counts and other metadata. */
  metadata: { fontSize: 12, lineHeight: 16 },
  /** Body text, muted text and control labels. */
  body: { fontSize: 14, lineHeight: 20 },
  /** Section headers. */
  section: { fontSize: 16, lineHeight: 22 },
  /** Page titles. */
  page: { fontSize: 20, lineHeight: 26 },
  /** The primary heading of a surface. */
  heading: { fontSize: 24, lineHeight: 32 },
} as const;

export const radius = { control: 8, card: 8, panel: 10, full: 999 } as const;

/**
 * The one control size (Tom, 2026-11-09: "make inputs sizing a bit more consistent").
 * Text inputs, select triggers, toggles and stepper buttons and numbers share its
 * height, horizontal padding, value font, radius and border width. `compact` is the
 * dense-row and table variant, from the same scale. Below `touchTarget`, a control's
 * pressable reach comes from `touchSlop`, never a taller box.
 */
export const control = {
  height: 36,
  paddingX: space.sm,
  text: type.body,
  radius: radius.control,
  border: 1,
  compact: { height: 28, paddingX: space.xs, text: type.metadata },
} as const;

/** Cool-to-warm usage-strip endpoints; separate from action and warning roles. */
export const usageStripColors = {
  cool: { red: 82, green: 182, blue: 209 },
  warm: { red: 224, green: 126, blue: 151 },
};

/** Interpolate the Profiles usage cue without reusing action or warning colors. */
export function usageStripColor(ratio: number): string {
  const position = Math.max(0, Math.min(1, ratio));
  const channel = (start: number, end: number) =>
    Math.round(start + (end - start) * position);
  return `rgb(${channel(usageStripColors.cool.red, usageStripColors.warm.red)}, ${channel(usageStripColors.cool.green, usageStripColors.warm.green)}, ${channel(usageStripColors.cool.blue, usageStripColors.warm.blue)})`;
}

/** The caption above any field, with or without a (?) beside it. */
export const caption = type.metadata;

/** The smallest touch target, in points, for any control. Compact visuals reach it with `touchSlop`. */
export const touchTarget = 44;

/**
 * The hit area that lifts a visual of `visible` points to the touch target, split
 * evenly around it. The visual keeps its size; only the responder grows.
 */
export function touchSlop(visible: number) {
  const slop = Math.max(0, (touchTarget - visible) / 2);
  return { top: slop, bottom: slop, left: slop, right: slop };
}

/**
 * The colour roles components paint with, read from the host theme. Dark is the
 * first mapping; a light mapping is defined when light is actually implemented.
 */
export function roles(c: Colors) {
  return {
    canvas: c.surface0,
    section: c.surface1,
    raised: c.surface2,
    border: c.border,
    foreground: c.foreground,
    muted: c.foregroundMuted,
    accent: c.accent,
    onAccent: c.accentForeground,
    success: c.statusSuccess,
    warning: c.statusWarning,
    danger: c.statusDanger,
    onDanger: c.surface0,
    /** Keyboard focus ring. Foreground rather than accent, so it stays visible on a selected accent button. */
    focus: c.foreground,
  } as const;
}

/**
 * The inbox row's fixed marks (nucleus#1515): the kind tile, the status dot and the
 * generated T3 project monogram beside the project name.
 */
export const cardRow = {
  tile: 28,
  tileIcon: 14,
  dot: 6,
  projectMark: {
    height: 16,
    maxWidth: 32,
    paddingX: 3,
    radius: 4,
    fontSize: 8,
  },
} as const;

/**
 * The Planning read view (nucleus#1531): the lane card's live-work bar, its aim clamp,
 * the width below which the Now, Next and Later columns stack, the lane page's side
 * column, and the tints the idle banner and the review segment derive from theme roles.
 */
export const planningRead = {
  bar: 6,
  aimLines: 3,
  pillHeight: 18,
  eyebrowTracking: 0.6,
  /** Three columns of at least ~260 points each, with their gaps. */
  columnsMin: 820,
  /** The lane page puts its side column beside the sections from this width. */
  sideMin: 760,
  side: 280,
  finishedMin: 200,
  dormantOpacity: 0.6,
  reviewAlpha: 0.55,
  bannerAlpha: 0.08,
  bannerBorderAlpha: 0.2,
} as const;

/**
 * The redesigned task detail surface (nucleus#1537): step bar, budget bar,
 * status and timeline dots, eyebrow tracking, attention tint alphas, and
 * responsive breakpoints for the Overview's people and stats grids.
 */
export const taskDetail = {
  maxWidth: 980,
  statusDot: 8,
  timelineDot: 9,
  timelineLine: 1,
  stepBarHeight: 4,
  stepBarRadius: 2,
  budgetBarHeight: 5,
  tabIndicator: 2,
  severityWidth: 34,
  severityHeight: 18,
  eyebrowTracking: 0.6,
  attnAlpha: 0.08,
  attnBorderAlpha: 0.25,
  severityAlpha: 0.14,
  kvLabelWidth: 160,
} as const;

/** Overlay colours that are structure, not theme roles: the modal scrim and popover shadow. */
/**
 * Sidebar-style hover for inbox rows and menu entries (nucleus#1528): the selected
 * surface at low alpha, so hover reads dimmer than the solid selected surface.
 * Selected stays the `surface2` token itself; hover over a selected row keeps it.
 */
export function hoverSurface(c: Colors): string {
  return toneSurface(c.surface2, c.surface1);
}

export const overlay = { scrim: "rgba(0,0,0,0.68)", shadow: "#000" } as const;

/**
 * Derive a low-alpha tint surface from a theme colour role (nucleus#1515 kind tiles).
 * Parses hex (`#rgb`, `#rrggbb`, `#rrggbbaa`) and `rgb()`/`rgba()` strings into `rgba(r, g, b, alpha)`,
 * falling back to `fallback` (typically `surface2`) when a host palette omits a role.
 */
export function toneSurface(
  color: string | undefined,
  fallback: string,
  alpha = 0.14,
): string {
  if (!color) return fallback;
  const trimmed = color.trim();
  const hex = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
  if (hex) {
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((ch) => ch + ch)
            .join("")
        : hex.slice(0, 6);
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgb = trimmed.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i,
  );
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  return fallback;
}
