import { Text, View } from "react-native";
import type { Colors } from "../controls";
import type { ProgressStep } from "../../shared/task-detail-view";
import { detailToneColor } from "./task-header";
import { roles, space, taskDetail, type as typeScale } from "../design";

/**
 * 5-step progress strip rendered for every task (Tom: "Keep for all"):
 * Queued → Working → Review → Merge → Close.
 * Completed steps show in green; the current step uses the state's tone;
 * upcoming steps use the muted raised bar.
 */
export function ProgressStrip({
  steps,
  compact,
  c,
}: {
  steps: readonly ProgressStep[];
  compact: boolean;
  c: Colors;
}) {
  const r = roles(c);
  return (
    <View
      accessibilityLabel={`Progress: ${steps.map((s) => `${s.label} (${s.state}${s.sub ? `, ${s.sub}` : ""})`).join(", ")}`}
      style={{
        flexDirection: "row",
        gap: compact ? space.xxs : space.xs,
        marginTop: space.xs,
      }}
    >
      {steps.map((step) => {
        const barColor =
          step.state === "done"
            ? r.success
            : step.state === "current"
              ? detailToneColor(step.tone, c)
              : r.raised;
        return (
          <View
            key={step.key}
            accessibilityLabel={`Step ${step.label}: ${step.state}${step.sub ? ` · ${step.sub}` : ""}`}
            style={{
              flex: 1,
              minWidth: 0,
              gap: space.xxs,
            }}
          >
            <View
              style={{
                height: taskDetail.stepBarHeight,
                borderRadius: taskDetail.stepBarRadius,
                backgroundColor: barColor,
              }}
            />
            <Text
              numberOfLines={1}
              style={{
                color: step.state === "todo" ? r.muted : r.foreground,
                fontSize: typeScale.metadata.fontSize,
                lineHeight: typeScale.metadata.lineHeight,
                fontWeight: step.state === "todo" ? "400" : "600",
                marginTop: space.xxs / 2,
              }}
            >
              {step.label}
            </Text>
            {Boolean(step.sub) && (
              <Text
                numberOfLines={1}
                style={{
                  color: r.muted,
                  fontSize: typeScale.metadata.fontSize,
                  lineHeight: typeScale.metadata.lineHeight,
                }}
              >
                {step.sub}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}
