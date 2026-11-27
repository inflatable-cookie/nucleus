import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs, type HostNode } from "./support/render";
import { planningFixture } from "./support/planning-fixture";
import { planningEntry } from "./support/inbox";
import type { BoardTheme } from "../client/shell/types";

/**
 * nucleus#1531: Planning reads projects, lanes, plans, tasks and leads from
 * fixture RPC responses. Wide has separate panes. Medium drills into the
 * roadmap and opens the lane page in the modal.
 */
useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => "#000" }) as never;
const textOf = (node: HostNode | string): string =>
  typeof node === "string"
    ? node
    : node.children.map(textOf).join(" ").replace(/\s+/g, " ").trim();

async function mountBoard(
  compact: boolean,
  setup?: (fixture: Awaited<ReturnType<typeof planningFixture>>) => void,
  colors: BoardTheme["colors"] = c,
) {
  const fixture = planningFixture();
  setup?.(fixture);
  const { MainSurface } = await import("../client/queue");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke: fixture.invoke,
        children: h(MainSurface, { theme: { colors }, layout: { compact } }),
      }),
    }),
  );
  const waitFor = async (label: string | RegExp) => {
    for (let i = 0; i < 400 && !ui.query(label); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    return ui.get(label);
  };
  return {
    ui,
    waitFor,
    fixture,
    close() {
      ui.update(h("View"));
      client.clear();
    },
  };
}



test("1616 mounted: board pane dividers appear at wide widths and disappear when narrow", async () => {
  const board = await mountBoard(false);
  const { ui, waitFor } = board;
  try {
    await waitFor("Nucleus navigation");
    const panel = ui.ofType("View").find(
      (node) =>
        typeof node.props.onLayout === "function" &&
        node.props.style?.flex === 1 &&
        node.props.style?.backgroundColor === "#000",
    );
    assert.ok(panel, "the board panel reports its measured width");
    panel.props.onLayout({ nativeEvent: { layout: { width: 1280, height: 900 } } });
    assert.equal(
      ui.ofType("View").filter((node) => node.props.style?.borderRightWidth === 1).length,
      2,
      "wide menu/list/detail panes have both dividers",
    );

    panel.props.onLayout({ nativeEvent: { layout: { width: 600, height: 900 } } });
    assert.equal(
      ui.ofType("View").some((node) => node.props.style?.borderRightWidth === 1),
      false,
      "narrow stacked navigation and list have no vertical dividers",
    );
  } finally {
    board.close();
  }
});
