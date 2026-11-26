import type { HostNode } from "./render";

type Watch = {
  target: unknown;
  callback: (entries: Array<{ isIntersecting: boolean; target: unknown }>) => void;
  live: boolean;
};

/**
 * A stand-in IntersectionObserver for the test's lifetime (nucleus#1608). A page sentinel
 * observes its own node; `enter` scrolls that node into view and the observer's callback
 * runs, as a real observer does when the reader reaches the list's end. Observers start
 * quiet, so a sentinel loads only when a test scrolls it in.
 */
export function observeIntersections(t: { after(fn: () => void): void }) {
  const watches: Watch[] = [];
  class FakeObserver {
    private watch: Watch | null = null;
    constructor(private readonly callback: Watch["callback"]) {}
    observe(target: unknown) {
      this.watch = { target, callback: this.callback, live: true };
      watches.push(this.watch);
    }
    disconnect() {
      if (this.watch) this.watch.live = false;
    }
    unobserve() {}
    takeRecords() {
      return [];
    }
  }
  const globals = globalThis as { IntersectionObserver?: unknown };
  const previous = globals.IntersectionObserver;
  globals.IntersectionObserver = FakeObserver;
  t.after(() => {
    if (previous === undefined) delete globals.IntersectionObserver;
    else globals.IntersectionObserver = previous;
  });
  /**
   * Scrolls the sentinel into view for every live observer of it. A render draws new host
   * objects, so a sentinel is matched by its label: its label changes only with its page,
   * and a page change re-observes it.
   */
  const enter = (node: HostNode | undefined) => {
    // No sentinel: the list has no page left, or a page is on its way.
    if (!node) return;
    const label = node.props.accessibilityLabel;
    for (const watch of watches) {
      const target = watch.target as HostNode;
      if (watch.live && target.props.accessibilityLabel === label)
        watch.callback([{ isIntersecting: true, target: watch.target }]);
    }
  };
  return { enter };
}
