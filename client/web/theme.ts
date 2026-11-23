import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import {
  boardThemeSnapshotSchema,
  type BoardAppearance,
  type BoardPalette,
  type BoardThemeSnapshot,
} from "../../shared/web-theme";
import { wash } from "../design";
import type { BoardTheme } from "../shell/types";

const defaults: Record<BoardAppearance, BoardTheme> = {
  dark: {
    colors: {
      surface0: "#111318",
      surface1: "#1a1d24",
      surface2: "#252932",
      border: "#39404b",
      foreground: "#f1f3f5",
      foregroundMuted: "#a5acb8",
      accent: "#8caaff",
      accentForeground: "#101521",
      statusSuccess: "#71c99a",
      statusWarning: "#e9bc68",
      statusDanger: "#ef8282",
    },
  },
  light: {
    colors: {
      surface0: "#fafbfc",
      surface1: "#f1f3f6",
      surface2: "#e7ebf0",
      border: "#a0a9b6",
      foreground: "#20242c",
      foregroundMuted: "#4e5969",
      accent: "#254da8",
      accentForeground: "#ffffff",
      statusSuccess: "#1c6643",
      statusWarning: "#825000",
      statusDanger: "#a52b38",
    },
  },
};

const responseSchema = z.object({ theme: boardThemeSnapshotSchema.nullable() });

export function useWebTheme(): {
  appearance: BoardAppearance;
  theme: BoardTheme;
} {
  const media = useMemo(
    () => window.matchMedia("(prefers-color-scheme: dark)"),
    [],
  );
  const [system, setSystem] = useState<BoardAppearance>(() =>
    media.matches ? "dark" : "light",
  );
  const [snapshot, setSnapshot] = useState<BoardThemeSnapshot | null>(null);

  useEffect(() => {
    const update = () => setSystem(media.matches ? "dark" : "light");
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, [media]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const response = await fetch("/api/theme", { signal: controller.signal });
      if (!response.ok) return;
      const parsed = responseSchema.safeParse(await response.json());
      if (parsed.success && !controller.signal.aborted)
        setSnapshot(parsed.data.theme);
    }
    void load().catch(() => {});
    return () => controller.abort();
  }, []);

  return useMemo(() => {
    const preferred =
      !snapshot || snapshot.appearance === "system"
        ? system
        : snapshot.appearance;
    const other = preferred === "dark" ? "light" : "dark";
    const preferredTheme = resolvePalette(preferred, snapshot?.[preferred]);
    if (preferredTheme) return { appearance: preferred, theme: preferredTheme };
    // A published theme may have just one appearance.
    const otherTheme = resolvePalette(other, snapshot?.[other]);
    if (otherTheme) return { appearance: other, theme: otherTheme };
    return { appearance: preferred, theme: defaults[preferred] };
  }, [snapshot, system]);
}

export function resolvePalette(
  appearance: BoardAppearance,
  palette?: BoardPalette,
  color = palette && createColorResolver(),
): BoardTheme | null {
  if (!palette || !color) return null;
  const overrides = Object.fromEntries(
    Object.entries(palette.colors).flatMap(([role, value]) => {
      const resolved = value && color(value);
      return resolved ? [[role, resolved]] : [];
    }),
  );
  if (!palette.seeds && Object.keys(overrides).length === 0) return null;

  const colors = { ...defaults[appearance].colors };
  const surface = (canvas: string, foreground: string, alpha: number) =>
    color(`color-mix(in srgb, ${canvas}, ${foreground} ${alpha * 100}%)`) ??
    canvas;
  if (palette.seeds) {
    const { canvas, accent } = palette.seeds;
    const foreground = overrides.foreground ?? contrastingText(canvas);
    Object.assign(colors, {
      surface0: canvas,
      surface1: surface(canvas, foreground, wash.hover),
      surface2: surface(canvas, foreground, wash.selected),
      foreground,
      foregroundMuted: surface(canvas, foreground, 0.72),
      border: surface(canvas, foreground, 0.4),
      accent,
      accentForeground: contrastingText(accent),
    });
  }
  const resolved = { ...colors, ...overrides };
  const { surface0: canvas, foreground } = resolved;
  return {
    colors: {
      ...resolved,
      // The header starts at the stock dark palette's former list shade.
      surfaceHeader: surface(canvas, foreground, 0.07),
      surfaceNavigation: surface(canvas, foreground, 0.045),
      surfaceList: surface(canvas, foreground, 0.02),
    },
  };
}

function createColorResolver() {
  const sample = document.createElement("canvas");
  sample.width = sample.height = 1;
  const context = sample.getContext("2d", { willReadFrequently: true });
  return context ? (value: string) => srgbColor(context, value) : undefined;
}

/** The board's shared primitives and tint helper consume hex or legacy rgb/rgba. */
function srgbColor(
  context: CanvasRenderingContext2D,
  value: string,
): string | undefined {
  // The canvas ignores an invalid assignment. Try a second sentinel when the
  // result equals the first so that the sentinel itself is a valid colour.
  context.fillStyle = "#010203";
  context.fillStyle = value;
  if (context.fillStyle === "#010203") {
    context.fillStyle = "#040506";
    context.fillStyle = value;
    if (context.fillStyle === "#040506") return undefined;
  }
  const resolved = context.fillStyle;
  if (typeof resolved !== "string") return undefined;
  if (/^(#|rgba?\()/.test(resolved)) return resolved;
  context.clearRect(0, 0, 1, 1);
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (alpha === 255)
    return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
}

function contrastingText(hex: string): string {
  const seed =
    hex.length === 4 ? hex.slice(1).replace(/./g, "$&$&") : hex.slice(1);
  const rgb = Number.parseInt(seed, 16);
  const linear = (channel: number) => {
    const value = (channel & 255) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linear(rgb >> 16) +
    0.7152 * linear(rgb >> 8) +
    0.0722 * linear(rgb);
  return luminance < 0.179 ? "#ffffff" : "#000000";
}
