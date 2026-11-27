import React, { useRef, useState } from "react";
import { Text, View } from "react-native";
import { ActionButton, Button, DropdownSelect, Field, FieldCaption, HelpPopover, HelpTip, InlineConfirm, muted, row, type Colors } from "../controls";
import { roles, space, type } from "../design";
import { errorText } from "../error-text";
import { formatLocalDateTime } from "../../shared/date-time";
import { withoutHostPaths } from "../project-helpers";
import type { ProjectAgentView, Project } from "../../shared/contracts";
import type { OwnerCandidate, ProjectEditActions } from "./types";

const NONE = "__none__";

/** Two columns where they fit (688 and wider), one at 390. */
export function Pair({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "flex-start" }}>
    {React.Children.toArray(children).map((child, index) => <View key={index} style={{ flexGrow: 1, flexBasis: 260, minWidth: 0, gap: space.xs }}>{child}</View>)}
  </View>;
}

/** "Saved", or "Not saved" with its reason behind a (?). Saving… stays quiet. */
export function SaveWord({ c, status, name }: { c: Colors; status: string; name: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<View | null>(null);
  const r = roles(c);
  if (status === "Saved") return <Text accessibilityLabel={`${name} save status`} accessibilityLiveRegion="polite" style={{ color: r.muted, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>Saved</Text>;
  const refreshFailurePrefix = "Saved, but refresh failed:";
  const wrappedRefreshFailurePrefix = `Not saved: ${refreshFailurePrefix}`;
  const wrappedRefreshFailure = status.startsWith(wrappedRefreshFailurePrefix);
  const refreshFailed = wrappedRefreshFailure || status.startsWith(refreshFailurePrefix);
  if (!refreshFailed && !status.startsWith("Not saved")) return null;
  const reason = refreshFailed
    ? status.slice(wrappedRefreshFailure ? wrappedRefreshFailurePrefix.length : refreshFailurePrefix.length).replace(/\. Change the field to retry\.$/, "").trim()
    : status.replace(/^Not saved:\s*/, "");
  const label = refreshFailed ? "Refresh failed" : "Not saved";
  return <View ref={anchor} style={{ ...row, flexWrap: "nowrap" }}>
    <Text accessibilityLabel={`${name} save status`} accessibilityLiveRegion="polite" style={{ color: r.warning, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>{label}</Text>
    <HelpTip c={c} label={label} text={reason} open={open} onOpenChange={setOpen} />
    {open && <HelpPopover c={c} anchor={anchor} label={label} text={reason} />}
  </View>;
}

/** The planner picker: live standing threads by title, plus None. A planner that is not live stays selected as "Gone". */
