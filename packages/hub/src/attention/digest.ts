import type { AttentionItem } from "@agent-room/shared";

/** 2.7 The evening digest as text: today's numbers, what still needs the owner, and the items that waited, grouped by goal. */

export interface DigestNumbers {
  goalsDone: number;
  accepted: number;
  /** Notional API price of the day's runs, from what the CLIs reported. null when none reported a cost. */
  spendUsd: number | null;
  interruptions: number;
  cap: number;
  overCap: number;
}

export interface DigestInput {
  /** The local day the numbers are for, as a short date ("Fri, Oct 23"). */
  dateLabel: string;
  numbers: DigestNumbers;
  /** Things that are still waiting on the owner right now (open approvals, plans, questions), one line each. */
  open: string[];
  items: AttentionItem[];
  /** Goal id to the name shown above its items. */
  goalNames: Record<string, string>;
  /** Set when it is going out late ("the hub wasn't running at 18:00"). */
  late?: string;
}

const MAX_PER_GROUP = 6;
const MAX_OPEN = 8;
const money = (x: number) => `$${x < 10 ? x.toFixed(2) : x.toFixed(0)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

/** The "Today:" line. */
export function numbersLine(n: DigestNumbers): string {
  const parts = [
    plural(n.goalsDone, "goal") + " done",
    plural(n.accepted, "task") + " accepted",
    n.spendUsd === null ? "cost not reported" : `${money(n.spendUsd)} API-equivalent spend`,
    n.interruptions > n.cap ? `${n.interruptions} interruptions (cap ${n.cap}; ${n.overCap} went through past it because work was blocked)` : `${n.interruptions} of ${n.cap} interruptions used`,
  ];
  return `Today: ${parts.join(", ")}.`;
}

export function renderDigest(d: DigestInput): string {
  const out: string[] = [`Evening digest, ${d.dateLabel}`];
  if (d.late) out.push(d.late);
  out.push("", numbersLine(d.numbers));
  if (d.open.length) {
    out.push("", "Still needs you:");
    for (const o of d.open.slice(0, MAX_OPEN)) out.push(`- ${o}`);
    if (d.open.length > MAX_OPEN) out.push(`- and ${d.open.length - MAX_OPEN} more`);
  }
  if (!d.items.length) { out.push("", "Nothing else waited for the digest."); return out.join("\n"); }

  // Group by goal, in the order each goal first appears; items without a goal go last under "General".
  const groups = new Map<string, AttentionItem[]>();
  for (const it of d.items) { const k = it.goalId ?? ""; groups.set(k, [...(groups.get(k) ?? []), it]); }
  const keys = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : 0));
  out.push("", `Waited for the digest (${d.items.length}):`);
  for (const k of keys) {
    const items = groups.get(k)!;
    out.push("", k ? clip(d.goalNames[k] ?? "A goal", 80) : "General");
    for (const it of items.slice(0, MAX_PER_GROUP)) {
      const why = it.why === "cap" ? " (past the daily cap)" : it.why === "quiet" ? " (quiet hours)" : "";
      out.push(`- ${clip(it.title, 110)}${it.body && it.body !== it.title ? `: ${clip(it.body, 140)}` : ""}${why}`);
    }
    if (items.length > MAX_PER_GROUP) out.push(`- and ${items.length - MAX_PER_GROUP} more`);
  }
  return out.join("\n");
}

/** The single push that goes with the digest. */
export function digestPush(d: DigestInput): { title: string; body: string } {
  const n = d.numbers;
  return {
    title: "Evening digest",
    body: `${plural(n.goalsDone, "goal")} done, ${plural(n.accepted, "task")} accepted. ${plural(d.items.length, "item")} waited${d.open.length ? `, ${d.open.length} still need${d.open.length === 1 ? "s" : ""} you` : ""}. ${n.interruptions} of ${n.cap} interruptions used.`,
  };
}
