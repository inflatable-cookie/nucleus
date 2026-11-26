import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import type { Colors } from "../controls";
import { roles, space, taskDetail, toneSurface, rustTimeline as timelineSize, type as typeScale } from "../design";
import { useTick } from "../use-tick";
import type { RustLifecycle } from "../web/rust-board";
import { ProgressStrip } from "./progress-strip";
import { Hint, metaText, toneColor } from "./rust-detail-parts";
import {
  rustTimeline,
  type TimelineContext,
  type TimelineSegment,
  type TimelineStep,
} from "./rust-timeline";

const stepStatus = { todo: "not started", current: "in progress", done: "complete", lit: "complete" };

/** The board card's slim bars, from the same reading as the detail timeline. */
export function RustTaskProgress({
  progress,
  c,
}: {
  progress: RustLifecycle;
  compact?: boolean;
  barsOnly?: boolean;
  c: Colors;
}) {
  const steps = rustTimeline(progress, { attention: "active", stateSinceMs: null, now: Date.now() });
  return (
    <ProgressStrip
      c={c}
      compact
      barsOnly
      steps={steps.map((step) => ({
        key: step.key,
        label: step.label,
        state: step.state === "lit" ? "done" : step.state,
        tone: step.tone,
        sub: step.value ?? "",
        hint: [step.label, step.value ?? stepStatus[step.state]].join(" · "),
      }))}
    />
  );
}

/**
 * The detail timeline (Spec 071): equal steps on fixed rows, a segment per round,
 * a duration for every value and the clock times in tooltips. The current value
 * ticks locally.
 */
export function RustTimeline({
  lifecycle,
  context,
  c,
}: {
  lifecycle: RustLifecycle;
  context: Omit<TimelineContext, "now">;
  c: Colors;
}) {
  const now = Date.now();
  const steps = rustTimeline(lifecycle, { ...context, now });
  useTick(steps.some((step) => step.live) ? 1000 : null);
  return (
    <View style={{ flexDirection: "row", gap: space.xs }}>
      {steps.map((step) => (
        <StepColumn key={step.key} step={step} c={c} />
      ))}
    </View>
  );
}

function StepColumn({ step, c }: { step: TimelineStep; c: Colors }) {
  const r = roles(c);
  const todo = step.state === "todo";
  const value = [step.waiting, step.value].filter(Boolean);
  const words = step.state === "lit" ? "done" : step.state;
  return (
    <View
      accessibilityLabel={`Step ${step.label}: ${words}${value.length ? ` · ${value.join(" · ")}` : ""}`}
      style={{ flex: 1, minWidth: 0 }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: timelineSize.segmentGap,
          height: timelineSize.barRow,
        }}
      >
        {step.segments.map((segment, index) => (
          <Segment key={index} segment={segment} c={c} />
        ))}
      </View>
      <Hint c={c} text={step.hint} label={`${step.label} details`} focusable={Boolean(step.hint)}>
        <Text
          numberOfLines={1}
          style={{
            ...typeScale.metadata,
            marginTop: space.xxs / 2,
            fontWeight: todo ? "400" : "600",
            color: todo ? r.muted : r.foreground,
          }}
        >
          {step.label}
        </Text>
        <Text numberOfLines={1} style={{ ...metaText(c), color: todo ? r.muted : metaText(c).color }}>
          {step.state === "current" && step.waiting === "blocked" ? (
            <>
              <Text style={{ color: toneColor(step.tone, c) }}>blocked</Text>
              {step.value ? <Text style={{ color: r.foreground }}>{` · ${step.value}`}</Text> : null}
            </>
          ) : (
            <>
              <Text style={step.live && !step.waiting ? { color: r.foreground } : undefined}>
                {step.value ?? "—"}
              </Text>
              {step.waiting ? (
                <Text style={{ color: toneColor(step.tone, c) }}>{` · ${step.waiting}`}</Text>
              ) : null}
            </>
          )}
        </Text>
      </Hint>
    </View>
  );
}

/** Web-only drift for a waiting segment (compiled keyframes); native hosts keep still stripes. */
const styles = StyleSheet.create({
  drift: {
    animationKeyframes: [{ "0%": { transform: [{ translateX: 0 }] }, "100%": { transform: [{ translateX: -timelineSize.stripe * 2 }] } }],
    animationDuration: "2.4s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  } as unknown as ViewStyle,
});

function Segment({ segment, c }: { segment: TimelineSegment; c: Colors }) {
  const r = roles(c);
  const color = segment.fill === "track" ? r.raised : toneColor(segment.tone, c);
  return (
    <Hint
      c={c}
      text={segment.hint}
      label={segment.label}
      style={{ flex: 1, minWidth: 0, paddingVertical: space.xs - 2 }}
    >
      <View
        style={{
          height: taskDetail.stepBarHeight,
          borderRadius: taskDetail.stepBarRadius,
          backgroundColor: segment.fill === "wait" ? toneSurface(color, r.raised, 0.35) : color,
          overflow: "hidden",
        }}
      >
        {segment.fill === "wait" && (
          <View style={[{ flexDirection: "row", width: "200%", height: "100%" }, styles.drift]}>
            {Array.from({ length: timelineSize.stripes }, (_, index) => (
              <View
                key={index}
                style={{
                  width: timelineSize.stripe,
                  height: "100%",
                  marginRight: timelineSize.stripe,
                  backgroundColor: color,
                }}
              />
            ))}
          </View>
        )}
      </View>
    </Hint>
  );
}
