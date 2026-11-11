/**
 * The QA admission fence on the board (papercut 26636095). The header shows the
 * fence in force with its reason, setter and countdown, and the operator's
 * Clear; the QA runs tab shows the complete unsettled QA inventory beside it.
 */
import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button, muted, row, type Colors } from "./controls";
import { qaFenceText } from "../shared/qa-fence";
import type { QaFence, QaInventoryItem } from "../shared/contracts";

/** The current time, re-read every 15 s so the countdown moves between board refreshes. */
function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(timer); }, [intervalMs]);
  return now;
}

const KIND_LABELS: Record<QaInventoryItem["kind"], string> = { qa_run: "QA run", qa_request: "QA request", host_run: "Host run" };

export function QaFenceNotice({ fence, inventory, onClear, busy = false, c }: {
  fence: QaFence; inventory?: QaInventoryItem[]; onClear?: () => void; busy?: boolean; c: Colors;
}) {
  const now = useNow();
  if (Date.parse(fence.until) <= now) return null;
  return <View accessibilityLabel="QA admission fence" style={{ gap: 6 }}>
    <View style={{ ...row, flexWrap: "wrap" }}>
      <Text accessibilityRole="alert" style={{ color: c.statusWarning, fontSize: 12, flexShrink: 1 }}>{qaFenceText(fence, now)}</Text>
      {onClear && <Button small c={c} text="Clear fence" label="Clear the QA admission fence" disabled={busy} onPress={onClear} />}
    </View>
    {inventory && <View accessibilityLabel="Unsettled QA inventory" style={{ gap: 2 }}>
      <Text style={{ ...muted(c), fontSize: 12 }}>{inventory.length
        ? `${inventory.length} unsettled QA item${inventory.length === 1 ? "" : "s"}. Swap a shared tool only once this list is empty.`
        : "No QA is unsettled."} The fence covers project QA only, not task validation or Effigy client runs.</Text>
      {inventory.map(item => <Text key={`${item.kind}:${item.id}`} style={{ ...muted(c), fontSize: 12 }}>
        {KIND_LABELS[item.kind]} {item.id.slice(0, 12)} · {item.repository || "unknown repository"} · {item.state} · {item.detail}</Text>)}
    </View>}
  </View>;
}
