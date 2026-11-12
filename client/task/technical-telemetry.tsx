import { Text } from "react-native";
import type { UseQueryResult } from "@tanstack/react-query";
import { DetailSection, muted, type Colors } from "../controls";
import { formatTelemetryDuration } from "../../shared/telemetry";
import { ProjectQaFailures, ProjectQaLogWriteErrors, ProjectQaSteps } from "../planning-panel";
import { ProjectValidationSection, CompactTelemetrySummary } from "../telemetry-parts";
import type { TaskDetailRead, TaskQaRun } from "./task-dialog";
import { type as typeScale } from "../design";

export function TechnicalTelemetry({ task, detailQuery, taskQaRun, c }: {
  task: TaskDetailRead["task"];
  detailQuery: UseQueryResult<TaskDetailRead>;
  taskQaRun: TaskQaRun | undefined;
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
    {taskQaRun && (
      <DetailSection title="Milestone QA" c={c}>
        <Text style={{ color: c.foreground, fontSize: typeScale.metadata.fontSize }}>
          {taskQaRun.state}
          {taskQaRun.exitCode !== null
            ? ` · exit ${taskQaRun.exitCode}`
            : ""}
          {taskQaRun.durationMs
            ? ` · ran ${formatTelemetryDuration(taskQaRun.durationMs)}`
            : ""}
          {taskQaRun.failedStep
            ? ` · ${taskQaRun.failedStep} failed`
            : ""}
          {taskQaRun.capacityUnavailable
            ? " · QA capacity unavailable"
            : taskQaRun.capacityWait
              ? " · waiting for QA capacity"
              : ""}
        </Text>
        <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
          Base {taskQaRun.base.slice(0, 12)} ·{" "}
          {taskQaRun.stages && taskQaRun.stages.length > 1
            ? taskQaRun.stages
                .map((stage) => stage.name)
                .join(" → ")
            : taskQaRun.argv.join(" ")}{" "}
          · started {taskQaRun.startedAt.slice(0, 10)}
        </Text>
        <ProjectQaSteps
          run={taskQaRun}
          c={c}
          label={`QA steps for ${task.repoPath}`}
        />
        <ProjectQaLogWriteErrors
          run={taskQaRun}
          c={c}
          label={`QA log-write errors for ${task.repoPath}`}
        />
        <ProjectQaFailures
          run={taskQaRun}
          c={c}
          label={`QA failures for ${task.repoPath}`}
        />
        {Boolean(taskQaRun.outputTail) && (
          <Text
            selectable
            accessibilityLabel="Milestone QA output tail"
            style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
          >
            {taskQaRun.outputTail}
          </Text>
        )}
      </DetailSection>
    )}
  </>;
}
