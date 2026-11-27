import type { RustPhase, RustTask } from "./rust-board";

export type RustBoardView = "needs" | "queue" | "working" | "review" | "merging" | "closing" | "history";

export const rustColumns = {
  queued: "queue",
  working: "working",
  report_ready: "review",
  blocked: "needs",
  error: "needs",
  reviewing: "review",
  merging: "merging",
  closing: "closing",
  done: "history",
  cancelled: "history",
} as const satisfies Record<RustPhase, RustBoardView>;

export function rustTaskColumn(task: RustTask): RustBoardView {
  if (task.attention === "attention") return "needs";
  return rustColumns[task.phase];
}

export function rustCardAgeAt(task: RustTask, column = rustTaskColumn(task)): number | null {
  const admitted = task.lifecycle.admittedAtMs;
  if (column === "needs") return task.stateSinceMs ?? admitted;
  if (column === "queue") return admitted;
  if (column === "history") return task.lifecycle.finishedAtMs ?? admitted;

  const stepKey = column === "working" ? "working"
    : column === "review" ? (task.phase === "report_ready" ? "report_ready" : "review")
    : column === "merging" ? "merge"
    : "close";
  return task.lifecycle.steps.find((step) => step.key === stepKey)?.enteredAtMs ?? admitted;
}

function compareNumber(a: number | null, b: number | null, newestFirst = false): number {
  const left = a ?? (newestFirst ? -Infinity : Infinity);
  const right = b ?? (newestFirst ? -Infinity : Infinity);
  return newestFirst ? right - left : left - right;
}

function compareTaskNumber(a: RustTask, b: RustTask): number {
  const byNumber = (a.number ?? Infinity) - (b.number ?? Infinity);
  if (byNumber !== 0) return byNumber;
  return a.identity.id.localeCompare(b.identity.id);
}

function canStart(task: RustTask): boolean {
  return task.phase === "queued" && task.hold === null && task.question === null && task.wait !== "prerequisite" && task.wait !== "question";
}

export function compareRustTasksForColumn(a: RustTask, b: RustTask, column: RustBoardView): number {
  if (column === "queue") {
    const startability = Number(!canStart(a)) - Number(!canStart(b));
    if (startability !== 0) return startability;
    const priority = Number(b.queuePriority === "promoted") - Number(a.queuePriority === "promoted");
    if (priority !== 0) return priority;
    const admission = compareNumber(a.lifecycle.admittedAtMs, b.lifecycle.admittedAtMs);
    if (admission !== 0) return admission;
  } else {
    const age = compareNumber(rustCardAgeAt(a, column), rustCardAgeAt(b, column), column === "history");
    if (age !== 0) return age;
  }
  return compareTaskNumber(a, b);
}

const columnOrder: RustBoardView[] = ["needs", "queue", "working", "review", "merging", "closing", "history"];

export function compareRustTasks(a: RustTask, b: RustTask): number {
  const aColumn = rustTaskColumn(a);
  const bColumn = rustTaskColumn(b);
  const byColumn = columnOrder.indexOf(aColumn) - columnOrder.indexOf(bColumn);
  return byColumn || compareRustTasksForColumn(a, b, aColumn);
}
