/**
 * Dependency-free unified diff (Myers, line based, 3 lines of context).
 * Used so the owner approves exactly what will change. Applying a write never replays the diff:
 * the hub writes the full new content and the proposal's SHA-256 pins what was approved.
 */

export const MAX_DIFF_LINES = 5000;
const CONTEXT = 3;
/** Beyond this many edits Myers' trace gets large; fall back to "replace everything". */
const MAX_EDITS = 1500;
const NOEOL = "\u0001noeol";

interface Side { lines: string[]; keys: string[]; noeol: boolean }
type Op = { t: " " | "-" | "+"; i: number };   // i = index into the old side (for " " and "-") or the new side (for "+")

function split(text: string): Side {
  const lines = text.split("\n");
  let noeol = true;
  if (lines[lines.length - 1] === "") { lines.pop(); noeol = false; }
  if (lines.length === 0) noeol = false;
  const keys = lines.slice();
  if (noeol) keys[keys.length - 1] += NOEOL;
  return { lines, keys, noeol };
}

/** Myers O(ND). Returns the edit script over a and b, or null when more than maxD edits are needed. */
function myers(a: string[], b: string[], maxD: number): Op[] | null {
  const n = a.length, m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2)); // window of v before this round; index of k is k + d + 1
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], dEnd: number): Op[] {
  const ops: Op[] = [];
  let x = a.length, y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const vv = trace[d];
    const at = (k: number) => vv[k + d + 1];
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prevX = at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push({ t: " ", i: x }); }
    if (x === prevX) { y--; ops.push({ t: "+", i: y }); }
    else { x--; ops.push({ t: "-", i: x }); }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push({ t: " ", i: x }); }
  return ops.reverse();
}

function editScript(o: Side, n: Side): Op[] {
  let pre = 0;
  while (pre < o.keys.length && pre < n.keys.length && o.keys[pre] === n.keys[pre]) pre++;
  let suf = 0;
  while (suf < o.keys.length - pre && suf < n.keys.length - pre && o.keys[o.keys.length - 1 - suf] === n.keys[n.keys.length - 1 - suf]) suf++;
  const am = o.keys.slice(pre, o.keys.length - suf), bm = n.keys.slice(pre, n.keys.length - suf);
  let mid = myers(am, bm, MAX_EDITS);
  if (!mid) { // too different: delete all, add all
    mid = [...am.map((_, i) => ({ t: "-" as const, i })), ...bm.map((_, i) => ({ t: "+" as const, i }))];
  }
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: " ", i });
  for (const op of mid) ops.push({ t: op.t, i: op.i + pre });
  for (let i = o.keys.length - suf; i < o.keys.length; i++) ops.push({ t: " ", i });
  return ops;
}

/** `oldText` null = the file does not exist yet. Returns "" when nothing changes. */
export function unifiedDiff(relPath: string, oldText: string | null, newText: string): string {
  if (oldText !== null && oldText === newText) return "";
  const header = `--- ${oldText === null ? "/dev/null" : `a/${relPath}`}\n+++ b/${relPath}\n`;
  const o = split(oldText ?? ""), n = split(newText);
  if (o.lines.length > MAX_DIFF_LINES || n.lines.length > MAX_DIFF_LINES) {
    return `${header}@@ too large to diff: ${o.lines.length} lines -> ${n.lines.length} lines; the whole file is replaced (content hash is verified) @@\n`;
  }
  const ops = editScript(o, n);
  // Positions in old/new for each op, to number hunks.
  const oldPos: number[] = [], newPos: number[] = [];
  let oi = 0, ni = 0;
  for (const op of ops) { oldPos.push(oi); newPos.push(ni); if (op.t !== "+") oi++; if (op.t !== "-") ni++; }
  const changed: number[] = [];
  ops.forEach((op, idx) => { if (op.t !== " ") changed.push(idx); });
  if (changed.length === 0) return `${header}@@ no line changes @@\n`;

  const text = (op: Op) => {
    const side = op.t === "+" ? n : o;
    const last = op.i === side.lines.length - 1 && side.noeol;
    return `${op.t}${side.lines[op.i]}${last ? "\n\\ No newline at end of file" : ""}`;
  };

  const out: string[] = [];
  let s = 0;
  while (s < changed.length) {
    let e = s;
    while (e + 1 < changed.length && changed[e + 1] - changed[e] <= 2 * CONTEXT + 1) e++;
    const from = Math.max(0, changed[s] - CONTEXT), to = Math.min(ops.length - 1, changed[e] + CONTEXT);
    let oc = 0, nc = 0;
    const body: string[] = [];
    for (let i = from; i <= to; i++) {
      if (ops[i].t !== "+") oc++;
      if (ops[i].t !== "-") nc++;
      body.push(text(ops[i]));
    }
    const os = oc === 0 ? oldPos[from] : oldPos[from] + 1, ns = nc === 0 ? newPos[from] : newPos[from] + 1;
    out.push(`@@ -${os},${oc} +${ns},${nc} @@`, ...body);
    s = e + 1;
  }
  return header + out.join("\n") + "\n";
}
