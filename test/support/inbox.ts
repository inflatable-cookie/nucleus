/**
 * The inbox board shows one menu view at a time (Tom, 2026-11-21). These helpers let a
 * test reach a card wherever its view lists it, or read every list view's text at once.
 */
type Tree = {
  press(label: string | RegExp): void;
  text(): string;
  all(label: string | RegExp): unknown[];
};

const menuEntry = (name: string) => new RegExp(`^${name}(, \\d+)?$`);
/** The Planning menu entry, whose count names its unit (nucleus#1546). */
export const planningEntry = /^Planning, \d+ open lanes$/;
/** The list views, in menu order. Working, In review and Closing are top-level entries (Tom, 2026-11-21). */
export const INBOX_LIST_VIEWS = [
  "Needs you",
  "Leads",
  "Papercuts",
  "Queue",
  "Working",
  "In review",
  "Closing",
] as const;

/** Opens one menu view. */
export function openView(tree: Tree, name: string): void {
  tree.press(menuEntry(name));
}

/** Opens the Planning view, whose entry counts its open lanes (nucleus#1546). */
export function openPlanning(tree: Tree): void {
  tree.press(planningEntry);
}

/** Visits each list view until `visit` returns true; returns whether one did. */
function eachView(tree: Tree, visit: () => boolean): boolean {
  for (const name of INBOX_LIST_VIEWS) {
    if (!tree.all(menuEntry(name)).length) continue;
    openView(tree, name);
    if (visit()) return true;
  }
  return false;
}

/** Each list view's text, joined. Leaves the last view open. */
export function inboxText(tree: Tree): string {
  const parts: string[] = [];
  eachView(tree, () => {
    parts.push(tree.text());
    return false;
  });
  return parts.join("\n");
}

/** Opens the first list view whose text matches, so its card can be pressed. Returns whether one did. */
export function showInView(tree: Tree, match: string | RegExp): boolean {
  return eachView(tree, () => {
    const text = tree.text();
    return typeof match === "string" ? text.includes(match) : match.test(text);
  });
}

type Node = { props: Record<string, any> };
type Mounted = Tree & {
  query(label: string | RegExp): Node | undefined;
  all(label: string | RegExp): Node[];
  press(label: string | RegExp, event?: unknown): void;
};
/** The labels an open record's detail carries; while one shows, the view is not switched (that would close it). */
const DETAIL = /^((Task|Lead|Papercut|Decision) detail|Loading detail)$/;

/**
 * A mounted board whose card reads reach every list view, for tests about cards rather
 * than the shell: `text` joins every view, and `query`, `all` and `press` open the view
 * that lists the label first. While a record's detail is open the view stays put, so
 * detail assertions read the open record.
 */
export function acrossViews<T extends Mounted>(tree: T): T & { raw: T } {
  // A press on anything but a menu entry pins the open view (a record may still be
  // loading, with no detail on screen yet); pressing a menu entry releases it.
  let pinned = false;
  const isMenuEntry = (label: string | RegExp) =>
    typeof label === "string"
      ? INBOX_LIST_VIEWS.some((name) => menuEntry(name).test(label)) ||
        label === "Planning" ||
        planningEntry.test(label)
      : INBOX_LIST_VIEWS.some(
          (name) => label.source === menuEntry(name).source,
        ) || label.source === planningEntry.source;
  const recordOpen = () => pinned || tree.all(DETAIL).length > 0;
  const reveal = (label: string | RegExp) => {
    if (tree.all(label).length || recordOpen()) return;
    eachView(tree, () => tree.all(label).length > 0);
  };
  return {
    ...tree,
    /** The board as mounted, for assertions about the open view itself. */
    raw: tree,
    text: () => (recordOpen() ? tree.text() : inboxText(tree)),
    query: (label: string | RegExp) => {
      reveal(label);
      return tree.query(label);
    },
    all: (label: string | RegExp) => {
      if (recordOpen() || tree.all(label).length) return tree.all(label);
      const found: Node[] = [];
      eachView(tree, () => {
        found.push(...(tree.all(label) as Node[]));
        return false;
      });
      return found;
    },
    press: (label: string | RegExp, event?: unknown) => {
      reveal(label);
      tree.press(label, event);
      // Closing a record unpins too: nothing is left loading.
      pinned =
        !isMenuEntry(label) &&
        !(typeof label === "string" && /^Close /.test(label));
    },
  };
}
