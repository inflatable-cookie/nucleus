import { useState } from "react";
import { Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRpc } from "../shell";
import { Button, muted, row, type Colors } from "../controls";
import { errorText } from "../error-text";
import * as api from "../../shared/contracts";
import {
  OPERATOR_BOARD_CALLER,
  type TaskControlInput,
  type TaskNext,
  type TaskNextVerb,
  type UiQueueState,
} from "../../shared/contracts";
import { NORMAL_USAGE, VerbField, verbLabel } from "./next-section";
import { RecordNotice } from "./parts";
import { roles, space, type as typeScale } from "../design";

export type VerbNotice = { kind: "ok" | "error"; text: string };

/**
 * One owner verb's fill form and confirmation, submitted as the operator at the
 * board with `next`'s prefilled args. The Overview card uses it for actions and
 * the ⋯ menu for editing verbs (route, holds, dependencies, budget), so both
 * keep the same fields, required checks and submission.
 */
export function VerbForm({
  taskId,
  verb,
  next,
  state,
  busy,
  onDone,
  onCancel,
  c,
}: {
  taskId: string;
  verb: TaskNextVerb;
  next: TaskNext;
  state: UiQueueState | undefined;
  busy: boolean;
  onDone: (notice: VerbNotice) => void;
  onCancel: () => void;
  c: Colors;
}) {
  const r = roles(c);
  const queryClient = useQueryClient();
  const setTask = useRpc(api.taskControl);
  const [verbValues, setVerbValues] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<VerbNotice | null>(null);

  const refreshTask = async () => {
    await queryClient.refetchQueries({
      queryKey: ["nucleus", "state"],
      exact: true,
    });
    await queryClient.invalidateQueries({
      queryKey: ["nucleus", "detail", taskId],
      exact: true,
    });
    await queryClient.invalidateQueries({
      queryKey: ["nucleus", "next", taskId],
      exact: true,
    });
  };

  const verbFill = verb.fill ?? [];
  const verbQualifying = verb.qualifyingFill ?? [];
  const qualifyingSupplied = verbQualifying.filter((field) =>
    verbValues[field]?.trim(),
  ).length;
  const partialQualification =
    qualifyingSupplied > 0 && qualifyingSupplied < verbQualifying.length;
  const verbMissing =
    verbFill.some(
      (field) => field !== "dependsOn" && !verbValues[field]?.trim(),
    ) || partialQualification;

  const applyVerb = () => {
    setApplying(true);
    setError(null);
    const submitted = Object.fromEntries(
      Object.entries(verbValues).filter(
        ([field, value]) => verbFill.includes(field) || value.trim(),
      ),
    );
    if (verbFill.includes("dependsOn"))
      submitted.dependsOn = verbValues.dependsOn ?? "";
    void setTask({
      ...verb.args,
      ...Object.fromEntries(
        Object.entries(submitted).map(([field, value]) => [
          field,
          field === "dependsOn"
            ? value.split(/[,\s]+/).filter(Boolean)
            : value.trim(),
        ]),
      ),
      caller: OPERATOR_BOARD_CALLER,
    } as TaskControlInput)
      .then(async (result) => {
        await refreshTask();
        if (result && typeof result === "object" && "backpressured" in result) {
          const bp = result as unknown as {
            reason: string;
            retryAfterMs: number;
          };
          setError({
            kind: "error",
            text: `${bp.reason} Retry in about ${Math.max(1, Math.round(bp.retryAfterMs / 1000))}s.`,
          });
          return;
        }
        if (result && typeof result === "object" && "accepted" in result) {
          const accepted = result as unknown as { operation: { id: string } };
          onDone({
            kind: "ok",
            text: `Accepted ${verbLabel(verb.verb)} · operation ${accepted.operation.id} is still running`,
          });
          return;
        }
        const updated = result as { phase: string };
        onDone({
          kind: "ok",
          text: `Applied ${verbLabel(verb.verb)} · phase ${updated.phase}`,
        });
      })
      .catch((err) => setError({ kind: "error", text: errorText(err) }))
      .finally(() => setApplying(false));
  };

  return (
    <>
      <View
        style={{
          gap: space.xs,
          paddingTop: space.xs,
        }}
      >
        {verbFill.map((field) => (
          <VerbField
            key={field}
            field={field}
            required={field !== "dependsOn"}
            value={verbValues[field] ?? ""}
            onChange={(value) =>
              setVerbValues((current) => ({ ...current, [field]: value }))
            }
            roleValue={
              verbValues.role ??
              (typeof verb.args?.role === "string" ? verb.args.role : "")
            }
            pool={state?.pool ?? []}
            profiles={state?.profiles ?? []}
            usage={next.routingPolicy?.usage ?? state?.usage ?? NORMAL_USAGE}
            availability={state?.availability ?? []}
            routing={
              next.routingPolicy
                ? {
                    requested: next.routingPolicy.requested,
                    climbTier: next.routingPolicy.climbTier,
                  }
                : undefined
            }
            c={c}
          />
        ))}
        {verbQualifying.length > 0 && (
          <Text
            accessibilityLabel={`Qualifying fields: ${verbQualifying.join(", ")}`}
            style={{
              ...muted(c),
              fontSize: typeScale.metadata.fontSize,
              flexShrink: 1,
            }}
          >
            {partialQualification
              ? "Supply every qualifying field or none; a partial acceptance cannot be applied."
              : "Optional, all or none: leave them empty for the ordinary path."}
          </Text>
        )}
        {verbQualifying.map((field) => (
          <VerbField
            key={field}
            field={field}
            required={false}
            value={verbValues[field] ?? ""}
            onChange={(value) =>
              setVerbValues((current) => ({ ...current, [field]: value }))
            }
            roleValue=""
            pool={state?.pool ?? []}
            profiles={state?.profiles ?? []}
            usage={next.routingPolicy?.usage ?? state?.usage ?? NORMAL_USAGE}
            availability={state?.availability ?? []}
            routing={
              next.routingPolicy
                ? {
                    requested: next.routingPolicy.requested,
                    climbTier: next.routingPolicy.climbTier,
                  }
                : undefined
            }
            c={c}
          />
        ))}
        <View style={row}>
          <Button
            small
            c={c}
            selected
            text="Apply"
            label={`Confirm ${verbLabel(verb.verb)}`}
            disabled={busy || applying || verbMissing}
            onPress={applyVerb}
          />
          <Button small c={c} text="Cancel" onPress={onCancel} />
        </View>
      </View>
      {error && <RecordNotice notice={error} c={c} />}
    </>
  );
}
