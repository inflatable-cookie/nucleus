import React, { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View, type TextStyle, type ViewStyle } from "react-native";
import { Icon } from "./shell";
import { caption, control, overlay, radius, roles, space, touchSlop, touchTarget, type, type Colors } from "./design";
import { createAutoSave, type AutoSave } from "../shared/autosave";
import { Popover, PopoverHost } from "./popover";
import { useFocusVisible } from "./focus-modality";

export type { Colors } from "./design";
export const row: ViewStyle = { flexDirection: "row", flexWrap: "wrap", gap: space.xs, alignItems: "center" };
export const muted = (c: Colors) => ({ color: c.foregroundMuted, fontSize: type.body.fontSize });
/** Popover and help-panel chrome: a raised bordered surface with a soft shadow. */
const popover = (c: Colors) => ({ borderWidth: 1, borderColor: roles(c).border, backgroundColor: roles(c).raised, shadowColor: overlay.shadow, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 6, elevation: 8 });

/**
 * The focus ring. Controls show it only for keyboard focus (`useFocusVisible`), never
 * after a click or tap (Tom, 2026-11-09). It is an inset overlay inside the control's
 * own bounds, so no clipping parent can cut it off and focusing never moves the
 * layout; it takes the control's corners.
 */
function FocusRing({ c, visible, corner = radius.control, corners }: { c: Colors; visible: boolean; corner?: number; /** Per-corner radii, for a joined button. */ corners?: ViewStyle }) {
  if (!visible) return null;
  return <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, borderRadius: corner, ...corners, borderWidth: 2, borderColor: roles(c).focus }} />;
}
/**
 * The browser's own focus outline, off: it draws outside the control, where a clipping
 * parent cuts it, and on a text field after a click. Every control here that sets it
 * shows focus itself, with the ring or the control frame's focus border.
 */
const noOutline = (): ViewStyle => (globalThis as { document?: unknown }).document
  // A DOM host (React Native Web). Chrome's focus-visible outline is `outline-style: auto`,
  // which ignores a zero width; React Native's types know no `none`, but React Native Web
  // passes it through to CSS. Native hosts have no browser outline and no `none` value.
  ? { outlineWidth: 0, outlineStyle: "none" as ViewStyle["outlineStyle"] }
  : {};
/**
 * The frame every text input, select trigger and stepper number shares: one height,
 * padding, radius and border. The border is neutral at rest, the focus role only on
 * focus, and the danger role while invalid, whatever the focus. Holding a value never
 * colours it.
 */
export function controlFrame(c: Colors, { focused = false, invalid = false, compact = false }: { focused?: boolean; invalid?: boolean; compact?: boolean } = {}): ViewStyle {
  const size = compact ? control.compact : control;
  const r = roles(c);
  return { minHeight: size.height, paddingHorizontal: size.paddingX, paddingVertical: (size.height - (space.xxs / 2) * control.border - size.text.lineHeight) / (space.xxs / 2),
    borderRadius: control.radius, borderWidth: control.border, borderColor: invalid ? r.danger : focused ? r.focus : r.border, backgroundColor: r.section };
}
/** A control's value text: the one value font, in the foreground role. */
export const controlText = (c: Colors, compact = false): TextStyle => {
  const text = compact ? control.compact.text : control.text;
  return { color: roles(c).foreground, fontSize: text.fontSize, lineHeight: text.lineHeight };
};
/** The caption above any field. */
export const captionText = (c: Colors): TextStyle => ({ color: roles(c).muted, fontSize: caption.fontSize, lineHeight: caption.lineHeight });
export function Button({ text, label, icon, iconOnly = false, onPress, c, selected, checked, matchField = false, disabled, small = false, danger = false, hint, wrap = false, joined }: { text: string; label?:string; icon?:string; iconOnly?:boolean; onPress: () => void; c: Colors; selected?: boolean; /** An on/off toggle: a switch whose checked state shows as the selected styling. */ checked?: boolean; /** The one control height, so it lines up with a text input or select on the same row. */ matchField?: boolean; disabled?: boolean; small?: boolean; danger?: boolean; /** The explanation on hover or focus. Pass the reason an action is unavailable here, so a screen reader hears it too. */ hint?: string; /** Let a long label wrap inside its row instead of overflowing it. */ wrap?: boolean; /** Square the inner corners so this button can share a border with a chevron. */ joined?: "start" | "end" }) {
  const [hovered,setShowHint]=useState(false);
  const focus = useFocusVisible();
  // Keyboard focus shows the tooltip; the focus a dialog hands its first control after a click does not.
  const showHint = hovered || focus.visible;
  const anchor = useRef<View | null>(null);
  const r = roles(c);
  const on = checked ?? selected;
  const backgroundColor=danger?r.danger:on?r.accent:r.raised;
  const foregroundColor=danger?r.onDanger:on?r.onAccent:r.foreground;
  // The visual stays compact; hitSlop lifts the responder to the 44-point target.
  const height = matchField || iconOnly ? control.height : small ? 30 : touchTarget;
  const corners = joined === "start" ? { borderTopLeftRadius: radius.control, borderBottomLeftRadius: radius.control, borderTopRightRadius: 0, borderBottomRightRadius: 0 }
    : joined === "end" ? { borderTopRightRadius: radius.control, borderBottomRightRadius: radius.control, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }
    : { borderRadius: radius.control };
  return <Pressable ref={anchor} accessibilityRole={checked === undefined ? "button" : "switch"} accessibilityLabel={label??text} accessibilityHint={iconOnly?text:hint} accessibilityState={checked === undefined ? { selected, disabled } : { checked, disabled }} disabled={disabled} onPress={() => { if (hint) setShowHint(true); onPress(); }}
    hitSlop={touchSlop(height)}
    onHoverIn={()=>setShowHint(true)} onHoverOut={()=>setShowHint(false)} onFocus={focus.onFocus} onBlur={()=>{ focus.onBlur(); setShowHint(false); }}
    style={{ minHeight: height, minWidth: iconOnly || matchField ? control.height : undefined, alignItems:"center", justifyContent: "center", paddingHorizontal: iconOnly ? space.xs : small ? space.xs : space.sm, paddingVertical: small ? space.xxs : space.xs, ...corners,
      zIndex:(iconOnly||hint)&&showHint?40:0,
      backgroundColor, opacity: disabled ? 0.45 : 1, ...noOutline(), ...(wrap ? { maxWidth: "100%", flexShrink: 1 } : {}) }}>
    <FocusRing c={c} visible={focus.visible} corners={corners} />
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, ...(wrap ? { maxWidth: "100%", flexShrink: 1 } : {}) }}>{icon && <Icon name={icon} size={small ? 14 : 16} color={foregroundColor} />}
      {!iconOnly&&<Text style={{ color: foregroundColor, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight, ...(wrap ? { flexShrink: 1 } : {}) }}>{text}</Text>}</View>
    {iconOnly&&showHint&&<Popover anchor={anchor} align="end" pointerEvents="none" inlineStyle={{top:control.height + space.xxs,right:0}}><View pointerEvents="none" style={{paddingHorizontal:space.xs,paddingVertical:space.xxs,borderRadius:radius.control,...popover(c)}}><Text numberOfLines={1} style={{color:r.foreground,fontSize:type.metadata.fontSize}}>{text}</Text></View></Popover>}
    {!iconOnly&&hint&&showHint&&<Popover anchor={anchor} align="end" pointerEvents="none" maxWidth={460} inlineStyle={{top:"100%",right:0,marginTop:space.xxs,maxWidth:460}}><View pointerEvents="none" style={{padding:space.xs,borderRadius:radius.control,...popover(c)}}><Text style={{color:r.foreground,fontSize:type.metadata.fontSize,lineHeight:type.metadata.lineHeight}}>{hint}</Text></View></Popover>}
  </Pressable>;
}
/**
 * The one icon for each common action (nucleus#999). Every page draws the same
 * action with the same icon; `ActionButton` is the only way to place one.
 */
