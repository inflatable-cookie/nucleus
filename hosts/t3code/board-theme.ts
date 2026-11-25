import { z } from "zod";
import {
  themeColorSchema,
  themeSeedSchema,
  type BoardPalette,
  type BoardThemeSnapshot,
} from "../../shared/web-theme";
import { findT3BuiltInTheme } from "./board-theme-builtins";

const themeSettings = z.object({
  defaultTheme: z.string().max(64).optional(),
  defaultAppearance: z.enum(["", "system", "light", "dark"]).optional(),
});
const themeRoles = z.object({
  canvas: themeColorSchema.optional(),
  surface: themeColorSchema.optional(),
  surfaceRaised: themeColorSchema.optional(),
  surfaceOverlay: themeColorSchema.optional(),
  text: themeColorSchema.optional(),
  textMuted: themeColorSchema.optional(),
  secondaryLabel: themeColorSchema.optional(),
  border: themeColorSchema.optional(),
  accent: themeColorSchema.optional(),
  accentForeground: themeColorSchema.optional(),
  error: themeColorSchema.optional(),
  warning: themeColorSchema.optional(),
  success: themeColorSchema.optional(),
  sidebar: themeColorSchema.optional(),
  sidebarRowHover: themeColorSchema.optional(),
  sidebarRowSelected: themeColorSchema.optional(),
});
const themeDefinition = z.object({
  id: z.string(),
  appearance: z.enum(["light", "dark"]),
  canvas: themeSeedSchema.optional(),
  accent: themeSeedSchema.optional(),
  colors: themeRoles.optional(),
  variants: z
    .object({ light: themeRoles.optional(), dark: themeRoles.optional() })
    .optional(),
});
export type T3ThemeDefinition = z.infer<typeof themeDefinition>;

function boardColors(
  roles: z.infer<typeof themeRoles> | undefined,
): BoardPalette["colors"] {
  if (!roles) return {};
  return {
    surface0: roles.canvas ?? roles.surface,
    surface1: roles.surfaceRaised,
    surface2: roles.surfaceOverlay,
    foreground: roles.text,
    foregroundMuted: roles.textMuted,
    foregroundLabel: roles.secondaryLabel,
    border: roles.border,
    accent: roles.accent,
    accentForeground: roles.accentForeground,
    statusDanger: roles.error,
    statusWarning: roles.warning,
    statusSuccess: roles.success,
    surfaceNavigation: roles.sidebar,
    surfaceHover: roles.sidebarRowHover,
    surfaceSelected: roles.sidebarRowSelected,
  };
}

function palette(
  roles?: z.infer<typeof themeRoles>,
  seeds?: BoardPalette["seeds"],
): BoardPalette | undefined {
  if (!seeds && (!roles || Object.keys(roles).length === 0)) return undefined;
  return { colors: boardColors(roles), ...(seeds ? { seeds } : {}) };
}

/** The T3 inputs the board theme needs: the settings and the selected published theme. */
export type T3ThemeInputs = { settings: unknown; theme: unknown };

/**
 * Convert the theme settings and selected published theme cached by the
 * Rust service into the board's snapshot.
 */
export function boardThemeFromT3(inputs: T3ThemeInputs): BoardThemeSnapshot | null {
  const parsed = themeSettings.safeParse(inputs.settings);
  if (!parsed.success) return null;
  const settings = parsed.data;
  const id = settings.defaultTheme || null;
  const appearance =
    settings.defaultAppearance ||
    (id === "light" || id === "dark" ? id : "system");
  const snapshot: BoardThemeSnapshot = { appearance, themeId: id };
  if (id === "light" || id === "dark" || id === "system") return snapshot;
  const definition =
    (id ? themeDefinition.safeParse(inputs.theme).data : undefined) ??
    findT3BuiltInTheme(id ?? "t3-code");
  if (!definition) return snapshot;

  const { appearance: base, canvas, accent, colors, variants } = definition;
  const seeds = canvas && accent ? { canvas, accent } : undefined;
  snapshot.light =
    base === "light" ? palette(colors, seeds) : palette(variants?.light);
  snapshot.dark =
    base === "dark" ? palette(colors, seeds) : palette(variants?.dark);
  return snapshot;
}
