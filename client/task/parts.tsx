import React, { useState } from "react";
import { Text, View } from "react-native";
import { Disclosure, muted, row, useCardFill, type Colors } from "../controls";
import { radius, space, type as typeScale } from "../design";

/**
 * Task 538 (papercut 90104e7f): one collapsed group in the task detail. The
 * rest of the dialog is one press away and nothing is deleted.
 */
export function CollapsibleSection({
  title,
  hint,
  open,
  onToggle,
  c,
  children,
}: {
  title: string;
  hint?: string;
  open: boolean;
  onToggle: () => void;
  c: Colors;
  children: React.ReactNode;
}) {
  const fill = useCardFill(c);
  return (
    <View
      style={{
        borderRadius: radius.control,
        backgroundColor: fill,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: space.sm,
        }}
      >
        <Disclosure
          c={c}
          label={title}
          accessibilityLabel={`${title}, ${open ? "expanded" : "collapsed"}`}
          expanded={open}
          onToggle={onToggle}
        />
        {hint && (
          <Text
            numberOfLines={1}
            style={{
              ...muted(c),
              fontSize: typeScale.metadata.fontSize,
              flexShrink: 1,
            }}
          >
            {hint}
          </Text>
        )}
      </View>
      {open && (
        <View
          style={{
            gap: space.sm,
            paddingHorizontal: space.sm,
            paddingBottom: space.sm,
          }}
        >
          {children}
        </View>
      )}
    </View>
  );
}

export function DetailField({
  label,
  value,
  c,
  compact,
}: {
  label: string;
  value: string;
  c: Colors;
  compact: boolean;
}) {
  return (
    <View
      style={{
        gap: space.xxs / 2,
        minWidth: 0,
        flexGrow: 1,
        flexBasis: compact ? "100%" : 250,
      }}
    >
      <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
        {label}
      </Text>
      <Text
        selectable
        style={{ color: c.foreground, fontSize: typeScale.metadata.fontSize }}
      >
        {value}
      </Text>
    </View>
  );
}
/** A record dialog's last action result. */
export type RecordNoticeValue = { kind: "ok" | "error"; text: string };
/** The board's action runner: refreshes the board and the open records; a failure lands on the board or, with "record", the open record's notice. */
export type BoardAct = (
  fn: () => Promise<unknown>,
  into?: "board" | "record",
) => Promise<void>;
export function RecordNotice({
  notice,
  c,
}: {
  notice: RecordNoticeValue | null;
  c: Colors;
}) {
  if (!notice) return null;
  return (
    <Text
      accessibilityRole={notice.kind === "error" ? "alert" : undefined}
      accessibilityLabel={
        notice.kind === "error" ? "Record action error" : "Record action result"
      }
      style={{
        color: notice.kind === "error" ? c.statusDanger : c.foreground,
        fontSize: typeScale.metadata.fontSize,
      }}
    >
      {notice.text}
    </Text>
  );
}
