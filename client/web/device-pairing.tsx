import React, { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { z } from "zod";
import { Button, Field, LabelHelp, muted, row, type Colors } from "../controls";
import { radius, roles, space, type as typeScale } from "../design";
import { errorText } from "../error-text";
import { PopoverHost } from "../popover";
import { useTick } from "../use-tick";
import { createRustBoardTransport, requestRustBoard } from "./rust-board";

const pairCodeSchema = z.strictObject({
  code: z.string().min(1),
  expiresAtMs: z.number().int().nonnegative(),
});

export type DevicePairCode = z.infer<typeof pairCodeSchema>;

export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export async function createDevicePairCode(
  fetcher: typeof fetch = fetch,
): Promise<DevicePairCode> {
  return createRustBoardTransport(fetcher).read(pairCodeSchema, "/pair/code", {
    method: "POST",
  });
}

export async function redeemDevicePairCode(
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await requestRustBoard(
    "/pair/redeem",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    },
    fetcher,
  );
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Invalid or expired code.");
    }
    throw new Error(`Pairing failed (${response.status}).`);
  }
}

export function DevicesSettings({
  c,
  inset,
  fetcher = fetch,
  now = Date.now,
}: {
  c: Colors;
  inset: number;
  fetcher?: typeof fetch;
  now?: () => number;
}) {
  const [active, setActive] = useState<DevicePairCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remainingMs = active ? Math.max(0, active.expiresAtMs - now()) : 0;
  const expired = active !== null && remainingMs <= 0;
  useTick(active !== null && !expired ? 1000 : null);

  async function requestCode() {
    setBusy(true);
    setError("");
    try {
      setActive(await createDevicePairCode(fetcher));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView
      accessibilityLabel="Devices settings"
      style={{ flex: 1, minHeight: 0 }}
      contentContainerStyle={{ gap: space.sm, paddingBottom: inset }}
    >
      <LabelHelp
        c={c}
        label="Devices"
        text="Pair another browser or device with a short code. Each code works once, expires after 5 minutes, and replaces any earlier open code. Revoke paired devices with nucleus ui --revoke."
      />
      <View style={row}>
        <Button
          c={c}
          text="Pair a device"
          disabled={busy}
          onPress={() => void requestCode()}
        />
      </View>
      {active && (
        <View
          accessibilityLabel="Active pairing code"
          style={{
            gap: space.xs,
            padding: space.md,
            borderRadius: radius.card,
            backgroundColor: roles(c).section,
            borderWidth: 1,
            borderColor: roles(c).hairline,
            alignSelf: "flex-start",
            minWidth: 220,
          }}
        >
          <Text
            selectable
            accessibilityLabel="Device pairing code"
            style={{
              color: expired ? c.foregroundMuted : c.foreground,
              fontFamily: "monospace",
              fontSize: 22,
              fontWeight: "600",
              letterSpacing: 2,
            }}
          >
            {active.code}
          </Text>
          <Text
            accessibilityLabel="Pairing code countdown"
            accessibilityRole={expired ? "alert" : undefined}
            style={
              expired
                ? { color: c.statusWarning, fontSize: typeScale.body.fontSize }
                : muted(c)
            }
          >
            {expired
              ? "Code expired"
              : `Expires in ${formatCountdown(remainingMs)}`}
          </Text>
        </View>
      )}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

export function DevicePairPrompt({
  c,
  onPaired,
  fetcher = fetch,
}: {
  c: Colors;
  onPaired: () => void;
  fetcher?: typeof fetch;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    try {
      await redeemDevicePairCode(trimmed, fetcher);
      setCode("");
      onPaired();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PopoverHost style={{ flex: 1, width: "100%" }}>
      <View
        accessibilityLabel="Pair this device"
        style={{
          flex: 1,
          width: "100%",
          padding: space.lg,
          alignItems: "center",
          justifyContent: "flex-start",
        }}
      >
        <View
          style={{
            width: "100%",
            maxWidth: 420,
            gap: space.sm,
            padding: space.md,
            borderRadius: radius.card,
            backgroundColor: roles(c).section,
            borderWidth: 1,
            borderColor: roles(c).hairline,
          }}
        >
          <LabelHelp
            c={c}
            label="Devices"
            text="Open Settings → Devices on a paired board and select Pair a device to get a one-time code."
          />
          <View style={{ ...row, alignItems: "flex-end", flexWrap: "nowrap" }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Field
                c={c}
                label="Pairing code"
                hideLabel
                placeholder="XXXX-XXXX"
                value={code}
                onChange={(next) => {
                  setCode(next);
                  if (error) setError("");
                }}
                disabled={busy}
                invalid={Boolean(error)}
              />
            </View>
            <Button
              c={c}
              text="Pair"
              matchField
              disabled={busy || !code.trim()}
              onPress={() => void submit()}
            />
          </View>
          {error ? (
            <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>
              {error}
            </Text>
          ) : null}
        </View>
      </View>
    </PopoverHost>
  );
}
