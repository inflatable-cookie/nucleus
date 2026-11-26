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
  // Where a keyboard reader's focus stood when it loaded the page, to resume from there.
  const pending = useRef<KeyboardPosition | null>(null);
  // A page that lands while the sentinel has focus moves focus to its first new card. The
  // sentinel stays at the end of the list, so focus left on it would skip the new cards.
  useEffect(() => {
    const start = pending.current;
    pending.current = null;
    if (start) focusAddedCard(start.root, start.at);
  }, [page]);
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
      onFocus={() => {
        pending.current = keyboardPosition(target.current);
        latest.current();
      }}
      onBlur={() => {
        pending.current = null;
      }}
      style={{ height: 1 }}
    />
  );
}

/** The elements a keyboard reader reaches, in tab order, inside `root`. */
export function keyboardOrder(root: ParentNode): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      '[tabindex]:not([tabindex="-1"]), button, a[href], input, select, textarea',
    ),
  );
}

/** The sentinel's place among the keyboard-reachable elements of the list it ends. */
export type KeyboardPosition = { root: ParentNode; at: number };

function keyboardPosition(node: HTMLElement | null | undefined): KeyboardPosition | null {
  if (!node) return null;
  const root: ParentNode | null = scrollingAncestor(node) ?? node.ownerDocument?.body ?? null;
  if (!root) return null;
  return { root, at: keyboardOrder(root).indexOf(node) };
}

/**
 * Moves focus to the element now at `at`: where the sentinel was, so the first card the
 * page added. Returns false when nothing sits there.
 */
export function focusAddedCard(root: ParentNode, at: number): boolean {
  const next = keyboardOrder(root)[at];
  if (!next) return false;
  next.focus();
  return true;
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
