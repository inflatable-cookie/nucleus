import { useContext, useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "../shell";
import { BoardLiveContext } from "../board-live";
import {
  Button,
  DetailSection,
  Field,
  controlFrame,
  controlText,
  muted,
  row,
  type Colors,
} from "../controls";
import * as api from "../../shared/contracts";
import { type CapabilityLevel, type Papercut } from "../../shared/contracts";
import { operationStateLabel } from "../../shared/operations";
import {
  DetailField,
  RecordNotice,
  type BoardAct,
  type RecordNoticeValue,
} from "../task/parts";
import { ModalAction, RecordModal } from "./record-modal";
import { useEngineFeatures } from "../engine-features";
import { ParkPanel } from "../park-controls";
import { type as typeScale, space } from "../design";

const papercutPromoteReason = (cut: Papercut) =>
  cut.state === "open"
    ? undefined
    : cut.state === "promoted"
      ? "Already promoted"
      : "Papercut is closed";
const papercutCloseReason = (cut: Papercut) =>
  cut.state === "closed" ? "Already closed" : undefined;

/** The papercut detail dialog. It owns its edit form, chosen complexity and close note. */
export function PapercutDialog({
  id: openPapercutId,
  project,
  compact,
  busy,
  act,
  recordNotice,
  setRecordNotice,
  laneName,
  onClose,
  c,
  inline = false,
}: {
  inline?: boolean;
  id: string;
  project?: string;
  compact: boolean;
  busy: boolean;
  act: BoardAct;
  recordNotice: RecordNoticeValue | null;
  setRecordNotice: (notice: RecordNoticeValue | null) => void;
  laneName: (key: string) => string;
  onClose: () => void;
  c: Colors;
}) {
  const rust = useEngineFeatures().engine === "rust";
  const live = useContext(BoardLiveContext);
  const scope = project ? { project } : {};
  const fetchPapercut = useRpc(api.papercutGet),
    editPapercut = useRpc(api.papercutEdit),
    promotePapercut = useRpc(api.papercutPromoteTask),
    closePapercut = useRpc(api.papercutClose);
  const parkLead = useRpc(api.leadPark),
    reopenLead = useRpc(api.leadReopen);
  const [closeNote, setCloseNote] = useState("");
  // Spec 053: a promoted papercut names its complexity; nothing is preselected.
  const [papercutComplexity, setPapercutComplexity] =
    useState<CapabilityLevel | null>(null);
  const [editBase, setEditBase] = useState<
    Pick<Papercut, "id" | "project" | "version"> | null
  >(null);
  const [papercutEdit, setPapercutEdit] = useState({
    title: "",
    area: "",
    happened: "",
    impact: "",
    fix: "",
  });
  const papercutDetailQuery = useQuery({
    queryKey: ["nucleus", "papercut", openPapercutId, project],
    queryFn: () => fetchPapercut({ ...scope, id: openPapercutId! }),
    enabled: Boolean(openPapercutId),
    refetchInterval: live ? false : 4000,
  });
  const papercutDetail = papercutDetailQuery.data;
  const destinations = papercutDetail?.repositories ?? (papercutDetail ? [papercutDetail.repository] : []);
  const editsMarkdown = editBase?.project !== undefined;
  // Each papercut starts with no complexity chosen.
  useEffect(() => {
    setPapercutComplexity(null);
  }, [openPapercutId, project]);
  return (
    <RecordModal
      label="Papercut detail"
      inline={inline}
      title={papercutDetail?.title ?? "Papercut"}
      compact={compact}
      c={c}
      onClose={onClose}
      eyebrow={
        papercutDetail ? (
          <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
            {papercutDetail.state} · {destinations.map(repo => repo.origin).join(", ")}
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
          style={{
            color: c.statusDanger,
            fontSize: typeScale.metadata.fontSize,
          }}
        >
          {String(papercutDetailQuery.error)}
        </Text>
      )}
      {papercutDetail && (
        <>
          <RecordNotice notice={recordNotice} c={c} />
          {editBase ? (
            <DetailSection title="Edit papercut" c={c}>
              <Field
                c={c}
                label="Title"
                value={papercutEdit.title}
                onChange={(title) =>
                  setPapercutEdit((value) => ({ ...value, title }))
                }
              />
              {!editsMarkdown && (
                <Field
                  c={c}
                  label="Area"
                  value={papercutEdit.area}
                  onChange={(area) =>
                    setPapercutEdit((value) => ({ ...value, area }))
                  }
                />
              )}
              <Field
                c={c}
                label="What happened"
                value={papercutEdit.happened}
                multiline
                onChange={(happened) =>
                  setPapercutEdit((value) => ({ ...value, happened }))
                }
              />
              {!editsMarkdown && (
                <>
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
                </>
              )}
              <View style={row}>
                <ModalAction
                  text="Save changes"
                  busy={busy}
                  disabled={
                    !papercutEdit.title.trim() || !papercutEdit.happened.trim()
                  }
                  c={c}
                  onPress={() =>
                    void act(async () => {
                      const saved = await editPapercut({
                        ...editBase,
                        ...(editsMarkdown
                          ? { title: papercutEdit.title, body: papercutEdit.happened }
                          : papercutEdit),
                        author: "operator (board)",
                      });
                      setEditBase(null);
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
                  onPress={() => setEditBase(null)}
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
                    value={new Date(papercutDetail.filedAt).toLocaleString()}
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
                    setRecordNotice(null);
                    setEditBase({
                      id: papercutDetail.id,
                      project: papercutDetail.project,
                      version: papercutDetail.version,
                    });
                    }}
                  />
                  {destinations.map(({ origin }) => (
                    <ModalAction
                      key={origin}
                      text={destinations.length > 1 ? `Promote to ${origin}` : "Promote"}
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
                            ...scope,
                            id: papercutDetail.id,
                            repository: origin,
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
                  ))}
                </View>
                <View style={{ gap: space.xs, paddingTop: space.xxs }}>
                  <Text
                    style={{
                      ...muted(c),
                      fontSize: typeScale.metadata.fontSize,
                    }}
                  >
                    Parking
                  </Text>
                  <ParkPanel
                      c={c}
                      busy={busy}
                      parked={papercutDetail.parked ?? null}
                      recheck={papercutDetail.recheck ?? null}
                      canPark={papercutDetail.state === "open"}
                      parkReason={
                        papercutDetail.state === "open"
                          ? null
                          : "Only open papercuts can be parked"
                      }
                      reopenReason={null}
                      onPark={(reason, revisitAt) =>
                        void act(async () => {
                          await parkLead({
                            ...scope,
                            id: papercutDetail.id,
                            version: papercutDetail.version,
                            reason,
                            revisitAt,
                            author: "operator (board)",
                          });
                          setRecordNotice({
                            kind: "ok",
                            text: revisitAt
                              ? "Parked. It will show as due on its recheck date."
                              : "Parked.",
                          });
                        }, "record")
                      }
                      onReopen={() =>
                        void act(async () => {
                          await reopenLead({
                            ...scope, id: papercutDetail.id,
                            version: papercutDetail.version, author: "operator (board)",
                          });
                          setRecordNotice({
                            kind: "ok",
                            text: "Back on the to-do list.",
                          });
                        }, "record")
                      }
                    />
                  {papercutDetail.state === "closed" && <ModalAction text="Reopen" busy={busy} c={c} onPress={() => void act(async () => { await reopenLead({ ...scope, id: papercutDetail.id, version: papercutDetail.version, author: "operator (board)" }); setRecordNotice({ kind: "ok", text: "Reopened." }); }, "record")} />}
                </View>
                {papercutDetail.state === "open" && (
                  <View style={{ gap: space.xs, paddingTop: space.xxs }}>
                    <Text
                      style={{
                        ...muted(c),
                        fontSize: typeScale.metadata.fontSize,
                      }}
                    >
                      Complexity for the promoted task (sets how capable a model
                      each run needs)
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
                  <Text
                    style={{
                      ...muted(c),
                      fontSize: typeScale.metadata.fontSize,
                    }}
                  >
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
                            ...scope,
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
                            ...scope,
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
