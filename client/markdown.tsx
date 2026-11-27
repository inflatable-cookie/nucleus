import React, { useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { Parser, type Node } from "commonmark";
import { radius, roles, space, toneSurface, type, wash, type Colors } from "./design";

function children(node: Node): Node[] {
  const result: Node[] = [];
  for (let child = node.firstChild; child; child = child.next) result.push(child);
  return result;
}

/** CommonMark rendered as native text, never as HTML. */
export function Markdown({ text, c }: { text: string; c: Colors }) {
  const [source, setSource] = useState(false);
  const root = useMemo(() => new Parser().parse(text), [text]);
  const r = roles(c);
  const body = { color: r.foreground, ...type.body };
  const codeSurface = toneSurface(r.foreground, r.raised, wash.hover);
  const lines = text.split("\n");
  const inline = (node: Node, key: number): React.ReactNode => {
    const content = children(node).map(inline);
    switch (node.type) {
      case "text": case "html_inline": return node.literal;
      case "code": return <Text key={key} style={{ fontFamily: "monospace", backgroundColor: codeSurface }}>{node.literal}</Text>;
      case "softbreak": return " ";
      case "linebreak": return "\n";
      case "emph": return <Text key={key} style={{ fontStyle: "italic" }}>{content}</Text>;
      case "strong": return <Text key={key} style={{ fontWeight: "700" }}>{content}</Text>;
      case "link": {
        const destination = node.destination ?? "";
        const safe = /^(https?:|mailto:)/i.test(destination);
        return <Text key={key} accessibilityRole={safe ? "link" : undefined} onPress={safe ? () => void Linking.openURL(destination) : undefined} style={safe ? { color: r.accent, textDecorationLine: "underline" } : undefined}>{content}</Text>;
      }
      default: return <Text key={key}>{content}</Text>;
    }
  };
  const blocks = (node: Node): React.ReactNode[] => children(node).map((child, index) => {
    switch (child.type) {
      case "paragraph": case "heading": {
        const raw = lines.slice(child.sourcepos[0][0] - 1, child.sourcepos[1][0]).join("\n");
        if (child.type === "paragraph" && /^ *\|?.*\|.*\n *\|? *:?-{3,}/.test(raw))
          return <ScrollView key={index} horizontal style={{ backgroundColor: codeSurface, borderRadius: radius.control }}><Text selectable style={{ ...body, fontFamily: "monospace", padding: space.sm }}>{raw}</Text></ScrollView>;
        return <Text key={index} selectable accessibilityRole={child.type === "heading" ? "header" : undefined} style={child.type === "heading" ? { ...body, ...type.section, fontWeight: "600", marginTop: space.xs } : body}>{children(child).map(inline)}</Text>;
      }
      case "code_block": case "html_block":
        return <ScrollView key={index} horizontal style={{ backgroundColor: codeSurface, borderRadius: radius.control }}><Text selectable style={{ ...body, fontFamily: "monospace", padding: space.sm }}>{child.literal}</Text></ScrollView>;
      case "thematic_break": return <View key={index} style={{ height: 1, backgroundColor: r.hairline, marginVertical: space.xs }} />;
      case "block_quote": return <View key={index} style={{ borderLeftWidth: 1, borderLeftColor: r.muted, paddingLeft: space.sm, gap: space.xs }}>{blocks(child)}</View>;
      case "list": return <View key={index} style={{ gap: space.xs }}>{children(child).map((item, itemIndex) => <View key={itemIndex} style={{ flexDirection: "row", gap: space.xs }}><Text selectable style={body}>{child.listType === "ordered" ? `${child.listStart + itemIndex}${child.listDelimiter}` : "•"}</Text><View style={{ flex: 1, gap: space.xs }}>{blocks(item)}</View></View>)}</View>;
      default: return <View key={index} style={{ gap: space.xs }}>{blocks(child)}</View>;
    }
  });
  return <View style={{ gap: space.xs }}>
    {source ? <Text selectable style={{ ...body, fontFamily: "monospace" }}>{text}</Text> : blocks(root)}
    <Pressable accessibilityRole="button" accessibilityLabel={source ? "Show rendered text" : "Show Markdown source"} onPress={() => setSource(!source)}><Text style={{ color: r.muted, ...type.metadata }}>{source ? "Show rendered text" : "Show source"}</Text></Pressable>
  </View>;
}
