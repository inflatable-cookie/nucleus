import React from "react";
import { Text, View } from "react-native";
import { Button, Dialog, muted, type Colors } from "../controls";
import { space, type as typeScale } from "../design";

export function ModalAction({ text, reason, busy, disabled, danger, onPress, c }: { text: string; reason?: string; busy: boolean; disabled?: boolean; danger?: boolean; onPress: () => void; c: Colors }) {
  return <View style={{ gap: space.xxs }}>
    <Button small c={c} text={text} danger={danger} disabled={busy || disabled || Boolean(reason)} onPress={onPress} />
    {reason ? <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>{reason}</Text> : null}
  </View>;
}
/** A record's detail: a modal, or in place in the inbox detail pane when `inline`. */
export function RecordModal({ label, title, eyebrow, compact, c, onClose, inline = false, children }: { label: string; title: string; eyebrow?: React.ReactNode; compact: boolean; c: Colors; onClose: () => void; inline?: boolean; children: React.ReactNode }) {
  return <Dialog c={c} title={title} wrapTitle label={label} closeLabel="Close detail" bodyLabel={`${label} content`} onClose={onClose} eyebrow={eyebrow} backdropLabel={`Close ${label.charAt(0).toLowerCase()}${label.slice(1)}`} wide inline={inline}>
    {children}
  </Dialog>;
}
