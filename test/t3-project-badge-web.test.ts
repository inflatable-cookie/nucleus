import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
// No native stubs here: this is the deployed board path, where `react-native`
// resolves to `react-native-web` (see scripts/build-runtime.mjs and
// scripts/bb/build-board.mjs). Importing `react-native-web` directly exercises the
// same `normalizeColor` the bundle runs.
// @ts-expect-error react-native-web ships no types; the test reads its runtime only.
import normalizeColor from "react-native-web/dist/exports/StyleSheet/compiler/normalizeColor.js";
// @ts-expect-error react-native-web ships no types; the test reads its runtime only.
import { Text } from "react-native-web";
import {
  PROJECT_BADGE_TINT_ALPHA,
  T3_PROJECT_BADGE_COLORS,
  T3_PROJECT_BADGE_TEXT,
  oklchToRgbChannels,
  projectBadgeText,
  projectBadgeWebStyle,
  type ProjectBadge,
} from "../shared/t3/project-badge";

/**
 * nucleus#1487: the pinned OKLCH palette and its `color-mix()` tint never reach the
 * browser board: react-native-web's `normalizeColor` drops both, so the card's
 * badge would render with no colour at all. The presentation boundary converts the
 * assigned entry to sRGB (`rgb()`) and the same entry at 14% alpha (`rgba()`), and
 * this file proves the converted declarations survive that exact runtime.
 */

const badge: ProjectBadge = { monogram: "BA", color: "fuchsia" };

function markupFor(style: { color: string; backgroundColor: string }): string {
  return renderToStaticMarkup(React.createElement(Text as never, { style } as never, "BA"));
}

test("the pinned oklch foreground and color-mix tint do not survive normalizeColor", () => {
  assert.equal(normalizeColor(projectBadgeText(badge, true)), undefined);
  assert.equal(normalizeColor("color-mix(in srgb, currentColor 14%, transparent)"), undefined);
});

test("the dark badge converts to a foreground and tint the web runtime keeps", () => {
  const style = projectBadgeWebStyle(badge, true);
  assert.equal(style.color, "rgb(237, 106, 255)");
  assert.equal(style.backgroundColor, "rgba(237, 106, 255, 0.14)");
  assert.ok(normalizeColor(style.color), "the dark foreground survives normalizeColor");
  assert.ok(normalizeColor(style.backgroundColor), "the tint survives normalizeColor");
  const html = markupFor(style);
  assert.match(html, /color:rgba\(237,106,255,1\.00\)/, "the dark foreground is in the emitted markup");
  assert.match(html, /background-color:rgba\(237,106,255,0\.14\)/, "the 14% tint is in the emitted markup");
  assert.match(html, /BA/, "the monogram stays the text");
});

test("the light badge converts to its own foreground and tint in the same markup", () => {
  const style = projectBadgeWebStyle(badge, false);
  assert.equal(style.color, "rgb(200, 0, 222)");
  assert.equal(style.backgroundColor, "rgba(200, 0, 222, 0.14)");
  assert.ok(normalizeColor(style.color));
  assert.ok(normalizeColor(style.backgroundColor));
  const html = markupFor(style);
  assert.match(html, /color:rgba\(200,0,222,1\.00\)/);
  assert.match(html, /background-color:rgba\(200,0,222,0\.14\)/);
  assert.notEqual(style.color, projectBadgeWebStyle(badge, true).color, "dark and light variants stay distinct");
});

test("every palette entry converts to sRGB the web runtime keeps, at 14% alpha", () => {
  assert.equal(PROJECT_BADGE_TINT_ALPHA, 0.14);
  for (const color of T3_PROJECT_BADGE_COLORS) {
    for (const dark of [true, false]) {
      const entry: ProjectBadge = { monogram: "BA", color };
      const style = projectBadgeWebStyle(entry, dark);
      assert.ok(normalizeColor(style.color), `${color} ${dark ? "dark" : "light"} foreground survives`);
      assert.ok(normalizeColor(style.backgroundColor), `${color} ${dark ? "dark" : "light"} tint survives`);
      const pinned = T3_PROJECT_BADGE_TEXT[color][dark ? "dark" : "light"];
      const { r, g, b } = oklchToRgbChannels(pinned);
      assert.equal(style.color, `rgb(${r}, ${g}, ${b})`, `${color} converts from its own pinned entry`);
      assert.equal(style.backgroundColor, `rgba(${r}, ${g}, ${b}, 0.14)`, `${color} tints its own entry`);
    }
  }
});

test("no badge means no badge style: the card keeps the folder icon instead", () => {
  const html = renderToStaticMarkup(React.createElement(Text as never, { style: { color: "#a5acb8" } } as never, "biock-aase"));
  assert.doesNotMatch(html, /, 0\.14\)/, "a label without a badge emits no 14% tint");
});
