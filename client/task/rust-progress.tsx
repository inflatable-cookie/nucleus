import { formatSpan } from "../../shared/task-detail-summary";
import type { Colors } from "../controls";
import { useTick } from "../use-tick";
import type { RustLifecycle } from "../web/rust-board";
import { ProgressStrip } from "./progress-strip";

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return formatSpan(ms);
}

export function RustTaskProgress({
  progress,
  compact,
  barsOnly,
  c,
}: {
  progress: RustLifecycle;
  compact: boolean;
  barsOnly?: boolean;
  c: Colors;
}) {
  useTick(
    !compact && progress.steps.some((step) => step.activeSinceMs !== null)
      ? 1000
      : null,
  );
  const now = Date.now();
  const steps = progress.steps.map(
    ({ key, label, state, tone, elapsedMs, activeSinceMs, roundLabel }) => {
      const time =
        key === "queued" && progress.admittedAtMs !== null
          ? new Date(progress.admittedAtMs).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          : elapsedMs !== null || activeSinceMs !== null
            ? duration(
                (elapsedMs ?? 0) +
                  (activeSinceMs === null
                    ? 0
                    : Math.max(0, now - activeSinceMs)),
              )
            : null;
      return {
        key,
        label,
        state,
        tone,
        sub: [roundLabel, time].filter(Boolean).join(" · "),
      };
    },
  );
  return (
    <ProgressStrip
      c={c}
      compact={compact}
      steps={steps}
      subLines={2}
      barsOnly={barsOnly}
    />
  );
}