export const ACTION_ICONS = {
  add: "Plus", remove: "Trash2", duplicate: "Copy", edit: "Pencil", refresh: "RefreshCw", close: "X",
  moveInto: "FolderInput", pause: "Pause", resume: "Play", primary: "Star",
} as const;
export type Action = keyof typeof ACTION_ICONS;
/**
 * An icon-only button for a common action: the action's one icon, a tooltip on
 * hover or keyboard focus, and an accessible label naming the action and its
 * object ("Add profile", "Remove Opus Oracle"). `tip` replaces the tooltip when
 * it says more than the label, such as a catalog's age or why the action is
 * unavailable. Icon actions are never filled with the danger colour: a removal's
 * danger shows on its confirm. `busy` spins the icon while the action runs.
 */
export function ActionButton({ c, action, label, tip, busy = false, disabled, onPress }: {
  c: Colors; action: Action; label: string; tip?: string; busy?: boolean; disabled?: boolean; onPress: () => void;
}) {
  return <Button iconOnly c={c} icon={busy ? "LoaderCircle" : ACTION_ICONS[action]} text={tip ?? label} label={label} disabled={disabled || busy} onPress={onPress} />;
}
/**
 * One row of tabs: the main surface's Tasks / Planning / QA runs and the Settings
 * sections (nucleus#963). Each tab is a small button, ticked when it is the open
 * one; `text` is what shows and `label` the full accessible name. `nowrap` holds
 * the row on one line, for a set of tabs measured to fit its narrowest host.
 */
export function TabRow<Id extends string>({ c, label, tabs, value, onChange, nowrap = false }: {
  c: Colors; label: string; tabs: readonly { id: Id; text: string; label?: string }[]; value: Id; onChange: (id: Id) => void; nowrap?: boolean;
}) {
  return <View accessibilityLabel={label} style={nowrap ? { ...row, flexWrap: "nowrap" } : row}>
    {tabs.map(tab => <Button key={tab.id} small c={c} text={tab.text} label={tab.label} selected={value === tab.id} onPress={() => onChange(tab.id)} />)}
  </View>;
}
/**
 * A plain status glyph: an icon in its own colour, no box, with the status as an
 * overlay tooltip on hover, focus or press and as its accessible label. A problem
 * passes the warning colour; an option passes the muted one.
 */
export function StatusGlyph({ c, icon, color, text, label }: { c: Colors; icon: string; color: string; text: string; label: string }) {
  const [showHint, setShowHint] = useState(false);
  const focus = useFocusVisible();
  const anchor = useRef<View | null>(null);
  const r = roles(c);
  return <Pressable ref={anchor} accessibilityRole="image" accessibilityLabel={label} accessibilityHint={text} onPress={() => setShowHint(open => !open)}
    hitSlop={touchSlop(20)} onHoverIn={() => setShowHint(true)} onHoverOut={() => setShowHint(false)}
    onFocus={() => { focus.onFocus(); setShowHint(true); }} onBlur={() => { focus.onBlur(); setShowHint(false); }}
    style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center", borderRadius: radius.control, ...noOutline() }}>
    <FocusRing c={c} visible={focus.visible} corner={10} />
    <Icon name={icon} size={16} color={color} />
    {showHint && <Popover anchor={anchor} align="end" pointerEvents="none" inlineStyle={{ top: 20 + space.xxs, right: 0 }}><View pointerEvents="none" style={{ paddingHorizontal: space.xs, paddingVertical: space.xxs, borderRadius: radius.control, ...popover(c) }}><Text numberOfLines={1} style={{ color: r.foreground, fontSize: type.metadata.fontSize }}>{text}</Text></View></Popover>}
  </Pressable>;
}
/**
 * A small (?) beside a label; its owner renders the explanation (`HelpPopover`)
 * anchored to the label's row. Hover or focus opens it, press toggles it, and a press that
 * closes it keeps hover from reopening it until the pointer leaves (review #600).
 */
