import React from "react";
import { Text, View } from "react-native";
import { roles, space, type, type Colors } from "./design";

export type ReadableBlock = { kind: "heading" | "paragraph" | "line" | "gap"; text: string };

const listItem = /^\s*(?:[-*+]|\d+[.)])\s+/;
const fence = /^\s*(`{3,}|~{3,})/;

/**
 * Planning text as the operator reads it. Markdown headings are headings, wrapped prose
 * becomes one paragraph rather than one line per source line, and list items, fenced code
 * and indented lines keep their own line. Blank lines separate blocks.
 */
export function readableBlocks(text: string): ReadableBlock[] {
  const blocks: ReadableBlock[] = [];
  let paragraph: string[] = [], inFence = false;
  const flush = () => { if (paragraph.length) { blocks.push({ kind: "paragraph", text: paragraph.join(" ") }); paragraph = []; } };
  for (const line of text.split("\n")) {
    if (inFence || fence.test(line)) {
      if (fence.test(line)) inFence = !inFence;
      flush();
      blocks.push({ kind: "line", text: line });
      continue;
    }
    const heading = /^#{1,6}\s+/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", text: line.slice(heading[0].length) });
      continue;
    }
    if (!line.trim()) { flush(); blocks.push({ kind: "gap", text: "" }); continue; }
    if (listItem.test(line) || /^\s{2,}/.test(line)) { flush(); blocks.push({ kind: "line", text: line }); continue; }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** Every block as text, with the raw characters selectable. The raw text is never rewritten. */
export function Readable({ text, c }: { text: string; c: Colors }) {
  const r = roles(c);
  const body = { color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight } as const;
  return <View style={{ gap: space.xs }}>
    {readableBlocks(text).map((block, index) => {
      if (block.kind === "gap") return <View key={index} style={{ height: space.xxs }} />;
      if (block.kind === "heading") return <Text key={index} accessibilityRole="header" selectable style={{ color: r.foreground, fontSize: type.section.fontSize, lineHeight: type.section.lineHeight, fontWeight: "600", marginTop: space.xs }}>{block.text}</Text>;
      return <Text key={index} selectable style={body}>{block.text}</Text>;
    })}
  </View>;
}
