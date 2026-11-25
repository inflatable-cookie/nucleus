import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { navigationTextOpacity, roles, wash } from "../client/design";
import { resolvePalette } from "../client/web/theme";
import { boardThemeFromT3, type T3ThemeDefinition } from "../hosts/t3code/board-theme";
import { findT3BuiltInTheme } from "../hosts/t3code/board-theme-builtins";
const themes: {
  stock: Record<string, unknown>;
  ember: unknown;
  seeded: unknown;
} = JSON.parse(
  readFileSync(
    new URL("./fixtures/t3code-board-themes.json", import.meta.url),
    "utf8",
  ),
);
test("the board maps cached T3 settings and published themes to its palette", () => {
  const stock = boardThemeFromT3({ settings: themes.stock, theme: null });
  assert.equal(stock?.themeId, null);
  assert.equal(stock?.appearance, "dark");
  assert.equal(stock?.light?.colors.surface0, "#fcfcfc");
  assert.equal(stock?.light?.colors.surfaceNavigation, "#fafafa");
  assert.equal(stock?.light?.colors.accent, "#1b4ed8");
  assert.equal(stock?.dark?.colors.surface0, "#000000");
  assert.equal(stock?.dark?.colors.surfaceNavigation, "#000000");
  assert.equal(stock?.dark?.colors.accent, "#346bf1");
  const palette = (id: string, appearance: string, theme: unknown = null) =>
    boardThemeFromT3({ settings: { defaultTheme: id, defaultAppearance: appearance }, theme });
  assert.deepEqual(palette("t3-code", "system"), {
    ...stock, themeId: "t3-code", appearance: "system",
  });
  const builtInEmber = palette("ember", "dark");
  assert.equal(builtInEmber?.themeId, "ember");
  assert.equal(builtInEmber?.appearance, "dark");
  assert.equal(
    builtInEmber?.light?.colors.surface0,
    "oklch(0.976527 0.002685 60.725)",
  );
  assert.equal(
    builtInEmber?.dark?.colors.accent,
    "oklch(0.762174 0.124117 52.082)",
  );

  assert.deepEqual(palette("t3-ember", "dark"), { ...builtInEmber, themeId: "t3-ember" });
  assert.deepEqual(palette("unknown-theme", "dark"), { themeId: "unknown-theme", appearance: "dark" });
  const ember = palette("ember", "dark", themes.ember);
  assert.partialDeepStrictEqual(ember?.dark?.colors, {
    surface0: "#241c1a",
    surface1: "#302520",
    surface2: "#3c2e27",
    foreground: "#f9ebe0",
    foregroundMuted: "#c4aa99",
    border: "#75594b",
    accent: "#ffae6f",
    accentForeground: "#351e12",
    statusDanger: "#fa9487",
    statusWarning: "#f9c66d",
    statusSuccess: "#a9ca8c",
    surfaceNavigation: "#2b211d",
    surfaceHover: "#4a372d",
    surfaceSelected: "#624333",
  });
  assert.equal(ember?.light?.colors.surface0, "#fcf7f1");
  assert.equal(ember?.light?.colors.surfaceSelected, "oklch(0.83 0.08 61)");
  assert.equal("css" in (ember ?? {}), false);
  assert.equal(palette("ember", "light", themes.ember)?.appearance, "light");
  assert.partialDeepStrictEqual(palette("forest-fixture", "system", themes.seeded)?.dark, {
    seeds: { canvas: "#162720", accent: "#94cba4" },
    colors: { foreground: "#effbf2" },
  });
  assert.equal(boardThemeFromT3({ settings: { defaultTheme: 42 }, theme: null }), null);
});