export function HelpTip({ c, label, text, open, onOpenChange }: { c: Colors; label: string; text: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [suppressed, setSuppressed] = useState(false);
  const focus = useFocusVisible();
  const r = roles(c);
  return <Pressable accessibilityRole="button" accessibilityLabel={`${label} help`} accessibilityHint={text} accessibilityState={{ expanded: open }}
    onHoverIn={() => { if (!suppressed) onOpenChange(true); }} onHoverOut={() => { setSuppressed(false); onOpenChange(false); }}
    onFocus={() => { focus.onFocus(); if (!suppressed) onOpenChange(true); }} onBlur={() => { focus.onBlur(); setSuppressed(false); onOpenChange(false); }}
    onPress={() => { if (open) { setSuppressed(true); onOpenChange(false); } else onOpenChange(true); }} hitSlop={touchSlop(18)}
    style={{ width: 18, height: 18, borderRadius: radius.control, borderWidth: 1, borderColor: r.muted, alignItems: "center", justifyContent: "center", ...noOutline() }}>
    <FocusRing c={c} visible={focus.visible} corner={9} />
    <Text style={{ color: r.muted, fontSize: type.metadata.fontSize, fontWeight: "600", lineHeight: type.metadata.lineHeight }}>?</Text>
  </Pressable>;
}
/** The explanation a `HelpTip` opens: as wide as its text, never past 420 points or the column. */
export function HelpPanel({ c, label, text }: { c: Colors; label: string; text: string }) {
  return <View accessibilityLabel={`${label} help text`} pointerEvents="none" style={{ maxWidth: 420, padding: space.xs, borderRadius: radius.control, ...popover(c) }}>
    <Text style={{ color: roles(c).foreground, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>{text}</Text>
  </View>;
}
/** A `HelpPanel` in the popover layer, under `anchor` (the row holding the label and its (?)). */
export function HelpPopover({ c, anchor, label, text }: { c: Colors; anchor: React.RefObject<View | null>; label: string; text: string }) {
  return <Popover anchor={anchor} pointerEvents="none" maxWidth={420} inlineStyle={{ top: "100%", left: 0, right: 0, marginTop: space.xxs }}>
    <HelpPanel c={c} label={label} text={text} />
  </Popover>;
}
/** A label with its (?) explanation, for a control or a status whose name cannot carry the meaning alone. */
export function LabelHelp({ c, label, text, color }: { c: Colors; label: string; text: string; color?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<View | null>(null);
  return <View ref={anchor} style={{ ...row, flexWrap: "nowrap" }}>
    <Text accessibilityRole={color ? "alert" : undefined} style={color ? { color, fontSize: type.body.fontSize, flexShrink: 1 } : muted(c)}>{label}</Text>
    <HelpTip c={c} label={label} text={text} open={open} onOpenChange={setOpen} />
    {open && <HelpPopover c={c} anchor={anchor} label={label} text={text} />}
  </View>;
}
/**
 * The caption above a field: one size whether or not a (?) sits beside it, and the
 * (?)'s height even without one, so captions on the same row line up.
 */
export function FieldCaption({ c, text, help }: { c: Colors; text: string; help?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<View | null>(null);
  return <View ref={anchor} style={{ ...row, flexWrap: "nowrap", minHeight: 18 }}>
    <Text style={{ ...captionText(c), flexShrink: 1 }}>{text}</Text>
    {help && <HelpTip c={c} label={text} text={help} open={open} onOpenChange={setOpen} />}
    {open && help && <HelpPopover c={c} anchor={anchor} label={text} text={help} />}
  </View>;
}
// The bundled React types declare HTMLInputElement without `value`, so the change
// event's target is read through a narrow type.
const inputValue = (event: { target: unknown }) => (event.target as { value: string }).value;
/** A text input's box: the shared control frame and value font. Focus shows on the border, so the field keeps its size. */
const fieldBox = (c: Colors, focused: boolean, multiline = false, invalid = false) => ({
  ...controlFrame(c, { focused, invalid }), ...controlText(c), ...noOutline(),
  ...(multiline ? { minHeight: 120, paddingVertical: space.xs } : {}),
});
/**
 * A whole-number control: − and + buttons at the one control height with the bold number between them,
 * Role demand's look (Tom, 2026-11-08). The number is directly editable in place: a
 * borderless text field the same width and font, digits only (a leading minus where
 * the range allows), clamped to the range when typing ends. Arrow up and down step
 * it while focused. A value in range reports as it is typed, so its owner autosaves
 * as before. `label` and `card` are optional: Role demand and Task slots show both,
 * a project override row shows the bare control. `stacked` puts the label on its own
 * line above a left-aligned control, for long labels such as the Advanced limits
 * (Tom, 2026-11-08). In either mode a label wraps only between words: inline, the
 * control moves under a label that no longer fits beside it. With `onClear` the
 * value may be null: the field is empty and shows `placeholder` (an inherited
 * value) in the muted colour; − and + step from it, and emptying the field clears.
 */
export function NumberStepper({ c, a11yLabel, value, min, max, onChange, onCommit, onClear, placeholder, label, card = false, stacked = false, format, unit, disabled = false, decreaseLabel, increaseLabel, style, children }: {
  c: Colors; a11yLabel: string; /** Null only with `onClear`: empty, showing `placeholder`. */ value: number | null; min: number; max: number; onChange: (value: number) => void;
  /** Emptying the field clears the value (an inherited setting); without it an empty field restores the value. */ onClear?: () => void;
  /** The value in force while empty, shown muted. */ placeholder?: number;
  /** Typing ended (blur or Enter): flush a pending save. */ onCommit?: () => void;
  label?: string; card?: boolean; /** The label on its own line, the control below it. */ stacked?: boolean; /** How the number reads at rest, e.g. a signed offset. */ format?: (value: number) => string;
  /** A unit word after the control, e.g. "min". */ unit?: string; disabled?: boolean; decreaseLabel?: string; increaseLabel?: string;
  style?: ViewStyle; /** Shown under the row, inside the card: a note such as the value in force. */ children?: React.ReactNode;
}) {
  const r = roles(c);
  // The text while the field is being edited; null shows the value itself.
  const [text, setText] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const clamp = (next: number) => Math.max(min, Math.min(max, next));
  // An empty value steps from the value in force.
  const base = value ?? placeholder ?? min;
  const step = (by: number) => {
    const next = clamp(base + by);
    if (text !== null) setText(String(next));
    if (next !== value) onChange(next);
  };
  const edit = (raw: string) => {
    if (disabled) return;
    const digits = raw.replace(/[−–]/g, "-").replace(/[^0-9-]/g, "");
    const cleaned = (min < 0 && digits.startsWith("-") ? "-" : "") + digits.replace(/-/g, "");
    setText(cleaned);
    if (/^-?\d+$/.test(cleaned) && Number(cleaned) >= min && Number(cleaned) <= max && Number(cleaned) !== value) onChange(Number(cleaned));
  };
  const commit = () => {
    if (text !== null && /^-?\d+$/.test(text) && clamp(Number(text)) !== value) onChange(clamp(Number(text)));
    else if (text === "" && onClear && value !== null) onClear();
    setText(null);
    onCommit?.();
  };
  // As wide as Role demand's number, wider only for a range with more digits.
  const width = Math.max(space.md + space.xs, Math.max(String(max).length, String(min).length) * 9 + 6);
  const stepper = <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
    <Button matchField c={c} text="−" label={decreaseLabel ?? `Decrease ${a11yLabel}`} disabled={disabled || base <= min} onPress={() => step(-1)} />
    <View>
      {/* A text field: its focus shows on any focus, since you type into it after clicking. */}
      <FocusRing c={c} visible={focused} />
      <TextInput accessibilityLabel={a11yLabel} accessibilityValue={{ min, max, now: base, ...(value === null ? { text: `Inherited, ${base}` } : {}) }} accessibilityState={{ disabled }} editable={!disabled}
        value={text ?? (value === null ? "" : format ? format(value) : String(value))} onChangeText={edit}
        placeholder={value === null && placeholder !== undefined ? (format ? format(placeholder) : String(placeholder)) : undefined} placeholderTextColor={r.muted}
        onFocus={() => { setFocused(true); setText(value === null ? "" : String(value)); }} onBlur={() => { setFocused(false); commit(); }} onSubmitEditing={commit}
        onKeyPress={event => {
          const key = event.nativeEvent.key;
          if (key !== "ArrowUp" && key !== "ArrowDown") return;
          (event as unknown as { preventDefault?: () => void }).preventDefault?.();
          step(key === "ArrowUp" ? 1 : -1);
        }}
        keyboardType={min < 0 ? "numbers-and-punctuation" : "number-pad"} autoCapitalize="none" autoCorrect={false} selectTextOnFocus
        style={{ width, height: control.height, padding: 0, margin: 0, borderWidth: 0, backgroundColor: "transparent", outlineWidth: 0, color: r.foreground, fontWeight: "600",
          fontSize: control.text.fontSize, lineHeight: control.text.lineHeight, textAlign: "center", opacity: disabled ? 0.45 : 1 }} />
    </View>
    <Button matchField c={c} text="+" label={increaseLabel ?? `Increase ${a11yLabel}`} disabled={disabled || base >= max} onPress={() => step(1)} />
    {unit && <Text style={{ ...muted(c), fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>{unit}</Text>}
  </View>;
  if (!label && !card && !children) return style ? <View style={style}>{stepper}</View> : stepper;
  return <View style={{ ...(card ? { ...sectionCard(c), flexGrow: 1, flexBasis: 200 } : {}), gap: space.xxs, ...style }}>
    {stacked ? <>
      {label && <Text style={{ color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>{label}</Text>}
      <View style={{ flexDirection: "row", justifyContent: "flex-start" }}>{stepper}</View>
    </> : <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
      {/* The label keeps its words whole: it never shrinks below its own width, so a tight card wraps the control instead. */}
      {label && <Text style={{ color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight, flexGrow: 1, flexShrink: 0, maxWidth: "100%" }}>{label}</Text>}
      <View style={{ marginLeft: "auto" }}>{stepper}</View>
    </View>}
    {children}
  </View>;
}
/**
 * A slider over a few named stops: one continuous track from the first stop's centre to the last,
 * filled with the accent up to the chosen stop, and a small ringed circle per stop. Each stop has an
 * invisible 44-point target laid over the track, so the line never breaks; a screen reader adjusts it.
 * `value` is a stop or null (nothing chosen yet, so no stop is marked). Labels sit centred under their
 * stops, the first and last held inside the column; `captions={false}` drops them when the owner shows
 * the chosen value beside the field's label instead (Cost and Capability, Tom 2026-11-08). An adjust
 * from unset starts at `unsetStop`, else the middle stop.
 */
export function StopSlider<T extends string>({ c, a11yLabel, stopLabel, stops, value, labelFor, captions = true, disabled = false, unsetStop, onChange }: {
  c: Colors; a11yLabel: string; /** Each stop's accessible name. */ stopLabel: (stop: T) => string; stops: readonly T[]; value: T | null;
  labelFor: (stop: T) => string; captions?: boolean; disabled?: boolean; unsetStop?: T; onChange: (stop: T) => void;
}) {
  const r = roles(c);
  const index = value === null ? -1 : stops.indexOf(value);
  const last = stops.length - 1;
  const at = (i: number) => `${(i / last) * 100}%` as const;
  const half = touchTarget / 2;
  // The first and last stop centres sit this far in, so the larger chosen circle stays inside the column.
  const edge = 10;
  const caption = { fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight };
  return <View style={{ gap: space.xxs, minWidth: 0, opacity: disabled ? 0.45 : 1 }}>
    <View accessibilityRole="adjustable" accessibilityLabel={`${a11yLabel} slider, ${index < 0 ? "not set" : labelFor(stops[index])}`}
      accessibilityValue={{ min: 0, max: last, ...(index < 0 ? {} : { now: index }), text: index < 0 ? "Not set" : labelFor(stops[index]) }}
      accessibilityState={{ disabled }} accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={event => { if (disabled) return; const next = index < 0 ? (unsetStop ? stops.indexOf(unsetStop) : Math.floor(stops.length / 2)) : index + (event.nativeEvent.actionName === "increment" ? 1 : -1); if (next >= 0 && next <= last) onChange(stops[next]); }}
      style={{ height: touchTarget, marginHorizontal: edge }}>
      {/* The track runs centre to centre: a 4-point line, filled up to the chosen stop. */}
      <View style={{ position: "absolute", left: 0, right: 0, top: half - 2, height: 4, borderRadius: radius.control, backgroundColor: r.raised }} />
      {index > 0 && <View style={{ position: "absolute", left: 0, width: at(index), top: half - 2, height: 4, borderRadius: radius.control, backgroundColor: r.accent }} />}
      {stops.map((stop, i) => {
        const chosen = i === index, filled = i <= index, size = chosen ? 18 : 12;
        // An invisible 44-point target centred on the stop, laid over the track.
        return <Pressable key={stop} accessibilityRole="button" accessibilityLabel={stopLabel(stop)} accessibilityState={{ selected: chosen, disabled }} disabled={disabled} onPress={() => onChange(stop)}
          style={{ position: "absolute", left: at(i), top: 0, marginLeft: -half, width: touchTarget, height: touchTarget, alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: filled ? r.accent : r.raised,
            borderWidth: chosen ? 2 : 1, borderColor: chosen ? r.foreground : filled ? r.accent : r.muted }} />
        </Pressable>;
      })}
    </View>
    {captions && <View style={{ height: caption.lineHeight, marginHorizontal: edge }}>
      {stops.map((stop, i) => {
        const style = { ...caption, color: stop === value ? r.foreground : r.muted, fontWeight: stop === value ? "600" as const : "400" as const };
        // Middle labels centre under their stop; the first and last align to the column's edges.
        const place = i === 0 ? { left: -edge, textAlign: "left" as const }
          : i === last ? { right: -edge, textAlign: "right" as const }
          : { left: at(i), width: 96, marginLeft: -96 / 2, textAlign: "center" as const };
        return <Text key={stop} numberOfLines={1} style={{ position: "absolute", top: 0, ...place, ...style }}>{labelFor(stop)}</Text>;
      })}
    </View>}
  </View>;
}
/** A choice in an anchored dropdown: the stored value and its visible label. `group` renders a header above the first option of each group. */
export type DropdownOption = { value: string; label: string; group?: string };

/** Hosts with a DOM (the Paseo settings page, the web board) dismiss an open dropdown on an outside press or Escape; native hosts skip the listeners. */
type DocumentHost = {
  addEventListener: (type: string, listener: (event: { key?: string; target?: unknown }) => void) => void;
  removeEventListener: (type: string, listener: (event: { key?: string; target?: unknown }) => void) => void;
};

/**
 * An anchored dropdown for a simple choice: the board's `SelectFilter` pattern,
 * shared so Settings and the board change together. The menu opens under its
 * trigger — never a full-screen dialog — in the popover layer, so it draws over
 * what follows (Tom, 2026-11-08). It is as wide as its longest option, never
 * narrower than the trigger or 160 points; near the right edge it aligns to the
 * trigger's right edge. It ticks the current value, and closes on choice, on
 * another press of the trigger, on an outside press, or on Escape.
 * The trigger is the shared control frame: a neutral border at rest and the focus
 * role while focused or open, never the accent for holding a value.
 * `compact` drops the caption and takes the compact control size for a column
 * header; `hideLabel` drops only the caption, for an owner that shows its own.
 * Either way the caption stays in the accessibility label. `placeholder` covers
 * pickers that act at once instead of holding a selection: it shows when no option matches.
 */
export function DropdownSelect({ label, value, options, onChange, c, minWidth = 170, compact = false, hideLabel = false, placeholder, disabled = false, invalid = false, emptyText }: {
  label: string; value: string; options: DropdownOption[]; onChange: (value: string) => void; c: Colors; minWidth?: number; compact?: boolean; hideLabel?: boolean;
  placeholder?: string; disabled?: boolean; /** The choice cannot be saved: the border takes the danger role. */ invalid?: boolean; /** Shown in an open menu with no options. */ emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const r = roles(c);
  const box = useRef<View | null>(null), trigger = useRef<View | null>(null), menu = useRef<View | null>(null);
  const selected = options.find(option => option.value === value)?.label ?? placeholder ?? value;
  // Escape and outside presses close the menu on hosts with a DOM. The pointer
  // listener checks the press landed outside the trigger and the menu first, so
  // choosing an option still reaches its own press; guarded like the header
  // menus, so native hosts keep choice and toggle dismissal only.
  useEffect(() => {
    if (!open) return;
    const documentHost = (globalThis as { document?: DocumentHost }).document;
    if (!documentHost) return;
    const onPointer = (event: { target?: unknown }) => { if (!within([box, menu], event?.target)) setOpen(false); };
    const onKey = (event: { key?: string }) => { if (event?.key === "Escape") setOpen(false); };
    documentHost.addEventListener("pointerdown", onPointer);
    documentHost.addEventListener("keydown", onKey);
    return () => {
      documentHost.removeEventListener("pointerdown", onPointer);
      documentHost.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const size = compact ? control.compact : control;
  return <View ref={box} style={{ minWidth, maxWidth: "100%", gap: space.xxs, position: "relative", zIndex: open ? 30 : 0 }}>
    {!compact && !hideLabel && <FieldCaption c={c} text={label} />}
    <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel={`${label}, ${selected}`} accessibilityState={{ expanded: open, disabled }} disabled={disabled} onPress={() => setOpen(was => !was)}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} hitSlop={touchSlop(size.height)}
      style={{ ...controlFrame(c, { focused: focused || open, invalid, compact }), flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: compact ? 6 : space.xs, opacity: disabled ? 0.45 : 1, ...noOutline() }}>
      <Text numberOfLines={1} style={{ ...controlText(c, compact), flexShrink: 1 }}>{selected}</Text><Icon name={open ? "ChevronUp" : "ChevronDown"} size={compact ? 12 : 14} color={r.muted} />
    </Pressable>
    {open && <Popover anchor={trigger} contentRef={menu} minWidth={160} atLeastAnchorWidth maxWidth={360} inlineStyle={{ top: "100%", left: 0, minWidth: "100%", marginTop: space.xxs }}>
      <ScrollView accessibilityRole="menu" nestedScrollEnabled style={{ maxHeight: 260, borderWidth: control.border, borderColor: r.border, borderRadius: control.radius, backgroundColor: r.section,
      shadowColor: overlay.shadow, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.38, shadowRadius: 14, elevation: 12 }}>
      {options.map((option, index) => <React.Fragment key={option.value || "all"}>
        {option.group && option.group !== options[index - 1]?.group && <Text accessibilityRole="header" style={{ ...captionText(c), fontWeight: "600", paddingHorizontal: control.paddingX, paddingTop: space.xs, paddingBottom: space.xxs / 2 }}>{option.group}</Text>}
        <Pressable accessibilityRole="menuitem" accessibilityLabel={`${label}: ${option.label}`} accessibilityState={{ selected: value === option.value }} onPress={() => { onChange(option.value); setOpen(false); }}
          style={{ minHeight: control.height, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: control.paddingX, backgroundColor: value === option.value ? r.raised : r.section }}>
          {value === option.value && <Icon name="Check" size={14} color={r.accent} />}<Text numberOfLines={1} style={controlText(c)}>{option.label}</Text>
        </Pressable>
      </React.Fragment>)}
      {!options.length && emptyText && <Text style={{ ...muted(c), fontSize: control.text.fontSize, lineHeight: control.text.lineHeight, paddingHorizontal: control.paddingX, paddingVertical: space.xs }}>{emptyText}</Text>}
    </ScrollView></Popover>}
  </View>;
}
/** True when a press landed inside one of these boxes (the trigger's or its popover's). Hosts without a DOM report false. */
function within(boxes: React.RefObject<View | null>[], target: unknown) {
  return boxes.some(box => {
    try {
      const node = box.current as unknown as { contains?: (target: unknown) => boolean } | null;
      return Boolean(node && node.contains && node.contains(target));
    } catch { return false; }
  });
}
/** The confirmation a removal asks for inside its own row: the question, the destructive action and Keep. */
export function InlineConfirm({ c, question, confirmLabel, label, busy = false, onConfirm, onCancel }: {
  c: Colors; question: string; confirmLabel: string; label: string; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return <View accessibilityRole="alert" style={{ ...row, flexWrap: "nowrap", gap: space.xs }}>
    <Text style={{ color: roles(c).warning, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight, flexShrink: 1 }}>{question}</Text>
    <Button small danger c={c} text={confirmLabel} label={`${confirmLabel} ${label}`} disabled={busy} onPress={onConfirm} />
    <Button small c={c} text="Keep" label={`Keep ${label}`} onPress={onCancel} />
  </View>;
}
export function TextLink({ c, text, label, onPress }: { c: Colors; text: string; label?: string; onPress: () => void }) {
  return <Pressable accessibilityRole="link" accessibilityLabel={label ?? text} onPress={onPress}>
    <Text style={{ color: c.accent, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>{text}</Text>
  </Pressable>;
}
/**
 * A disclosure row: `expanded` is announced to assistive tech, and opening or closing it is local UI state only.
 * The row never wraps: a wrapping line packs to the top of the touch target and leaves an empty band under the
 * text (task 961), so the label and Show/Hide stay centred in it and a long label wraps inside itself.
 * `gapAbove` separates a revealer that follows a block of cards.
 */
export function Disclosure({ c, label, accessibilityLabel, expanded, onToggle, gapAbove = false }: { c: Colors; label: string; accessibilityLabel?: string; expanded: boolean; onToggle: () => void; gapAbove?: boolean }) {
  const focus = useFocusVisible();
  // The side padding keeps the inset ring clear of the label's first and last letters.
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ expanded }} onPress={onToggle} onFocus={focus.onFocus} onBlur={focus.onBlur}
    style={{ ...row, flexWrap: "nowrap", alignSelf: "flex-start", maxWidth: "100%", minHeight: touchTarget, paddingHorizontal: space.xxs, borderRadius: radius.control, ...noOutline(), ...(gapAbove ? { marginTop: space.sm } : null) }}>
    <FocusRing c={c} visible={focus.visible} />
    <Text style={{ color: roles(c).foreground, fontWeight: "600", fontSize: type.body.fontSize, lineHeight: type.body.lineHeight, flexShrink: 1 }}>{label}</Text>
    <Text style={{ color: roles(c).accent, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight, flexShrink: 0 }}>{expanded ? "Hide" : "Show"}</Text>
  </Pressable>;
}
export function Field({ label, a11yLabel, value, onChange, onBlur, c, placeholder, detail, multiline = false, disabled = false, hideLabel = false, invalid = false }: { label: string; a11yLabel?: string; value: string; onChange: (s: string) => void; onBlur?:()=>void; c: Colors; placeholder?: string; /** Units and range, shown under the input. */ detail?: string; multiline?: boolean; disabled?: boolean; /** No caption above the input: the placeholder and accessible label carry the name. */ hideLabel?: boolean; /** The value cannot be saved: the border takes the danger role, focused or not. */ invalid?: boolean }) {
  const [focused, setFocused] = useState(false);
  const input = useRef<TextInput | null>(null);
  // The box stays at the control height; the wrapper's hit slop keeps a 44-point reach that focuses the input.
  return <View style={{ gap: space.xxs, minWidth: 0 }}>{!hideLabel && label ? <FieldCaption c={c} text={label} /> : null}
    <Pressable accessible={false} focusable={false} hitSlop={multiline ? undefined : touchSlop(control.height)} onPress={() => input.current?.focus()}>
    <TextInput ref={input} accessibilityLabel={a11yLabel ?? label} value={value} onChangeText={onChange} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); onBlur?.(); }} editable={!disabled} accessibilityState={{ disabled }} placeholder={placeholder} placeholderTextColor={roles(c).muted}
      autoCapitalize="none" autoCorrect={false} multiline={multiline} numberOfLines={multiline ? 6 : 1}
      style={{ ...fieldBox(c, focused, multiline, invalid), textAlignVertical: multiline ? "top" : "center", opacity: disabled ? 0.45 : 1 }} />
    </Pressable>
    {detail && <Text style={{ ...muted(c), fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>{detail}</Text>}
  </View>;
}

/**
 * One autosaving section: queued saves run in order, the latest value wins, and
 * the status shows a failure or a brief Saved (see SaveStatus). Pending work is
 * flushed when the section unmounts. A failed save throws, so its reason shows here.
 */
export function useSectionAutoSave<T>(save: (value: T) => Promise<void>) {
  const [status, setStatus] = useState("");
  // While the draft is invalid, a save that was already in flight cannot report
  // "Saved" over the reason this draft was not sent (review #596).
  const mounted = useRef(true), invalid = useRef(false), saveRef = useRef(save); saveRef.current = save;
  const saver = useRef<AutoSave<T> | null>(null);
  if (!saver.current) saver.current = createAutoSave(value => saveRef.current(value), next => { if (mounted.current && !invalid.current) setStatus(next); });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void saver.current!.flush(); }; }, []);
  // Saved is brief: it clears on its own, and the next edit or failure replaces it.
  useEffect(() => {
    if (status !== "Saved") return;
    const timer = setTimeout(() => setStatus(""), 2500);
    return () => clearTimeout(timer);
  }, [status]);
  return {
    saver: saver.current, status, failed: status.startsWith("Not saved"),
    enqueue: (value: T, delay = 0) => { invalid.current = false; saver.current!.enqueue(value, delay); },
    invalid: (reason: string) => { invalid.current = true; saver.current!.cancelPending(); setStatus(`Not saved: ${reason}`); },
  };
}

/**
 * Save status for a field or section. Only a failure and a brief Saved are shown; Saving…
 * and unsaved changes stay quiet, because autosave is the default (Tom, 2026-11-08).
 */
export function SaveStatus({ c, status, label }: { c: Colors; status: string; label: string }) {
  if (!status || !(status === "Saved" || status.startsWith("Not saved"))) return null;
  return <Text accessibilityLabel={`${label} save status`} accessibilityLiveRegion="polite" style={{ ...muted(c), fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight, flexShrink: 1, maxWidth: "100%", textAlign: "right", color: status.startsWith("Not saved") ? roles(c).warning : roles(c).muted }}>{status}</Text>;
}
/**
 * One settings section: a header row (title with its (?) explanation, an optional
 * note or action, and the save status on the right), then its controls.
 * Explanations sit behind the (?) (Tom, 2026-10-22: "put the descriptive labels
 * behind (?) tooltips"). Wraps on narrow layouts, so a long note or "Not saved"
 * reason moves to the next line instead of squeezing the title (review #599).
 */
/**
 * A settings section, ruled off from the next one. `endsInRow` says the content
 * already ends in a row divider: the boundary is then a wider gap instead of a
 * second line a few points under it (Tom, 2026-11-09).
 */
export function Section({ c, title, label, note, action, status, description, last = false, endsInRow = false, children }: {
  c: Colors; title: string; label?: string; note?: string; action?: React.ReactNode; status?: string | null; description?: string; last?: boolean; endsInRow?: boolean; children: React.ReactNode;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const header = useRef<View | null>(null);
  const r = roles(c);
  const ruled = !last && !endsInRow;
  return <View accessibilityLabel={label} style={{ gap: space.sm, paddingTop: space.md, paddingBottom: !last && endsInRow ? space.lg : space.md, borderBottomWidth: ruled ? 1 : 0, borderBottomColor: r.border }}>
    <View ref={header} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.sm, rowGap: space.xxs }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexGrow: 1, flexShrink: 1, maxWidth: "100%", minWidth: 146 }}>
        {/* The title wraps inside the group, so a long title never runs past the section's edge. */}
        <Text accessibilityRole="header" style={{ color: r.foreground, fontWeight: "600", fontSize: type.section.fontSize, lineHeight: type.section.lineHeight, flexShrink: 1, minWidth: 120 }}>{title}</Text>
        {description && <HelpTip c={c} label={title} text={description} open={helpOpen} onOpenChange={setHelpOpen} />}
      </View>
      {note && <Text style={{ ...muted(c), fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight, flexShrink: 1, maxWidth: "100%" }}>{note}</Text>}
      {status !== undefined && status !== null && <SaveStatus c={c} status={status} label={title} />}
      {action}
      {/* Below the header row, in the popover layer: never past the section's column (review #600). */}
      {helpOpen && description && <HelpPopover c={c} anchor={header} label={title} text={description} />}
    </View>
    {children}
  </View>;
}
/** A bordered panel with an optional header. Used for detail groups and for the cards that sit inside a section. */
export function DetailSection({ title, children, c }: { title?: string; children: React.ReactNode; c: Colors }) {
  return <View style={{ gap: space.sm, padding: space.sm, borderRadius: radius.panel, borderWidth: 1, borderColor: roles(c).border, backgroundColor: roles(c).section }}>
    {title && <Text accessibilityRole="header" style={{ color: roles(c).foreground, fontWeight: "600", fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>{title}</Text>}
    {children}
  </View>;
}
/** A quiet card inside a section: a limit, a grant or a role. */
export const sectionCard = (c: Colors): ViewStyle => ({ padding: space.sm, borderRadius: radius.card, backgroundColor: roles(c).section });

/**
 * The one dialog frame: a centred modal at every width, over the scrim, fading in.
 * The title row and footer stay in view; the body scrolls between them. Its own
 * popover layer keeps dropdowns and tooltips above the frame.
 */
export function Dialog({ c, title, label, closeLabel, closeDisabled = false, onClose, bodyLabel, footer, children, eyebrow, wide = false, backdropLabel }: {
  c: Colors; title: string; /** The frame's accessible name. */ label: string; closeLabel: string; closeDisabled?: boolean; onClose: () => void;
  /** The scrolling body's accessible name. */ bodyLabel: string; footer?: React.ReactNode; eyebrow?: React.ReactNode; wide?: boolean; backdropLabel?: string; children: React.ReactNode;
}) {
  const r = roles(c);
  return <Modal visible transparent animationType="fade" onRequestClose={() => { if (!closeDisabled) onClose(); }}>
    <PopoverHost>
      <View style={{ flex: 1, justifyContent: "center", padding: space.lg, backgroundColor: overlay.scrim }}>
        {backdropLabel && <Pressable accessibilityRole="button" accessibilityLabel={backdropLabel} onPress={onClose} style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }} />}
        <View accessibilityViewIsModal accessibilityLabel={label} style={{ maxWidth: wide ? 980 : 560, width: "100%", maxHeight: "90%", minHeight: 0, alignSelf: "center", gap: space.sm, padding: space.md, borderRadius: radius.panel, borderWidth: 1, borderColor: r.border, backgroundColor: r.section }}>
          <View style={{ ...row, flexWrap: "nowrap" }}>
            <View style={{ flex: 1, minWidth: 0 }}><Text accessibilityRole="header" numberOfLines={2} style={{ color: r.foreground, fontSize: type.section.fontSize, lineHeight: type.section.lineHeight, fontWeight: "600" }}>{title}</Text>{eyebrow}</View>
            <ActionButton c={c} action="close" label={closeLabel} disabled={closeDisabled} onPress={onClose} />
          </View>
          <ScrollView accessibilityLabel={bodyLabel} style={{ flexShrink: 1, minHeight: 0 }} contentContainerStyle={{ gap: space.sm }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
          {footer}
        </View>
      </View>
    </PopoverHost>
  </Modal>;
}

/**
 * Spec 032: picking a decision option fills the answer box; when the operator has
 * already written something else, this asks before replacing it (Tom, 2026-09-29).
 */
export function ConfirmReplaceAnswer({ c, option, onConfirm, onCancel }: { c: Colors; option: string | null; onConfirm: () => void; onCancel: () => void }) {
  if (option === null) return null;
  const r = roles(c);
  return <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
    <View style={{ flex: 1, justifyContent: "center", padding: space.lg, backgroundColor: overlay.scrim }}>
      <View accessibilityViewIsModal accessibilityLabel="Replace your answer?" style={{ maxWidth: 520, width: "100%", alignSelf: "center", gap: space.sm, padding: space.md, borderRadius: radius.panel, borderWidth: 1, borderColor: r.border, backgroundColor: r.section }}>
        <Text accessibilityRole="header" style={{ color: r.foreground, fontSize: type.section.fontSize, lineHeight: type.section.lineHeight, fontWeight: "600" }}>Replace your answer?</Text>
        <Text style={{ color: r.muted, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>Your written answer will be replaced with “{option}”.</Text>
        <View style={row}><Button c={c} text="Keep mine" onPress={onCancel} /><Button c={c} text="Replace" selected onPress={onConfirm} /></View>
      </View>
    </View>
  </Modal>;
}
