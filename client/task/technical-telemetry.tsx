import type { UseQueryResult } from "@tanstack/react-query";
import { ProjectValidationSection, CompactTelemetrySummary } from "../telemetry-parts";
import type { TaskDetailRead } from "./task-dialog";
import type { Colors } from "../controls";

export function TechnicalTelemetry({ task, detailQuery, c }: {
  task: TaskDetailRead["task"];
  detailQuery: UseQueryResult<TaskDetailRead>;
  c: Colors;
}) {
  return <>
    {detailQuery.data?.telemetry && (
      <CompactTelemetrySummary
        telemetry={detailQuery.data.telemetry}
        c={c}
      />
    )}
    {task.resolution.projectValidation && (
      <ProjectValidationSection task={task} c={c} />
    )}
  </>;
}
