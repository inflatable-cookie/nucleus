/** The QA admission fence's board line (papercut 26636095); pure, shared by the board and its tests. */
import { formatLocalDateTime } from "./date-time";
import type { QaFence } from "./contracts";

export function qaFenceText(fence: QaFence, now: number): string {
  if (fence.setBy.kind === "unreadable_record") return `New QA admissions are fenced: ${fence.reason}`;
  const left = Math.max(1, Math.ceil((Date.parse(fence.until) - now) / 60_000));
  const by = fence.setBy.kind === "operator" ? "the operator" : `${fence.setBy.caller}, relaying the operator`;
  return `New QA admissions are fenced until ${formatLocalDateTime(fence.until)} (${left} min left): ${fence.reason} · set by ${by}`;
}
