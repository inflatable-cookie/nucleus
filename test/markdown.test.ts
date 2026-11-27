import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { mount, useNativeStubs } from "./support/render";

useNativeStubs();
const c = new Proxy({}, { get: () => "#000" }) as never;

test("Markdown renders prose, nested lists, code, links and literal HTML", async () => {
  const { Markdown } = await import("../client/markdown");
  const source = "# Task\n\nUse `nucleus next` and **check** [the guide](https://example.com).\n\n- First\n  - Nested\n\n```sh\nnucleus next x\n```\n\n<script>alert(1)</script>";
  const ui = mount(React.createElement(Markdown, { text: source, c }));
  assert.match(ui.text(), /Task/);
  assert.match(ui.text(), /nucleus next x/);
  assert.match(ui.text(), /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(ui.text(), /```/);
  assert.equal(ui.ofType("ScrollView").length, 2);
  assert.ok(ui.ofType("Text").some(node => node.props.accessibilityRole === "link"));
  assert.ok(ui.ofType("Text").filter(node => node.props.selectable).length >= 5);
  ui.press("Show Markdown source");
  assert.ok(ui.ofType("Text").some(node => node.props.selectable && node.children.join("") === source));
});

test("Markdown renders CommonMark structure and opens only safe links", async () => {
  const { Markdown } = await import("../client/markdown");
  const { Linking } = await import("react-native");
  const source = "3. First\n4. Second\n\n> A *quoted* line with <b>inline HTML</b>.\n\n---\n\n[Guide](https://example.com/guide) and [unsafe](javascript:alert%281%29)\n\n| Name | Value |\n| --- | --- |\n| One | Two |";
  const ui = mount(React.createElement(Markdown, { text: source, c }));
  assert.match(ui.text(), /3\./);
  assert.match(ui.text(), /4\./);
  assert.match(ui.text(), /<b>inline HTML<\/b>/);
  assert.ok(ui.ofType("Text").some(node => node.props.style?.fontStyle === "italic"));
  assert.ok(ui.ofType("View").some(node => node.props.style?.borderLeftWidth === 1));
  assert.ok(ui.ofType("View").some(node => node.props.style?.height === 1));
  assert.ok(ui.ofType("ScrollView").some(node => node.children.some(child => typeof child !== "string" && child.children.join("").includes("| --- | --- |"))));
  const links = ui.ofType("Text").filter(node => node.props.accessibilityRole === "link");
  assert.equal(links.length, 1);
  await links[0]!.props.onPress();
  // The native stub records the same Linking call as the real component.
  assert.equal((Linking as unknown as { opened: string[] }).opened.at(-1), "https://example.com/guide");
  const unsafe = ui.ofType("Text").find(node => node.children.join("") === "unsafe");
  assert.equal(unsafe?.props.onPress, undefined);
});

test("code surfaces remain distinct from a raised card", async () => {
  const { Markdown } = await import("../client/markdown");
  const { roles } = await import("../client/design");
  const colors = { foreground: "#f5f5f5", foregroundMuted: "#888888", surface0: "#000000", surface1: "#111111", surface2: "#1c1c1c", border: "#333333", accent: "#346cf1" } as never;
  const ui = mount(React.createElement(Markdown, { text: "`inline`\n\n```\nblock\n```\n\n| A | B |\n| --- | --- |\n| x | y |\n\n<div>HTML</div>", c: colors }));
  const raised = roles(colors).raised;
  const inline = ui.ofType("Text").find(node => node.children.join("") === "inline");
  assert.notEqual(inline?.props.style.backgroundColor, raised);
  assert.equal(ui.ofType("ScrollView").length, 3);
  assert.ok(ui.ofType("ScrollView").every(node => node.props.style.backgroundColor !== raised));
});
