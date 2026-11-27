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
