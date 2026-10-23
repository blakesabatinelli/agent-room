import React, { memo, useCallback, useMemo, useRef, useState } from "react";
import { FlatList, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ViewToken } from "react-native";
import { flattenChange, needsScrollGate, opWords, parseChangeDiff, scrolledToEnd, type ChangeRow } from "@agent-room/shared/src/diff";
import type { WriteProposalFile } from "@agent-room/shared";
import { Button } from "./ui";
import { space, type as t, usePalette } from "../theme";

const Row = memo(function Row({ row }: { row: ChangeRow }) {
  const p = usePalette();
  if (row.type === "file") {
    // A task changes several files: each one starts with its own header.
    const color = row.op === "delete" ? p.diffDelInk : row.op === "create" ? p.diffAddInk : p.inkStrong;
    return (
      <View style={{ marginTop: space(4), paddingHorizontal: space(3), paddingVertical: space(2), backgroundColor: p.raised, borderTopWidth: 1, borderBottomWidth: 1, borderColor: p.line }}>
        <Text selectable style={[t.mono, { color: p.inkStrong, fontWeight: "700" }]}>{row.path}</Text>
        <Text style={[t.small, { color }]}>{opWords(row.op)} <Text style={{ color: p.diffAddInk, fontWeight: "700" }}>+{row.added}</Text> <Text style={{ color: p.diffDelInk, fontWeight: "700" }}>-{row.removed}</Text></Text>
      </View>
    );
  }
  if (row.type === "hunk") {
    return (
      <View style={{ marginTop: space(2), paddingHorizontal: space(3), paddingVertical: space(1), backgroundColor: p.surface }}>
        <Text selectable style={[t.mono, { color: p.muted }]}>{row.header}</Text>
      </View>
    );
  }
  const { line } = row;
  const bg = line.kind === "add" ? p.diffAddBg : line.kind === "del" ? p.diffDelBg : "transparent";
  const ink = line.kind === "add" ? p.diffAddInk : line.kind === "del" ? p.diffDelInk : p.ink;
  const no = line.kind === "del" ? line.oldNo : line.newNo;
  return (
    <View style={{ backgroundColor: bg }}>
      <View style={{ flexDirection: "row" }}>
        <Text style={[t.mono, { width: 52, textAlign: "right", paddingRight: space(2), color: p.faint }]}>{no ?? ""}</Text>
        <Text style={[t.mono, { width: 16, color: ink, fontWeight: "700" }]}>{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</Text>
        {/* Long lines wrap; nothing is cut off or hidden to the side. */}
        <Text selectable style={[t.mono, { flex: 1, color: ink, paddingRight: space(3) }]}>{line.text === "" ? " " : line.text}</Text>
      </View>
      {line.noNewline ? <Text style={[t.tiny, { color: p.muted, fontStyle: "italic", paddingLeft: 68 }]}>No newline at end of file</Text> : null}
    </View>
  );
});

const VIEWABILITY = { itemVisiblePercentThreshold: 90 };

/**
 * The whole change to one file, to read before approving it. Approve stays off until the last line has been on
 * screen (or the whole change fits in the window), and is never on for a diff that could not be read in full.
 * The list is virtualised, so a diff of thousands of lines scrolls smoothly without dropping any of it.
 * A task's write-back has several files (`files`): each gets a header. `skipped` are files that will NOT be written, and
 * `unappliable` is the hub's reason this change can't be applied as asked: then only Reject is offered.
 */
export function FileChangeReview({ path, subtitle, diff, files, skipped, unappliable, onApprove, onReject, onBack }: {
  path: string; subtitle: string; diff: string; files?: WriteProposalFile[]; skipped?: { relPath: string; reason: string }[]; unappliable?: string;
  onApprove: () => void; onReject: () => void; onBack?: () => void;
}) {
  const p = usePalette();
  const parsed = useMemo(() => parseChangeDiff(diff, files), [diff, files]);
  const rows = useMemo(() => flattenChange(parsed), [parsed]);
  const [viewH, setViewH] = useState(0);
  const [contentH, setContentH] = useState(0);
  const [lastShown, setLastShown] = useState(false);   // the final row has been in view
  const [atBottom, setAtBottom] = useState(false);
  const [seenEnd, setSeenEnd] = useState(false);       // sticky: once read to the end, it stays read
  const measured = viewH > 0 && contentH > 0;
  const gated = !measured || needsScrollGate(viewH, contentH);

  if (!seenEnd && lastShown && atBottom) setSeenEnd(true);
  const canApprove = !parsed.problem && !unappliable && (seenEnd || !gated);

  const rowsLen = useRef(rows.length); rowsLen.current = rows.length;
  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    setLastShown(viewableItems.some((v) => v.index === rowsLen.current - 1));
  });
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    setAtBottom(scrolledToEnd(contentOffset.y, layoutMeasurement.height, contentSize.height));
  }, []);
  const hint = unappliable ? "This change can't be applied. You can reject it." : parsed.problem ?? (canApprove ? "You have seen the whole change." : "Scroll to the end to approve.");

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }}>
      <View style={{ paddingHorizontal: space(5), paddingVertical: space(3), borderBottomWidth: 1, borderColor: p.line, gap: space(1) }}>
        {onBack ? <Button small kind="ghost" label="‹ Back to approvals" onPress={onBack} /> : null}
        <Text selectable style={[t.mono, { color: p.inkStrong, fontWeight: "700" }]}>{path}</Text>
        <Text style={[t.small, { color: p.muted }]}>
          {subtitle} <Text style={{ color: p.diffAddInk, fontWeight: "700" }}>+{parsed.added}</Text> <Text style={{ color: p.diffDelInk, fontWeight: "700" }}>-{parsed.removed}</Text>
          {` in ${parsed.places} ${parsed.places === 1 ? "place" : "places"}${parsed.sections.length > 1 ? ` across ${parsed.sections.length} files` : ""}.`}
        </Text>
        {unappliable ? <Text style={[t.small, { color: p.danger }]}>Can't be applied: {unappliable}</Text> : null}
        {skipped?.length ? (
          <View style={{ gap: 2 }}>
            <Text style={[t.small, { color: p.warn, fontWeight: "700" }]}>{skipped.length} file{skipped.length === 1 ? "" : "s"} won't be written:</Text>
            {skipped.map((x) => <Text key={x.relPath} selectable style={[t.small, { color: p.muted }]}>{x.relPath}: {x.reason}</Text>)}
          </View>
        ) : null}
      </View>
      <FlatList
        style={{ flex: 1 }}
        data={rows}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => <Row row={item} />}
        initialNumToRender={80} maxToRenderPerBatch={80} windowSize={11}
        onLayout={(e: LayoutChangeEvent) => setViewH(e.nativeEvent.layout.height)}
        onContentSizeChange={(_w, h) => setContentH(h)}
        onScroll={onScroll} scrollEventThrottle={32}
        viewabilityConfig={VIEWABILITY} onViewableItemsChanged={onViewable.current}
        contentContainerStyle={{ paddingBottom: space(4) }}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(5), paddingVertical: space(3), borderTopWidth: 1, borderColor: p.line, backgroundColor: p.canvas }}>
        <Text style={[t.small, { flex: 1, color: parsed.problem ? p.danger : p.muted }]}>{hint}</Text>
        {unappliable ? null : <Button label="Approve" onPress={onApprove} disabled={!canApprove} />}
        <Button kind="plain" label="Reject" onPress={onReject} />
      </View>
    </View>
  );
}
