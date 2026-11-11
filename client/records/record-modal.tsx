import React from "react";
import { Text, View } from "react-native";
import { Button, Dialog, muted, type Colors } from "../controls";

export function ModalAction({ text, reason, busy, disabled, danger, onPress, c }: { text: string; reason?: string; busy: boolean; disabled?: boolean; danger?: boolean; onPress: () => void; c: Colors }) {
  return <View style={{ gap: 4 }}>
    <Button small c={c} text={text} danger={danger} disabled={busy || disabled || Boolean(reason)} onPress={onPress} />
    {reason ? <Text style={{ ...muted(c), fontSize: 11 }}>{reason}</Text> : null}
  </View>;
}
export function RecordModal({ label, title, eyebrow, compact, c, onClose, children }: { label: string; title: string; eyebrow?: React.ReactNode; compact: boolean; c: Colors; onClose: () => void; children: React.ReactNode }) {
  return <Dialog c={c} title={title} label={label} closeLabel="Close detail" bodyLabel={`${label} content`} onClose={onClose} eyebrow={eyebrow} backdropLabel={`Close ${label.charAt(0).toLowerCase()}${label.slice(1)}`} wide>
    {children}
  </Dialog>;
}
