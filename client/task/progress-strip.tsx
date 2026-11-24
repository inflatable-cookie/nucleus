import { useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { popover, type Colors } from "../controls";
import { Popover } from "../popover";
import type { ProgressStep } from "../../shared/task-detail-view";
import { detailToneColor } from "./task-header";
import { roles, space, taskDetail, radius, type as typeScale } from "../design";

/**
 * The task lifecycle as a strip of steps.
 * Completed steps show in green; the current step uses the state's tone;
 * upcoming steps use the muted raised bar.
 */
export function ProgressStrip({
  steps,
  compact,
  subLines = 1,
  barsOnly = false,
  c,
}: {
  steps: readonly (Omit<ProgressStep, "key"> & {
    key: string;
    hint?: string;
  })[];
  compact: boolean;
  subLines?: 1 | 2;
  barsOnly?: boolean;
  c: Colors;
}) {
  const r = roles(c);
  return (
    <View
      accessible={barsOnly || undefined}
      accessibilityRole={barsOnly ? "image" : undefined}
      accessibilityLabel={`Progress: ${steps.map((s) => `${s.label} (${s.state}${s.sub ? `, ${s.sub}` : ""})`).join(", ")}`}
      style={{
        flexDirection: "row",
        gap: compact ? space.xxs : space.xs,
        marginTop: barsOnly ? undefined : space.xs,
      }}
    >
      {steps.map((step) => {
        const barColor =
          step.state === "done"
            ? r.success
            : step.state === "current"
              ? detailToneColor(step.tone, c)
              : r.raised;
        const bar = (
          <View
            style={{
              height: barsOnly
                ? taskDetail.compactStepBarHeight
                : taskDetail.stepBarHeight,
              borderRadius: taskDetail.stepBarRadius,
              backgroundColor: barColor,
            }}
          />
        );
        if (barsOnly && step.hint) {
          return (
            <StepHint key={step.key} c={c} text={step.hint}>
              {bar}
            </StepHint>
          );
        }
        return (
          <View
            key={step.key}
            accessibilityLabel={
              barsOnly
                ? undefined
                : `Step ${step.label}: ${step.state}${step.sub ? ` · ${step.sub}` : ""}`
            }
            style={{
              flex: 1,
              minWidth: 0,
              gap: space.xxs,
            }}
          >
            {bar}
            {!barsOnly && (
              <>
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
                    numberOfLines={subLines}
                    style={{
                      color: r.muted,
                      fontSize: typeScale.metadata.fontSize,
                      lineHeight: typeScale.metadata.lineHeight,
                    }}
                  >
                    {step.sub}
                  </Text>
                )}
              </>
            )}
          </View>
        );
      })}
    </View>
  );
}

/** The strip has one accessible summary. Hover reveals one step without adding tab stops. */
function StepHint({
  c,
  text,
  children,
}: {
  c: Colors;
  text: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<View | null>(null);
  return (
    <Pressable
      ref={anchor}
      tabIndex={-1}
      onHoverIn={() => setOpen(true)}
      onHoverOut={() => setOpen(false)}
      style={{ flex: 1, minWidth: 0, paddingVertical: space.xxs }}
    >
      {children}
      {open && (
        <Popover anchor={anchor} pointerEvents="none" maxWidth={260}>
          <View
            role="tooltip"
            style={{
              ...popover(c),
              paddingHorizontal: space.xs,
              paddingVertical: space.xxs,
              borderRadius: radius.control,
            }}
          >
            <Text style={{ ...typeScale.metadata, color: roles(c).foreground }}>
              {text}
            </Text>
          </View>
        </Popover>
      )}
    </Pressable>
  );
}
