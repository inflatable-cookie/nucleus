import { z } from "zod";
import {
  themeColorSchema,
  themeSeedSchema,
  type BoardPalette,
  type BoardThemeSnapshot,
} from "../../shared/web-theme";
import type { T3RpcClient } from "./rpc";

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
  border: themeColorSchema.optional(),
  accent: themeColorSchema.optional(),
  accentForeground: themeColorSchema.optional(),
  error: themeColorSchema.optional(),
  warning: themeColorSchema.optional(),
  success: themeColorSchema.optional(),
  sidebarRowHover: themeColorSchema.optional(),
  sidebarRowSelected: themeColorSchema.optional(),
});
const themeDefinition = z.object({
  appearance: z.enum(["light", "dark"]),
  canvas: themeSeedSchema.optional(),
  accent: themeSeedSchema.optional(),
  colors: themeRoles.optional(),
  variants: z
    .object({ light: themeRoles.optional(), dark: themeRoles.optional() })
    .optional(),
});
const themeEvent = z.object({
  type: z.literal("environmentThemesUpdated"),
  payload: z.object({ themes: z.array(z.unknown()) }),
});
const themeId = z.object({ id: z.string() });

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
    border: roles.border,
    accent: roles.accent,
    accentForeground: roles.accentForeground,
    statusDanger: roles.error,
    statusWarning: roles.warning,
    statusSuccess: roles.success,
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

/** One read per board load. The host publishes defaults and definitions, not renderer preferences. */
export async function readT3BoardTheme(
  rpc: T3RpcClient,
): Promise<BoardThemeSnapshot | null> {
  try {
    const settings = themeSettings.parse(
      await rpc.call("server.getSettings", {}),
    );
    const id = settings.defaultTheme || null;
    const appearance =
      settings.defaultAppearance ||
      (id === "light" || id === "dark" ? id : "system");
    const snapshot: BoardThemeSnapshot = { appearance, themeId: id };
    if (!id || id === "light" || id === "dark" || id === "system")
      return snapshot;

    try {
      const event = themeEvent.parse(
        await rpc.readStream(
          "subscribeServerConfig",
          { environmentThemes: true, workspaceSnapshotsOnDemand: true },
          (value) => themeEvent.safeParse(value).success,
        ),
      );
      const selected = event.payload.themes.find(
        (value) => themeId.safeParse(value).data?.id === id,
      );
      const definition = themeDefinition.safeParse(selected);
      if (!definition.success) return snapshot;

      const {
        appearance: base,
        canvas,
        accent,
        colors,
        variants,
      } = definition.data;
      const seeds = canvas && accent ? { canvas, accent } : undefined;
      snapshot.light =
        base === "light" ? palette(colors, seeds) : palette(variants?.light);
      snapshot.dark =
        base === "dark" ? palette(colors, seeds) : palette(variants?.dark);
    } catch {
      // An older or unavailable theme stream can still supply a usable appearance.
    }
    return snapshot;
  } catch {
    return null;
  }
}
