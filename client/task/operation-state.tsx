import { Text, View } from "react-native";
import { Icon } from "../shell";
import { row, type Colors } from "../controls";
import {
  operationStateLabel,
  operationOccurrenceSettlement,
  type QueueOperation,
} from "../../shared/operations";
import { space, type as typeScale } from "../design";

/** The task's recent queue operations (removal, holds and other accepted controls) and whether each settled. */
export function OperationState({
  operations,
  c,
}: {
  operations: QueueOperation[];
  c: Colors;
}) {
  if (!operations.length) return null;
  return (
    <View style={{ gap: space.xxs }}>
      {operations.slice(0, 4).map((operation) => {
        const settled = Boolean(operationOccurrenceSettlement(operation));
        const attention =
          !settled &&
          (operation.state === "needs_attention" ||
            operation.state === "failed");
        const color = attention
          ? c.statusWarning
          : settled || operation.state === "succeeded"
            ? c.foregroundMuted
            : c.accent;
        return (
          <View
            key={operation.id}
            style={{ ...row, flexWrap: "nowrap", gap: space.xs }}
          >
            <Icon
              name={
                attention
                  ? "TriangleAlert"
                  : settled || operation.state === "succeeded"
                    ? "Check"
                    : "LoaderCircle"
              }
              size={12}
              color={color}
            />
            <Text
              numberOfLines={2}
              selectable
              accessibilityLabel={operationStateLabel(operation)}
              style={{
                color,
                fontSize: typeScale.metadata.fontSize,
                flex: 1,
                minWidth: 0,
              }}
            >
              {operationStateLabel(operation)}
              {!settled && operation.diagnostic
                ? ` · ${operation.diagnostic}`
                : ""}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
