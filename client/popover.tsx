import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { View, useWindowDimensions, type ViewStyle } from "react-native";

/*
 * One overlay layer for every popover (Tom, 2026-11-08: "fix the z-index issues
 * for popovers"). A popover drawn inside its own card is painted over by the
 * cards after it, and zIndex cannot leave the card's stacking context. So each
 * shell root mounts a `PopoverHost`, and a `Popover` renders its content into
 * the host's layer, positioned from its anchor's window coordinates: below the
 * anchor, above it when the space below runs out, aligned to the anchor's right
 * edge when its left edge would run past the column. It follows scroll and
 * resize. Outside a host (a component mounted on its own) it renders inline,
 * as popovers did before.
 */

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
export type PopoverAlign = "start" | "end";
export type PopoverPlacement = {
  /** False while the anchor is scrolled out of the layer: the popover hides rather than float over unrelated content. */
  visible: boolean;
  side: "below" | "above";
  edge: PopoverAlign;
  style: { left?: number; right?: number; top?: number; bottom?: number; width?: number };
};

/** The gap kept between a popover and the layer's (or window's) edge. */
const EDGE_MARGIN = 8;

/**
 * Where a popover of `size` goes for an anchor, both in window coordinates, inside
 * `layer` and the visible `viewport`. The result is in the layer's coordinates. A
 * popover aligned to its anchor's end is positioned by `right` and one above by
 * `bottom`, so neither depends on a measured size that the position itself could change.
 */
export function placePopover({ anchor, layer, size, viewport, align = "start", gap = 4, matchAnchorWidth = false }: {
  anchor: Rect; layer: Rect; size: Size; viewport: Size; align?: PopoverAlign; gap?: number; matchAnchorWidth?: boolean;
}): PopoverPlacement {
  const bounds = {
    left: Math.max(layer.x, 0), top: Math.max(layer.y, 0),
    right: Math.min(layer.x + layer.width, viewport.width), bottom: Math.min(layer.y + layer.height, viewport.height),
  };
  const visible = anchor.y + anchor.height > bounds.top && anchor.y < bounds.bottom && anchor.x + anchor.width > bounds.left && anchor.x < bounds.right;
  const width = matchAnchorWidth ? anchor.width : size.width;
  const startFits = anchor.x + width <= bounds.right - EDGE_MARGIN;
  const endFits = anchor.x + anchor.width - width >= bounds.left + EDGE_MARGIN;
  let edge: PopoverAlign = align;
  if (edge === "start" && !startFits && endFits) edge = "end";
  else if (edge === "end" && !endFits && startFits) edge = "start";
  const style: PopoverPlacement["style"] = matchAnchorWidth ? { width } : {};
  if (edge === "end" && endFits) style.right = layer.x + layer.width - Math.min(anchor.x + anchor.width, bounds.right - EDGE_MARGIN);
  else {
    edge = "start";
    // Neither edge fits: hold the popover inside the column, its left edge first.
    style.left = Math.max(bounds.left + EDGE_MARGIN, Math.min(anchor.x, bounds.right - EDGE_MARGIN - width)) - layer.x;
  }
  const belowTop = anchor.y + anchor.height + gap;
  const roomBelow = bounds.bottom - EDGE_MARGIN - belowTop;
  const roomAbove = anchor.y - gap - (bounds.top + EDGE_MARGIN);
  const side = size.height <= roomBelow || roomBelow >= roomAbove ? "below" : "above";
  if (side === "below") style.top = belowTop - layer.y;
  else style.bottom = layer.y + layer.height - (anchor.y - gap);
  return { visible, side, edge, style };
}

type Layer = {
  /** Each open popover's latest content, by id. Written during the owner's render, read by the layer's. */
  entries: Map<number, React.ReactNode>;
  /** Writes and layer renders, counted: an owner asks the layer to render again only when it missed a write. */
  written: number; rendered: number;
  refresh: (() => void) | null;
  node: React.RefObject<View | null>;
};
const PopoverContext = createContext<Layer | null>(null);
let nextPopoverId = 1;

/** The overlay layer's test id: tests assert a popover renders here, not inside its card. */
export const POPOVER_LAYER_ID = "nucleus-popover-layer";

/**
 * The root of a shell's popovers: the Settings screen and the board each mount one.
 * Its layer is the last child, above everything the host contains.
 */
export function PopoverHost({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const layer = useRef<Layer | null>(null);
  const node = useRef<View | null>(null);
  if (!layer.current) layer.current = { entries: new Map(), written: 0, rendered: 0, refresh: null, node };
  return <PopoverContext.Provider value={layer.current}>
    <View style={{ flex: 1, minWidth: 0, minHeight: 0, ...style }}>
      {children}
      <PopoverLayer layer={layer.current} />
    </View>
  </PopoverContext.Provider>;
}

function PopoverLayer({ layer }: { layer: Layer }) {
  const [, setTick] = useState(0);
  layer.refresh = () => setTick(tick => tick + 1);
  layer.rendered = layer.written;
  return <View ref={layer.node} testID={POPOVER_LAYER_ID} pointerEvents="box-none"
    style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 1000, elevation: 1000 }}>
    {[...layer.entries].map(([id, content]) => <React.Fragment key={id}>{content}</React.Fragment>)}
  </View>;
}

