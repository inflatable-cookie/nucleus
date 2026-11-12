import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "../shell";
import { Button, DetailSection, Field, controlFrame, controlText, muted, row, type Colors } from "../controls";
import * as api from "../../shared/contracts";
import { type CapabilityLevel, type Papercut } from "../../shared/contracts";
import { operationStateLabel } from "../../shared/operations";
import { DetailField, RecordNotice, type BoardAct, type RecordNoticeValue } from "../task/parts";
import { ModalAction, RecordModal } from "./record-modal";
import { type as typeScale, space } from "../design";

const papercutPromoteReason = (cut: Papercut) => cut.state === "open" ? undefined : cut.state === "promoted" ? "Already promoted" : "Papercut is closed";
const papercutCloseReason = (cut: Papercut) => cut.state === "closed" ? "Already closed" : undefined;

/** The papercut detail dialog. It owns its edit form, chosen complexity and close note. */
export function PapercutDialog({ id: openPapercutId, compact, busy, act, recordNotice, setRecordNotice, laneName, onClose, c }: { id: string; compact: boolean; busy: boolean; act: BoardAct; recordNotice: RecordNoticeValue | null; setRecordNotice: (notice: RecordNoticeValue | null) => void; laneName: (key: string) => string; onClose: () => void; c: Colors }) {
  const fetchPapercut = useRpc(api.papercutGet), editPapercut = useRpc(api.papercutEdit), promotePapercut = useRpc(api.papercutPromoteTask), closePapercut = useRpc(api.papercutClose);
  const [closeNote,setCloseNote] = useState("");
  // Spec 053: a promoted papercut names its complexity; nothing is preselected.
  const [papercutComplexity, setPapercutComplexity] = useState<CapabilityLevel | null>(null);
  const [papercutEditing,setPapercutEditing] = useState(false);
  const [papercutEdit,setPapercutEdit] = useState({title:"",area:"",happened:"",impact:"",fix:""});
  const papercutDetailQuery = useQuery({queryKey:["nucleus","papercut",openPapercutId],queryFn:()=>fetchPapercut({id:openPapercutId!}),enabled:Boolean(openPapercutId),refetchInterval:4000});
  const papercutDetail = papercutDetailQuery.data;
  useEffect(() => {
    if (papercutDetail && !papercutEditing) setPapercutEdit({ title: papercutDetail.title, area: papercutDetail.area ?? "", happened: papercutDetail.happened, impact: papercutDetail.impact, fix: papercutDetail.fix ?? "" });
  }, [papercutDetail?.id, papercutDetail?.version, papercutEditing, openPapercutId]);
  // Each papercut starts with no complexity chosen.
  useEffect(() => { setPapercutComplexity(null); }, [papercutDetail?.id]);
  return (
    <RecordModal
      label="Papercut detail"
      title={papercutDetail?.title ?? "Papercut"}
      compact={compact}
      c={c}
      onClose={onClose}
      eyebrow={
        papercutDetail ? (
          <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
            {papercutDetail.state} · {papercutDetail.repository.origin}
          </Text>
        ) : undefined
      }
    >
      {papercutDetailQuery.isLoading && !papercutDetail && (
        <Text style={muted(c)}>Loading papercut…</Text>
      )}
      {papercutDetailQuery.error && (
        <Text
          accessibilityRole="alert"
          style={{ color: c.statusDanger, fontSize: typeScale.metadata.fontSize }}
        >
          {String(papercutDetailQuery.error)}
        </Text>
      )}
      {papercutDetail && (
        <>
          <RecordNotice notice={recordNotice} c={c} />
          {papercutEditing ? (
            <DetailSection title="Edit papercut" c={c}>
              <Field
                c={c}
                label="Title"
                value={papercutEdit.title}
                onChange={(title) =>
                  setPapercutEdit((value) => ({ ...value, title }))
                }
              />
              <Field
                c={c}
                label="Area"
                value={papercutEdit.area}
                onChange={(area) =>
                  setPapercutEdit((value) => ({ ...value, area }))
                }
              />
              <Field
                c={c}
                label="What happened"
                value={papercutEdit.happened}
                multiline
                onChange={(happened) =>
                  setPapercutEdit((value) => ({ ...value, happened }))
                }
              />
              <Field
                c={c}
                label="Impact"
                value={papercutEdit.impact}
                multiline
                onChange={(impact) =>
                  setPapercutEdit((value) => ({ ...value, impact }))
                }
              />
              <Field
                c={c}
                label="Suggested fix"
                value={papercutEdit.fix}
                multiline
                onChange={(fix) =>
                  setPapercutEdit((value) => ({ ...value, fix }))
                }
              />
              <View style={row}>
                <ModalAction
                  text="Save changes"
                  busy={busy}
                  disabled={
                    !papercutEdit.title.trim() ||
                    !papercutEdit.happened.trim()
                  }
                  c={c}
                  onPress={() =>
                    void act(async () => {
                      const saved = await editPapercut({
                        id: papercutDetail.id,
                        version: papercutDetail.version,
                        ...papercutEdit,
                        author: "operator (board)",
                      });
                      setPapercutEditing(false);
                      setRecordNotice({
                        kind: "ok",
                        text: `Saved version ${saved.version}`,
                      });
                    }, "record")
                  }
                />
                <ModalAction
                  text="Cancel"
                  busy={busy}
                  c={c}
                  onPress={() => {
                    setPapercutEdit({
                      title: papercutDetail.title,
                      area: papercutDetail.area ?? "",
                      happened: papercutDetail.happened,
                      impact: papercutDetail.impact,
                      fix: papercutDetail.fix ?? "",
                    });
                    setPapercutEditing(false);
                  }}
                />
              </View>
            </DetailSection>
          ) : (
            <>
              <DetailSection title="What happened" c={c}>
                <Text
                  selectable
                  style={{
                    color: c.foreground,
                    fontSize: typeScale.body.fontSize,
                    lineHeight: typeScale.body.lineHeight,
                  }}
                >
                  {papercutDetail.happened}
                </Text>
              </DetailSection>
              <DetailSection title="Impact" c={c}>
                <Text
                  selectable
                  style={{
                    color: c.foreground,
                    fontSize: typeScale.body.fontSize,
                    lineHeight: typeScale.body.lineHeight,
                  }}
                >
                  {papercutDetail.impact || "None"}
                </Text>
              </DetailSection>
              <DetailSection title="Suggested fix" c={c}>
                <Text
                  selectable
                  style={{
                    color: c.foreground,
                    fontSize: typeScale.body.fontSize,
                    lineHeight: typeScale.body.lineHeight,
                  }}
                >
                  {papercutDetail.fix || "None"}
                </Text>
              </DetailSection>
              <DetailSection c={c}>
                <View
                  style={{ ...row, alignItems: "flex-start", gap: space.md }}
                >
                  <DetailField
                    label="Area"
                    value={papercutDetail.area || "None"}
                    c={c}
                    compact={compact}
                  />
                  <DetailField
                    label="Lanes"
                    value={
                      papercutDetail.lanes.length
                        ? papercutDetail.lanes.map(laneName).join(", ")
                        : "None"
                    }
                    c={c}
                    compact={compact}
                  />
                  <DetailField
                    label="Filer"
                    value={papercutDetail.filedBy}
                    c={c}
                    compact={compact}
                  />
                  <DetailField
                    label="Date"
                    value={new Date(
                      papercutDetail.filedAt,
                    ).toLocaleString()}
                    c={c}
                    compact={compact}
                  />
                </View>
              </DetailSection>
              <DetailSection title="Actions" c={c}>
                <View style={{ ...row, alignItems: "flex-start" }}>
                  <ModalAction
                    text="Edit"
                    busy={busy}
                    c={c}
                    onPress={() => {
                      setPapercutEdit({
                        title: papercutDetail.title,
                        area: papercutDetail.area ?? "",
                        happened: papercutDetail.happened,
                        impact: papercutDetail.impact,
                        fix: papercutDetail.fix ?? "",
                      });
                      setPapercutEditing(true);
                    }}
                  />
                  <ModalAction
                    text="Promote"
                    busy={busy}
                    reason={
                      papercutPromoteReason(papercutDetail) ??
                      (papercutComplexity
                        ? undefined
                        : "Choose a complexity first")
                    }
                    c={c}
                    onPress={() =>
                      void act(async () => {
                        const result = await promotePapercut({
                          id: papercutDetail.id,
                          board: true,
                          complexity: papercutComplexity!,
                        });
                        if ("backpressured" in result)
                          setRecordNotice({
                            kind: "error",
                            text: result.reason,
                          });
                        else if ("accepted" in result)
                          setRecordNotice({
                            kind: "ok",
                            text: `Promotion ${operationStateLabel(result.operation)} · operation ${result.operation.id}`,
                          });
                        else
                          setRecordNotice({
                            kind: "ok",
                            text: `Promoted as ${result.reference}`,
                          });
                      }, "record")
                    }
                  />
                </View>
                {papercutDetail.state === "open" && (
                  <View style={{ gap: space.xs, paddingTop: space.xxs }}>
                    <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
                      Complexity for the promoted task (sets how capable
                      a model each run needs)
                    </Text>
                    <View style={row}>
                      {(
                        [
                          "very_low",
                          "low",
                          "medium",
                          "high",
                          "very_high",
                        ] as const
                      ).map((level) => (
                        <Button
                          key={level}
                          small
                          c={c}
                          text={level.replaceAll("_", " ")}
                          label={`Papercut complexity ${level.replaceAll("_", " ")}`}
                          selected={papercutComplexity === level}
                          onPress={() => setPapercutComplexity(level)}
                        />
                      ))}
                    </View>
                  </View>
                )}
                <View style={{ gap: space.xs, paddingTop: space.xxs }}>
                  <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
                    Close note
                  </Text>
                  <TextInput
                    accessibilityLabel="Close note"
                    value={closeNote}
                    onChangeText={setCloseNote}
                    placeholder="Note"
                    placeholderTextColor={c.foregroundMuted}
                    style={{ ...controlFrame(c), ...controlText(c) }}
                  />
                  <View style={{ ...row, alignItems: "flex-start" }}>
                    <ModalAction
                      text="Close as completed"
                      busy={busy}
                      reason={papercutCloseReason(papercutDetail)}
                      c={c}
                      onPress={() =>
                        void act(async () => {
                          await closePapercut({
                            id: papercutDetail.id,
                            reason: "completed",
                            note: closeNote,
                          });
                          setRecordNotice({
                            kind: "ok",
                            text: "Closed as completed",
                          });
                          setCloseNote("");
                        }, "record")
                      }
                    />
                    <ModalAction
                      text="Close as deprecated"
                      busy={busy}
                      reason={papercutCloseReason(papercutDetail)}
                      c={c}
                      onPress={() =>
                        void act(async () => {
                          await closePapercut({
                            id: papercutDetail.id,
                            reason: "deprecated",
                            note: closeNote,
                          });
                          setRecordNotice({
                            kind: "ok",
                            text: "Closed as deprecated",
                          });
                          setCloseNote("");
                        }, "record")
                      }
                    />
                  </View>
                </View>
              </DetailSection>
            </>
          )}
        </>
      )}
    </RecordModal>
  );
}