test("board interaction roles accept T3 colours and keep the existing host defaults", () => {
  const colors = {
    surface0: "#111318",
    surface1: "#1a1d24",
    surface2: "#252932",
    foreground: "#f1f3f5",
    foregroundMuted: "#a5acb8",
    border: "#39404b",
    accent: "#8caaff",
    accentForeground: "#101521",
    statusSuccess: "#71c99a",
    statusWarning: "#e9bc68",
    statusDanger: "#ef8282",
  };
  assert.equal(roles(colors).hover, "rgba(241, 243, 245, 0.06)");
  assert.equal(roles(colors).selected, "rgba(241, 243, 245, 0.1)");
  assert.equal(roles(colors).header, colors.surface0);
  assert.equal(roles(colors).navigation, colors.surface0);
  assert.equal(roles(colors).list, colors.surface1);
  const themed = roles({
    ...colors,
    surfaceHover: "#4a372d",
    surfaceSelected: "#624333",
  });
  assert.equal(themed.hover, "#4a372d");
  assert.equal(themed.selected, "#624333");
});

test("each built-in T3 palette uses its sidebar for board navigation and shares the canvas between list and detail", (t) => {
  const { window } = new JSDOM("<span></span>");
  t.after(() => window.close());
  const swatch = window.document.querySelector("span");
  assert.ok(swatch);
  const color = (value: string) => {
    swatch.style.color = "";
    swatch.style.color = `color-mix(in srgb, ${value}, ${value})`;
    const computed = window.getComputedStyle(swatch).color;
    const match = computed.match(/^color\(srgb ([^/]+)\)$/);
    assert.ok(match, `${value}: ${computed}`);
    const channels = match[1].trim().split(/\s+/).map(Number);
    return `#${channels
      .map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0"))
      .join("")}`;
  };
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((offset) => {
      const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = (a: string, b: string) => {
    const x = luminance(a);
    const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const tint = (base: string, foreground: string, opacity: number) =>
    color(`color-mix(in srgb, ${base}, ${foreground} ${opacity * 100}%)`);

  for (const id of ["t3-code", "t3-chat", "grove", "ocean", "ember", "iris"]) {
    const builtIn = findT3BuiltInTheme(id);
    assert.ok(builtIn);
    for (const appearance of ["light", "dark"] as const) {
      const palette: T3ThemeDefinition["colors"] =
        builtIn.appearance === appearance
          ? builtIn.colors
          : builtIn.variants?.[appearance];
      assert.ok(palette?.canvas && palette.sidebar && palette.text);
      const theme = resolvePalette(
        appearance,
        {
          colors: {
            surface0: palette.canvas,
            surface1: palette.surfaceRaised,
            surfaceNavigation: palette.sidebar,
            foreground: palette.text,
          },
        },
        color,
      );
      assert.ok(theme);
      const { canvas, header, navigation, list, foreground } = roles(theme.colors);
      const variant = `${id} ${appearance}`;
      assert.equal(canvas, color(palette.canvas), variant);
      assert.equal(list, canvas, variant);
      assert.equal(header, color(palette.sidebar), variant);
      assert.equal(navigation, header, variant);
      assert.ok(
        contrast(foreground, navigation) >= 3,
        `${variant} selection marker against menu`,
      );
      const hover = tint(navigation, foreground, wash.hover);
      const selected = tint(navigation, foreground, wash.selected);
      assert.ok(
        contrast(foreground, selected) >= 4.5,
        `${variant} selected menu text`,
      );
      assert.ok(
        contrast(tint(hover, foreground, navigationTextOpacity.dimmed), hover) >=
          4.5,
        `${variant} dimmed menu text on hover`,
      );
    }
  }
});

test("a published palette without a sidebar shade uses its canvas for all board panes", () => {
  const canvas = "#162720";
  const theme = resolvePalette(
    "dark",
    { colors: { surface0: canvas } },
    (color) => color,
  );
  assert.ok(theme);
  const fills = roles(theme.colors);
  assert.equal(fills.header, canvas);
  assert.equal(fills.navigation, canvas);
  assert.equal(fills.list, canvas);
});
