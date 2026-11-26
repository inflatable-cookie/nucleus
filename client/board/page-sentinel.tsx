import React, { useEffect, useRef } from "react";
import { Pressable, View } from "react-native";
import { Button, row, type Colors } from "../controls";

/**
 * The end of a paged card list (nucleus#1608). It loads the next page as it nears view:
 * an IntersectionObserver rooted at the list's nearest scrolling ancestor, with a root
 * margin of one screen, so the page arrives before the reader reaches the end. The
 * observer re-checks whenever `page` changes, so a sentinel still in view after a page
 * lands loads the next one. Keyboard focus on the sentinel loads the page too. Where no
 * observer runs, the sentinel is one "label" control instead.
 */
export function PageSentinel({
  c,
  more,
  page,
  label,
  onMore,
}: {
  c: Colors;
  /** True while the list has a page left to show. */
  more: boolean;
  /** Changes when the list grows, so the observer re-checks what is in view. */
  page: number;
  /** The next page's name, e.g. "Show 25 more tasks"; also the fallback control's text. */
  label: string;
  onMore: () => void;
}) {
  const target = useRef<HTMLElement | null>(null);
  // The observer keeps the newest callback without being recreated for each render.
  const latest = useRef(onMore);
  latest.current = onMore;
  const observable = typeof IntersectionObserver !== "undefined";
  useEffect(() => {
    const node = target.current;
    if (!more || !observable || !node) return;
    const root = scrollingAncestor(node);
    const screen =
      root?.clientHeight ||
      (typeof window !== "undefined" ? window.innerHeight : 0) ||
      800;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { root, rootMargin: `0px 0px ${screen}px 0px` },
    );
    observer.observe(node as unknown as Element);
    return () => observer.disconnect();
  }, [more, page, observable]);
  if (!more) return null;
  if (!observable)
    return (
      <View style={row}>
        <Button small c={c} text={label} label={label} onPress={() => latest.current()} />
      </View>
    );
  return (
    <Pressable
      ref={(node: unknown) => {
        target.current = node as HTMLElement | null;
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      onFocus={() => latest.current()}
      style={{ height: 1 }}
    />
  );
}

/** The nearest ancestor that scrolls itself, or null for the viewport. */
function scrollingAncestor(node: HTMLElement): Element | null {
  if (typeof getComputedStyle === "undefined") return null;
  let element = node.parentElement;
  while (element) {
    const overflow = getComputedStyle(element).overflowY;
    if (overflow === "auto" || overflow === "scroll") return element;
    element = element.parentElement;
  }
  return null;
}

/** The control's name for the next page of `count` items, e.g. "Show 25 more tasks". */
export function pageLabel(count: number, noun: string) {
  return `Show ${count} more ${noun}${count === 1 ? "" : "s"}`;
}
