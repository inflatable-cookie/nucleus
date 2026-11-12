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

export const radius = { control: 8, card: 8, panel: 10 } as const;

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

/** Overlay colours that are structure, not theme roles: the modal scrim and popover shadow. */
export const overlay = { scrim: "rgba(0,0,0,0.68)", shadow: "#000" } as const;
