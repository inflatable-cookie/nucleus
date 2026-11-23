import { z } from "zod";

const appearance = z.enum(["light", "dark"]);
export type BoardAppearance = z.infer<typeof appearance>;

/** T3 sends CSS colour literals. The web client resolves them to sRGB for the shared board. */
export const themeColorSchema = z.string().trim().min(1).max(64);
export const themeSeedSchema = z
  .string()
  .regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i);
const boardPaletteSchema = z.object({
  colors: z.object({
    surface0: themeColorSchema.optional(),
    surface1: themeColorSchema.optional(),
    surface2: themeColorSchema.optional(),
    surfaceNavigation: themeColorSchema.optional(),
    surfaceHover: themeColorSchema.optional(),
    surfaceSelected: themeColorSchema.optional(),
    foreground: themeColorSchema.optional(),
    foregroundMuted: themeColorSchema.optional(),
    border: themeColorSchema.optional(),
    accent: themeColorSchema.optional(),
    accentForeground: themeColorSchema.optional(),
    statusDanger: themeColorSchema.optional(),
    statusWarning: themeColorSchema.optional(),
    statusSuccess: themeColorSchema.optional(),
  }),
  seeds: z
    .object({ canvas: themeSeedSchema, accent: themeSeedSchema })
    .optional(),
});
export type BoardPalette = z.infer<typeof boardPaletteSchema>;

export const boardThemeSnapshotSchema = z.object({
  appearance: z.enum(["system", "light", "dark"]),
  themeId: z.string().max(64).nullable(),
  light: boardPaletteSchema.optional(),
  dark: boardPaletteSchema.optional(),
});
export type BoardThemeSnapshot = z.infer<typeof boardThemeSnapshotSchema>;