type Measurable = { measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void };
/** Hosts with a DOM (the Paseo settings page, the web board) report scrolls of any element and resizes; native hosts follow window size only. */
type ListenerHost = {
  addEventListener: (type: string, listener: () => void, options?: boolean) => void;
  removeEventListener: (type: string, listener: () => void, options?: boolean) => void;
};
const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * A popover anchored to `anchor`. Mount it only while open. Inside a `PopoverHost`
 * its content renders in the host's layer; outside one it renders in place, with
 * `inlineStyle` placing it as before. `contentRef` reaches the content's box, so an
 * outside-press check can tell a press on the popover from one outside it.
 */
export function Popover({ anchor, children, align = "start", gap = 4, matchAnchorWidth = false, minWidth, atLeastAnchorWidth = false, maxWidth, inlineStyle, contentRef, pointerEvents }: {
  anchor: React.RefObject<View | null>; children: React.ReactNode; align?: PopoverAlign; gap?: number;
  /** As wide as the anchor. */ matchAnchorWidth?: boolean;
  minWidth?: number; /** Never narrower than the anchor. */ atLeastAnchorWidth?: boolean; maxWidth?: number;
  /** Where the content sits outside a host, relative to the owner's own box. */ inlineStyle?: ViewStyle;
  contentRef?: React.RefObject<View | null>; pointerEvents?: "none" | "auto" | "box-none";
}) {
  const layer = useContext(PopoverContext);
  const id = useRef(0);
  if (!id.current) id.current = nextPopoverId++;
  const viewport = useWindowDimensions();
  const [rects, setRects] = useState<{ anchor: Rect; layer: Rect } | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const measure = useCallback(() => {
    const target = anchor.current as unknown as Measurable | null, base = layer?.node.current as unknown as Measurable | null;
    if (!target?.measureInWindow || !base?.measureInWindow) return;
    target.measureInWindow((x, y, width, height) => base.measureInWindow!((lx, ly, lwidth, lheight) => {
      const next = { anchor: { x, y, width, height }, layer: { x: lx, y: ly, width: lwidth, height: lheight } };
      setRects(previous => previous && sameRect(previous.anchor, next.anchor) && sameRect(previous.layer, next.layer) ? previous : next);
    }));
  }, [anchor, layer]);
  // Measured on open, on every scroll (captured, so a scroll inside any container counts) and on resize.
  useEffect(() => {
    if (!layer) return;
    measure();
    const host = (globalThis as { window?: ListenerHost }).window;
    if (!host?.addEventListener) return;
    host.addEventListener("scroll", measure, true);
    host.addEventListener("resize", measure);
    return () => { host.removeEventListener("scroll", measure, true); host.removeEventListener("resize", measure); };
  }, [layer, measure]);
  useEffect(() => { if (layer) measure(); }, [viewport.width, viewport.height]);
  // A write the layer has not rendered asks it to render; one it already rendered in the same pass does not.
  useLayoutEffect(() => { if (layer && layer.rendered < layer.written) layer.refresh?.(); });
  useEffect(() => {
    if (!layer) return;
    const key = id.current;
    return () => { layer.entries.delete(key); layer.written++; layer.refresh?.(); };
  }, [layer]);
  if (!layer) return <View ref={contentRef} pointerEvents={pointerEvents} style={{ position: "absolute", zIndex: 40, ...inlineStyle }}>{children}</View>;
  const placement = rects && size ? placePopover({ anchor: rects.anchor, layer: rects.layer, size, viewport, align, gap, matchAnchorWidth }) : null;
  const shown = Boolean(placement?.visible);
  const floor = Math.max(minWidth ?? 0, atLeastAnchorWidth && rects ? rects.anchor.width : 0);
  layer.entries.set(id.current, <View ref={contentRef} pointerEvents={shown ? pointerEvents : "none"}
    onLayout={event => {
      const { width, height } = event.nativeEvent.layout;
      setSize(previous => previous && Math.round(previous.width) === Math.round(width) && Math.round(previous.height) === Math.round(height) ? previous : { width, height });
    }}
    style={{ position: "absolute", ...(placement ? placement.style : { top: 0, left: 0 }), opacity: shown ? 1 : 0, ...(floor ? { minWidth: floor } : {}), ...(maxWidth ? { maxWidth } : {}) }}>
    {children}
  </View>);
  layer.written++;
  return null;
}
