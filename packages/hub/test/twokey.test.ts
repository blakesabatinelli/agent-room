import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentConfig, Approval, Goal, Task, TwoKeyDraft } from "@agent-room/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildServer } from "../src/api/server.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { ControlFolder } from "../src/control/folder.js";
import { emitFile } from "../src/control/parse.js";
import { id } from "../src/util.js";
import { TwoKey, TWOKEY_DEFAULTS, twoKeySettings } from "../src/twokey/service.js";
import { isTwoKey } from "../src/twokey/classify.js";
import { scanShell } from "../src/twokey/shell.js";
import { compareDrafts, normValue } from "../src/twokey/match.js";
import { addressesOf, draftFromRequest, overlayDraft, parseReply, redact, safeDraft } from "../src/twokey/draft.js";
import { entitiesOf, similarity, stripSignoff } from "../src/twokey/text.js";
import { pickSecond } from "../src/twokey/pick.js";
import { listTwoKey } from "../src/twokey/records.js";
import { setup } from "./helpers.js";

type Ctx = ReturnType<typeof setup>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, ms = 6000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await sleep(10); }
}

// ---------------------------------------------------------------- fixtures

/** claude (anthropic), codex (openai, quality .75), hermes (nous, quality .65): three families, every connector switched on. */
function hub(): Ctx {
  const c = setup();
  MockAdapter.calls.length = 0;
  for (const a of c.store.listAgents()) c.store.saveAgent({ ...a, tools: { ...a.tools, gmail: true, salesforce: true, shell: true, filesystem: true } });
  return c;
}
const agentOf = (c: Ctx, aid: string) => c.store.getAgent(aid)!;
/** What an agent answers when it is asked to be the second key (the mock adapter's `twokey` knob). */
function answer(c: Ctx, aid: string, reply: unknown) { const a = agentOf(c, aid); c.store.saveAgent({ ...a, settings: { ...a.settings, twokey: reply } }); }
function autoApprove(c: Ctx, aid: string, ...tools: string[]) { const a = agentOf(c, aid); c.store.saveAgent({ ...a, autoApprove: Object.fromEntries(tools.map((t) => [t, true])) }); }
const grant = (c: Ctx, agentId = "claude", extra: Record<string, unknown> = {}) => ({ agentId, roomId: c.room.id, ...extra });
const secondKeyCalls = () => MockAdapter.calls.filter((x) => x.kind === "TWOKEY");
const cards = (c: Ctx) => c.store.listApprovals("pending").filter((a) => !!a.twoKey);
const rows = (c: Ctx) => listTwoKey(c.store);
const asked = (c: Ctx, g: ReturnType<typeof grant>, tool: string, action: string, input: Record<string, unknown>) => c.orch.requestApproval(g, tool, action, JSON.stringify(input), input);
/** Start a request and keep whether it has finished, so a test can say "nothing ran yet". */
function track<T>(p: Promise<T>) { const s = { done: false, value: undefined as T | undefined }; void p.then((v) => { s.done = true; s.value = v; }); return { s, p }; }

const EMAIL = { to: ["bob@example.com"], cc: [] as string[], subject: "Q3 report", body: "Hi Bob,\n\nThe Q3 report is attached. Revenue was $1,200,000, up 12% on Q2. Can we talk Friday at 3pm?\n\nBest,\nClaude" };
/** The same email, written independently by another model. */
const EMAIL_B = { to: ["Bob@Example.com"], cc: [] as string[], subject: "Q3 report", body: "Hi Bob,\n\nAttached is the Q3 report. Revenue came in at $1.2M, up 12% on Q2. Could we talk on Friday at 3 pm?\n\nBest regards,\nCodex" };
const SEND = "mcp__Gmail__send_message";
const sendEmail = (c: Ctx, g = grant(c), input: Record<string, unknown> = EMAIL) => asked(c, g, "gmail", SEND, input);

// ---------------------------------------------------------------- classification

type Row = [tool: string, action: string, input: unknown, expect: "email" | "crm" | "delete" | null];
const TABLE: Row[] = [
  // email: sending, replying, forwarding; drafts, labels and reads are not
  ["gmail", "mcp__Gmail__send_message", {}, "email"],
  ["gmail", "mcp__Gmail__reply", {}, "email"],
  ["gmail", "mcp__Gmail__forward", {}, "email"],
  ["gmail", "mcp__Atmosphere_CW_AI__google_gmail_write", {}, "email"], // a verb the tables don't know on an email connector: treated as a send
  ["mcp__outlook__send_mail", "mcp__outlook__send_mail", {}, "email"],
  ["mcp__outlook__reply_all", "mcp__outlook__reply_all", {}, "email"],
  ["gmail", "Send the weekly update to the board", "x", "email"],
  ["gmail", "send", "x", "email"],
  ["gmail", "mcp__Gmail__create_draft", {}, null],
  ["gmail", "mcp__Gmail__search_threads", {}, null],
  ["gmail", "mcp__Gmail__label_message", {}, null],
  ["gmail", "mcp__Gmail__get_thread", {}, null],
  ["gmail", "Read the inbox", "x", null],
  ["gmail", "mcp__Atmosphere_CW_AI__google_gmail_draft", {}, null],
  // email and thread deletes are deletes
  ["gmail", "mcp__Gmail__trash_thread", {}, "delete"],
  ["gmail", "mcp__Gmail__delete_draft", {}, "delete"],
  ["gmail", "mcp__Gmail__trash_message", {}, "delete"],
  // CRM writes
  ["salesforce", "mcp__Salesforce_-_Beta__dispatch", {}, "crm"],
  ["salesforce", "mcp__Atmosphere_CW_AI__salesforce_write", {}, "crm"],
  ["salesforce", "Update the Acme opportunity to Closed Won", "x", "crm"],
  ["salesforce", "mcp__salesforce__upsert_record", {}, "crm"],
  ["salesforce", "create a lead for Acme", "x", "crm"],
  ["salesforce", "mcp__salesforce__delete_record", {}, "crm"],
  ["salesforce", "mcp__salesforce__something_new", {}, "crm"], // unknown verb on a CRM: treated as a write
  ["mcp__hubspot__create_contact", "mcp__hubspot__create_contact", {}, "crm"],
  ["mcp__pipedrive__update_deal", "mcp__pipedrive__update_deal", {}, "crm"],
  ["mcp__crm__merge_records", "mcp__crm__merge_records", {}, "crm"],
  ["salesforce", "mcp__salesforce__run", { operation: "update" }, "crm"],
  // CRM reads
  ["salesforce", "mcp__Salesforce_-_Beta__dispatch_readonly", {}, null],
  ["salesforce", "mcp__Salesforce_-_Beta__describe", {}, null],
  ["salesforce", "mcp__Salesforce_-_Beta__discover", {}, null],
  ["salesforce", "mcp__Atmosphere_CW_AI__salesforce_search", {}, null],
  ["salesforce", "mcp__Atmosphere_CW_AI__salesforce_report", {}, null],
  ["salesforce", "Look up the Acme account and summarise it", "x", null],
  ["mcp__hubspot__get_contact", "mcp__hubspot__get_contact", {}, null],
  // deletes of anything else
  ["drive", "mcp__Google_Drive__trash_file", {}, "delete"],
  ["drive", "mcp__Google_Drive__search_files", {}, null],
  ["filesystem", "delete notes/old.md", "x", "delete"],
  ["slack", "delete message", "x", "delete"],
  ["mcp__calendar__delete_event", "mcp__calendar__delete_event", {}, "delete"],
  ["slack", "mcp__Slack__slack_send_message", {}, null],
  ["filesystem", "Write", { file_path: "a.txt" }, null],
  ["web", "WebFetch", { url: "https://example.com" }, null],
];

test("classification: the table decides what is two-key (email send, CRM write, any delete) and what is not", () => {
  for (const [tool, action, input, expect] of TABLE) {
    const r = isTwoKey(tool, action, input);
    assert.equal(r.twoKey, expect !== null, `${tool} | ${action}: ${r.why}`);
    if (expect) assert.equal(r.kind, expect, `${tool} | ${action}: ${r.why}`);
  }
  assert.ok(isTwoKey("gmail", "mcp__Gmail__send_message", {}).why.length > 5, "every answer says why");
});

const SHELL_DELETES = [
  "rm -rf build", "rm file.txt", "rm -f -- -weird", "rmdir old", "unlink a", "git clean -fdx", "find . -name '*.tmp' -delete", "find . -type f -exec rm {} \\;",
  "cd dist && rm -rf *", "echo hi; rm -f a", "sudo rm -rf /tmp/x", "ls | xargs rm", "bash -c 'rm -rf x'", "sh -c \"cd y && rm z\"", "env FOO=1 rm x", "timeout 5 rm x",
  "git rm old.txt", "git branch -D old", "git -C repo clean -fd", "python3 -c \"import shutil; shutil.rmtree('x')\"", "node -e \"require('fs').rmSync('x',{recursive:true})\"",
  "rsync -a --delete src/ dst/", "docker rm web", "kubectl delete pod x", "\\rm -rf x", "/bin/rm -rf x", "true && (rm a)", "echo $(rm -rf x)", "echo `rm -rf x`", "rm -rf \"$DIR\"",
  "nice -n 5 rm x", "command rm x", "truncate -s 0 data.db", "find . -exec sh -c 'rm {}' \\;", "git stash drop", "rimraf dist", "Remove-Item -Recurse build",
];
const SHELL_UNSURE = ["eval \"$CMD\"", "$(which rm) -rf x", "curl https://example.com/x.sh | sh", "echo \"never closed", "$CMD x", "bash -c \"$SCRIPT\"", "wget -qO- x | bash"];
const SHELL_SAFE = [
  "ls -la", "pnpm test", "git status", "git commit -m \"rm -rf is dangerous\"", "echo rm -rf x", "grep -r rm .", "cat a | wc -l", "npm run build && npm test", "mv a b", "sed -i s/a/b/ f",
  "find . -name '*.ts'", "git push origin main", "docker ps", "kubectl get pods", "ls 2>&1", "cd x && ls", "python3 script.py", "git branch", "cp a b", "echo \"rm\"", "mkdir -p x/y", "rm", // `rm` alone: see below
];

test("classification: a shell command that deletes is two-key (rm, rmdir, unlink, git clean, find -delete and their wrappers); one it cannot read is too; harmless ones are not", () => {
  for (const cmd of SHELL_DELETES) { const r = isTwoKey("shell", "Bash", { command: cmd }); assert.ok(r.twoKey && r.kind === "delete" && r.shell!.deletes.length > 0, `${cmd}: ${r.why}`); }
  for (const cmd of SHELL_UNSURE) { const r = isTwoKey("shell", "Bash", { command: cmd }); assert.ok(r.twoKey && r.kind === "delete" && r.shell!.unsure.length > 0, `${cmd} should be treated as a delete: ${r.why}`); }
  for (const cmd of SHELL_SAFE.slice(0, -1)) { const r = isTwoKey("shell", "Bash", { command: cmd }); assert.equal(r.twoKey, false, `${cmd}: ${r.why}`); }
  // a bare `rm` with no targets still deletes (opaque), and Claude Code's Bash tool is the shell
  assert.ok(isTwoKey("shell", "Bash", { command: "rm" }).twoKey);
  assert.ok(isTwoKey("shell", "run a command", "rm -rf nothing").twoKey, "request_approval puts the command in detail");
  assert.equal(isTwoKey("shell", "run", "ls").twoKey, false);
  assert.ok(isTwoKey("mcp__desktop__run_command", "mcp__desktop__run_command", { command: "rm -rf x" }).twoKey, "any tool that runs a command line");
  // targets are listed when they can be, and flagged opaque when they can't
  assert.deepEqual(scanShell("rm -rf build dist/ -- -x").deletes[0].targets, ["build", "dist/", "-x"]);
  assert.equal(scanShell("rm -rf build").deletes[0].opaque, false);
  assert.equal(scanShell("rm -rf build/*").deletes[0].opaque, true);
  assert.equal(scanShell("git clean -fd").deletes[0].opaque, true);
});

// ---------------------------------------------------------------- matching

test("matching: the same email in other words matches; recipients, numbers, dates, names, links and wording that is too different do not", () => {
  const A: TwoKeyDraft = { kind: "email", ...EMAIL }, B: TwoKeyDraft = { kind: "email", ...EMAIL_B };
  const ok = compareDrafts(A, B, 0.85);
  assert.equal(ok.match, true, JSON.stringify(ok));
  assert.ok(ok.similarity! >= 0.85, `similarity ${ok.similarity}`);
  assert.ok(ok.diffs.every((d) => d.level === "minor"), "wording differences inside the threshold are shown but never block");

  const email = (over: Record<string, unknown>): TwoKeyDraft => ({ kind: "email", ...EMAIL_B, ...over } as TwoKeyDraft);
  const bad = (name: string, b: TwoKeyDraft, re: RegExp, level: string) => {
    const r = compareDrafts(A, b, 0.85);
    assert.equal(r.match, false, `${name}: ${JSON.stringify(r)}`);
    assert.match(r.why, re, name);
    assert.ok(r.diffs.some((d) => d.level === level), `${name}: ${JSON.stringify(r.diffs)}`);
  };
  bad("another recipient", email({ to: ["bob@example.org"] }), /recipients differ/, "critical");
  bad("an extra recipient", email({ to: ["bob@example.com", "carol@example.com"] }), /recipients differ/, "critical");
  bad("a cc", email({ cc: ["carol@example.com"] }), /cc differ/, "critical");
  bad("a bcc", email({ bcc: ["carol@example.com"] }), /bcc differ/, "critical");
  bad("an extra number", email({ body: EMAIL_B.body.replace("Can", "Can").replace("Revenue came", "Revenue across 4 regions came") }), /numbers differ/, "entity");
  bad("another amount", email({ body: EMAIL_B.body.replace("$1.2M", "$2.1M") }), /amounts differ/, "entity");
  bad("another percentage", email({ body: EMAIL_B.body.replace("12%", "21%") }), /numbers differ/, "entity");
  bad("another day", email({ body: EMAIL_B.body.replace("Friday", "Monday") }), /dates differ/, "entity");
  bad("another time", email({ body: EMAIL_B.body.replace("3 pm", "4 pm") }), /times differ/, "entity");
  bad("a date in one only", email({ body: EMAIL_B.body.replace("Could we", "Could we do Oct 23 or") }), /dates differ/, "entity");
  bad("a link in one only", email({ body: `${EMAIL_B.body}\nDetails: https://example.com/q3` }), /links or addresses differ/, "entity");
  bad("another name", email({ body: EMAIL_B.body.replace("Hi Bob", "Hi Robert") }), /names differ/, "entity");
  bad("a name in one only", email({ body: EMAIL_B.body.replace("Revenue came", "Revenue, thanks to Priya, came") }), /names differ/, "entity");
  bad("wording too different", email({ subject: "Numbers", body: "Hi Bob,\n\nSee the figures we discussed. Revenue was strong this quarter and we should meet Friday at 3pm to review $1,200,000 and 12% on Q2.\n\nBest,\nCodex" }), /too different/, "text");
  // the signature is never compared: each agent signs with its own name
  assert.equal(stripSignoff("Hello\n\nBest regards,\nCodex").trim(), "Hello");
  assert.equal(stripSignoff("Thanks,\nBlake Sabatinelli, CEO\nAtmosphere").trim(), "");
  // a stricter threshold turns the same pair into a mismatch
  assert.equal(compareDrafts(A, B, 1).match, false);
  assert.ok(similarity("The report is ready", "The report is ready") === 1 && similarity("alpha beta", "gamma delta") === 0);
});

test("matching: entities are found in their many spellings", () => {
  const e = entitiesOf("Pay $1.2M or 1,200,000 USD by Oct 23, 2026 (10/23/2026, 2026-10-23) at 3pm / 15:00. Ask Priya about 12% and https://Example.com/a/.", { names: true });
  assert.deepEqual([...e.amount], ["usd1200000"]);
  assert.deepEqual([...e.date], ["2026-10-23"]);
  assert.deepEqual([...e.time], ["15:00"]);
  assert.deepEqual([...e.number], ["12%"]);
  assert.deepEqual([...e.link], ["https://example.com/a"]);
  assert.deepEqual([...e.name], ["priya"]);
  assert.deepEqual([...entitiesOf("See you tomorrow, or next week. Q3 numbers.").date].sort(), ["next week", "q3", "tomorrow"]);
});

test("matching: a CRM write is exact on object, operation, record and every field; values are normalised; long text is compared by meaning", () => {
  const A: TwoKeyDraft = { kind: "crm", object: "Opportunity", op: "update", id: "006xx000001AbCd", fields: { Amount: "50,000", StageName: "Closed Won", CloseDate: "2026-12-31", IsPrivate: "true" } };
  const same: TwoKeyDraft = { kind: "crm", object: "opportunity", op: "update", id: "006xx000001AbCdAAA", fields: { amount: 50000, stagename: "closed  won", closedate: "Dec 31, 2026", isprivate: true } };
  assert.equal(compareDrafts(A, same, 0.85).match, true, JSON.stringify(compareDrafts(A, same, 0.85)));
  const mutate = (patch: Partial<Extract<TwoKeyDraft, { kind: "crm" }>>, fields: Record<string, unknown> = {}) => ({ ...same, ...patch, fields: { ...(same as Extract<TwoKeyDraft, { kind: "crm" }>).fields, ...fields } }) as TwoKeyDraft;
  for (const [name, b, re] of [
    ["another object", mutate({ object: "Account" }), /different CRM objects/],
    ["another operation", mutate({ op: "upsert" }), /different operations/],
    ["another record", mutate({ id: "006xx000001ZzZz" }), /different records/],
    ["another value", mutate({}, { amount: 5000 }), /amount differs/],
    ["an extra field", mutate({}, { NextStep: "call" }), /only one sets NextStep/],
  ] as [string, TwoKeyDraft, RegExp][]) {
    const r = compareDrafts(A, b, 0.85);
    assert.equal(r.match, false, name);
    assert.match(r.why, new RegExp(re.source, "i"), name);
  }
  const missing = { ...(same as Extract<TwoKeyDraft, { kind: "crm" }>), fields: { amount: 50000 } } as TwoKeyDraft;
  assert.equal(compareDrafts(A, missing, 0.85).match, false, "a missing field is a difference");
  const note = "The customer asked to move the renewal to the second quarter and wants a revised quote with the volume discount applied before they sign the order form.";
  const long = (text: string): TwoKeyDraft => ({ kind: "crm", object: "Task", op: "create", fields: { Description: text } });
  assert.equal(compareDrafts(long(note), long(note.replace("asked to move", "has asked to move").replace("applied before", "applied before")), 0.85).match, true);
  assert.equal(compareDrafts(long(note), long(note.replace("second quarter", "third quarter")), 0.85).match, true, "words alone: only entities and similarity count");
  assert.equal(compareDrafts(long(note), long(`${note} Call on 12 Nov.`), 0.85).match, false, "a date in one only");
  assert.equal(normValue("$1,200"), "1200"); assert.equal(normValue(true), "true"); assert.equal(normValue("2026-01-02T10:00:00Z"), "2026-01-02T10:00z"); assert.equal(normValue(null), "");
});

test("matching: delete targets are exact once paths are resolved; a request that deletes more than it lists never matches", () => {
  const base = "/work/proj";
  const draft = (xs: string[]): TwoKeyDraft => ({ kind: "delete", targets: addressesOf(xs).length ? xs.map((x) => (x.startsWith("/") ? x : `${base}/${x.replace(/^\.\//, "")}`)).sort() : [] });
  assert.equal(compareDrafts(draft(["./a.txt", "dir/b.txt"]), draft(["dir/b.txt", "a.txt"]), 0.85).match, true);
  const r = compareDrafts(draft(["a.txt"]), draft(["a.txt", "b.txt"]), 0.85);
  assert.equal(r.match, false); assert.match(r.why, /only the second deletes .*b\.txt/);
  const opaque = compareDrafts({ kind: "delete", targets: [`${base}/build`], unparsed: "git clean" }, draft(["build"]), 0.85);
  assert.equal(opaque.match, false); assert.match(opaque.why, /deletes more than it lists/);
});

test("drafts: read from Claude Code's tool input, the agent's JSON or its To:/Subject: lines; replies are parsed strictly; secrets never survive", () => {
  const cls = isTwoKey("gmail", SEND, {});
  assert.deepEqual(draftFromRequest(cls, "gmail", SEND, "", { to: "A <a@x.com>, b@x.com", subject: "S", body: "<p>Hi</p><p>there</p>" }).draft, { kind: "email", to: ["a@x.com", "b@x.com"], cc: [], subject: "S", body: "Hi\nthere" });
  assert.deepEqual(draftFromRequest(cls, "gmail", "send", "To: bob@x.com\nCc: carol@x.com\nSubject: Hello\n\nBody line one", undefined).draft, { kind: "email", to: ["bob@x.com"], cc: ["carol@x.com"], subject: "Hello", body: "Body line one" });
  assert.equal(draftFromRequest(cls, "gmail", "send", "please send it", undefined).draft, null, "free text is never guessed at");
  const crm = isTwoKey("salesforce", "mcp__salesforce__update_record", {});
  assert.deepEqual(draftFromRequest(crm, "salesforce", "mcp__salesforce__update_record", "", { sobject: "Account", id: "001A", data: { Name: "Acme", Id: "001A" } }).draft, { kind: "crm", object: "Account", op: "update", id: "001A", fields: { Name: "Acme" } });
  const del = isTwoKey("shell", "Bash", { command: "rm -rf build ./x/y/" });
  assert.deepEqual(draftFromRequest(del, "shell", "Bash", "", { command: "rm -rf build ./x/y/" }, "/w").draft, { kind: "delete", targets: ["/w/build", "/w/x/y"] });
  assert.equal((draftFromRequest(isTwoKey("shell", "Bash", { command: "git clean -fd" }), "shell", "Bash", "", { command: "git clean -fd" }, "/w").draft as { unparsed?: string }).unparsed, "git clean");

  assert.deepEqual(parseReply("email", '```json\n{"to":"bob@x.com","subject":"S","body":"B"}\n```'), { draft: { kind: "email", to: ["bob@x.com"], cc: [], subject: "S", body: "B" } });
  assert.deepEqual(parseReply("email", "No action. Nothing to send."), { none: "Nothing to send." });
  assert.deepEqual(parseReply("email", '{"action":"none","reason":"the owner never asked"}'), { none: "the owner never asked" });
  assert.ok("error" in parseReply("email", "Sure, here is the email: dear Bob"), "prose is not a draft");
  assert.ok("error" in parseReply("crm", '{"hello":1}'));
  assert.deepEqual(parseReply("delete", '{"targets":["a.txt","./b.txt"]}', "/w"), { draft: { kind: "delete", targets: ["/w/a.txt", "/w/b.txt"] } });
  assert.deepEqual(parseReply("delete", '{"targets":[]}'), { none: "it listed nothing to delete" });

  const dirty = "password: hunter22 and key sk-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuvwx and Bearer abcdefghijklmnopqrstuvwxyz";
  const clean = redact(dirty);
  assert.ok(!/hunter22|sk-abc|ghp_abc|Bearer abc/.test(clean), clean);
  const safe = safeDraft({ kind: "email", to: ["a@x.com"], cc: [], subject: "k", body: `${dirty} ${"x".repeat(9000)}` }, 500) as Extract<TwoKeyDraft, { kind: "email" }>;
  assert.ok(safe.body.length <= 500 && !safe.body.includes("hunter22"));
  assert.deepEqual(overlayDraft({ to: "a@x.com", subject: "s", body: "b" }, { kind: "email", to: ["z@x.com", "y@x.com"], cc: [], subject: "S2", body: "B2" }), { to: "z@x.com, y@x.com", subject: "S2", body: "B2" });
  assert.equal(overlayDraft({ to: "a@x.com", subject: "s", body: "b" }, { kind: "email", to: ["z@x.com"], cc: ["c@x.com"], subject: "S2", body: "B2" }), undefined, "a cc with nowhere to go");
});

test("second agent: another family, in the room's roster, not out of quota, local models only when the governor admits them", () => {
  const mk = (aid: string, provider: string, extra: Partial<AgentConfig> = {}): AgentConfig => ({ id: aid, name: aid, provider, adapter: "mock", enabled: true, color: "#000", settings: { quality: 0.8 }, tools: {}, ...extra });
  const claude = mk("claude", "anthropic"), claude2 = mk("claude2", "anthropic", { settings: { quality: 0.99 } }), codex = mk("codex", "openai", { settings: { quality: 0.7 } }), hermes = mk("hermes", "hermes", { settings: { quality: 0.9 } });
  const bonsai = mk("bonsai", "local", { settings: { quality: 0.95, model: "bonsai-8b", locality: "local-model" } });
  const ctx = (ready: AgentConfig[], o: { limited?: string[]; admit?: boolean } = {}) => pickSecond({ ready, first: claude, localModels: [], limited: (x) => (o.limited ?? []).includes(x), admit: () => o.admit ?? true });
  assert.equal(ctx([claude, claude2, codex, hermes]).agent?.id, "hermes", "never the same family; the best quality of the others");
  assert.equal(ctx([claude, claude2]).agent, undefined, "a second agent of the same vendor is no second key");
  assert.match(ctx([claude, claude2]).why!, /same model family/);
  assert.equal(ctx([claude]).agent, undefined); assert.match(ctx([claude]).why!, /no other agent/);
  assert.equal(ctx([claude, codex, hermes], { limited: ["hermes"] }).agent?.id, "codex", "out of quota is skipped");
  assert.equal(ctx([claude, codex], { limited: ["codex"] }).agent, undefined); assert.match(ctx([claude, codex], { limited: ["codex"] }).why!, /out of quota/);
  assert.equal(ctx([claude, bonsai, codex]).agent?.id, "codex", "cloud before local");
  assert.equal(ctx([claude, bonsai]).agent?.id, "bonsai", "a local model can be the second key");
  assert.equal(ctx([claude, bonsai], { admit: false }).agent, undefined); assert.match(ctx([claude, bonsai], { admit: false }).why!, /capacity governor/);
  assert.equal(pickSecond({ ready: [claude, { ...hermes, settings: { model: "claude-sonnet-5-5" } }], first: claude, localModels: [], limited: () => false, admit: () => true }).agent, undefined, "Hermes running a Claude model is Claude's family");
  assert.deepEqual(twoKeySettings({}), TWOKEY_DEFAULTS);
  assert.deepEqual(twoKeySettings({ twoKey: { enabled: false, threshold: 0.2 } }), { enabled: false, threshold: 0.5 });
});

// ---------------------------------------------------------------- AC1, AC2: the check in the hub

test("AC1: an email send gets an independent draft from another family; drafts that match go on to the usual rules (auto-approval stands in for the owner)", async () => {
  const c = hub();
  autoApprove(c, "claude", "gmail");
  answer(c, "codex", EMAIL_B);
  const res = await sendEmail(c);
  assert.equal(res.status, "approved"); assert.equal(res.auto, true, "claude may send without asking, and the pair agreed");
  assert.deepEqual(c.store.listApprovals("pending"), [], "no card for the owner");
  const calls = secondKeyCalls();
  assert.equal(calls.length, 1); assert.equal(calls[0].agentId, "codex", "another family, the best of the others");
  const [r] = rows(c);
  assert.equal(rows(c).length, 1);
  assert.deepEqual([r.kind, r.verdict, r.outcome, r.agentA, r.familyA, r.agentB, r.familyB], ["email", "match", "proceeded", "claude", "anthropic", "codex", "openai"]);
  assert.ok(r.similarity! >= 0.85);
  assert.equal((r.draftA as { subject: string }).subject, "Q3 report"); assert.deepEqual((r.draftB as { to: string[] }).to, ["bob@example.com"], "the reply is kept as drafted, addresses lowercased");
});

test("AC1: a match never bypasses an owner rule that says always ask: the owner still gets the usual card, with the pair's result on it", async (t) => {
  const c = hub();
  autoApprove(c, "claude", "gmail");
  answer(c, "codex", EMAIL_B);
  const { root, control } = await withControl(t, c);
  const pipeline = c.store.createRoom("pipeline", { topic: "x" });
  writeRoom(root, "pipeline", { roster: ["claude", "codex", "hermes"], tools: { gmail: "ask" } });
  await control.load();
  const got = track(sendEmail(c, grant(c, "claude", { roomId: pipeline.id })));
  await until(() => c.store.listApprovals("pending").length === 1, "the owner's card");
  const apr = c.store.listApprovals("pending")[0];
  assert.equal(apr.twoKey, undefined, "an ordinary approval: the drafts agreed");
  assert.match(apr.detail, /Two-key check passed: codex \(openai\) drafted the same email on its own/);
  assert.equal(got.s.done, false, "waiting for the owner");
  c.approvals.decide(apr.id, "approved");
  assert.equal((await got.p).status, "approved");
  assert.equal(secondKeyCalls().length, 1);
  // and the same pair in a room with no such rule, for an agent that does not auto-approve, also asks
  const plain = track(sendEmail(c, grant(c, "codex")));
  answer(c, "claude", EMAIL_B);
  await until(() => c.store.listApprovals("pending").length === 1, "the usual card");
  c.approvals.decide(c.store.listApprovals("pending")[0].id, "rejected");
  assert.equal((await plain.p).status, "rejected");
});

test("AC2: recipients that differ, an extra number in the body, or 'no action' make exactly one owner card with both drafts; nothing runs until the owner picks", async () => {
  const cases: [string, unknown, RegExp, (card: NonNullable<Approval["twoKey"]>) => void][] = [
    ["another recipient", { ...EMAIL_B, to: ["bob@example.org"] }, /recipients differ/, (k) => assert.deepEqual(k.diffs.find((d) => d.field === "to"), { field: "to", a: "bob@example.com", b: "bob@example.org", level: "critical" })],
    ["an extra number", { ...EMAIL_B, body: EMAIL_B.body.replace("Revenue came", "Revenue across 4 regions came") }, /numbers differ/, (k) => assert.ok(k.diffs.some((d) => d.level === "entity" && d.b.includes("4")))],
    ["no action", { action: "none", reason: "nobody asked for this email" }, /isn't called for: nobody asked/, (k) => { assert.equal(k.verdict, "no_action"); assert.equal(k.b!.draft, null); assert.match(k.b!.noAction!, /nobody asked/); assert.deepEqual(k.choices.map((x) => x.id), ["a", "neither"]); }],
    ["a draft in prose", "Dear Bob, here is my email to you.", /no usable draft/, (k) => { assert.equal(k.verdict, "unavailable"); assert.equal(k.b!.draft, null); }],
  ];
  for (const [name, reply, why, extra] of cases) {
    const c = hub();
    autoApprove(c, "claude", "gmail"); // even an agent that sends without asking
    answer(c, "codex", reply);
    const pushes: string[] = [];
    c.orch.attention.push = (title) => { pushes.push(title); };
    const got = track(sendEmail(c));
    await until(() => cards(c).length === 1, `the card for ${name}`);
    await sleep(60);
    assert.equal(cards(c).length, 1, `${name}: exactly one card`);
    assert.equal(c.store.listApprovals("pending").length, 1, `${name}: and nothing else is waiting`);
    assert.equal(got.s.done, false, `${name}: nothing runs until the owner picks`);
    const card = cards(c)[0], k = card.twoKey!;
    assert.match(k.why, why, name);
    assert.equal(k.a.agentId, "claude"); assert.equal(k.a.family, "anthropic"); assert.equal((k.a.draft as { subject: string }).subject, "Q3 report");
    if (k.b) { assert.equal(k.b.agentId, "codex"); assert.equal(k.b.family, "openai"); }
    extra(k);
    assert.equal(card.status, "pending"); assert.equal(card.agentId, "claude"); assert.equal(card.tool, "gmail");
    assert.ok(pushes.some((p) => /Two agents disagree|no second key/.test(p)), `${name}: through the attention gate (${pushes})`);
    c.approvals.decide(card.id, "rejected", "owner", "neither");
    const res = await got.p;
    assert.equal(res.status, "rejected", name); assert.equal(res.choice, "neither");
    assert.equal(rows(c)[0].outcome, "owner_neither", name);
  }
});

test("AC2: the card is a disagreement for the attention gate (counted as an interruption, blocking so it is always pushed)", async () => {
  const c = hub();
  answer(c, "codex", { ...EMAIL_B, to: ["x@example.org"] });
  const pushes: [string, string][] = [];
  c.orch.attention.push = (t, b) => { pushes.push([t, b]); };
  const got = track(sendEmail(c));
  await until(() => cards(c).length === 1, "the card");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0][0], "Two agents disagree"); assert.match(pushes[0][1], /claude wants to send an email\. The recipients differ/);
  assert.equal(c.orch.attention.day().interrupts, 1);
  c.approvals.decide(cards(c)[0].id, "rejected");
  assert.equal((await got.p).status, "rejected", "a plain Reject on the card is run neither");
});

test("AC2: the owner picking draft A runs A only; picking B hands the agent B instead; picking neither runs nothing", async () => {
  const mismatch = () => { const c = hub(); answer(c, "codex", { ...EMAIL_B, to: ["bob@example.org"] }); return c; };
  // A
  let c = mismatch();
  let got = track(sendEmail(c));
  await until(() => cards(c).length === 1, "card");
  c.approvals.decide(cards(c)[0].id, "approved", "owner", "a");
  let res = await got.p;
  assert.equal(res.status, "approved"); assert.equal(res.choice, "a");
  assert.equal(rows(c)[0].outcome, "owner_a");
  // B
  c = mismatch();
  got = track(sendEmail(c));
  await until(() => cards(c).length === 1, "card");
  c.approvals.decide(cards(c)[0].id, "approved", "owner", "b");
  res = await got.p;
  assert.equal(res.status, "approved"); assert.equal(res.choice, "b");
  assert.deepEqual((res.twoKey!.b!.draft as { to: string[] }).to, ["bob@example.org"]);
  assert.equal(rows(c)[0].outcome, "owner_b");
  // neither
  c = mismatch();
  got = track(sendEmail(c));
  await until(() => cards(c).length === 1, "card");
  c.approvals.decide(cards(c)[0].id, "rejected", "owner", "neither");
  assert.equal((await got.p).status, "rejected");
  assert.equal(rows(c)[0].outcome, "owner_neither");
  // no decision at all: treated as neither
  c = mismatch();
  got = track(sendEmail(c));
  await until(() => cards(c).length === 1, "card");
  c.approvals.decide(cards(c)[0].id, "expired", "system");
  assert.equal((await got.p).status, "expired");
  assert.equal(rows(c)[0].outcome, "expired");
});

test("AC2: the second agent never sees the first draft, nor the words the first agent used to ask; it does get the work", async () => {
  const c = hub();
  answer(c, "codex", EMAIL_B);
  const secretSubject = "Zebra Quarterly Plan", secretLine = "Platypus lunch menu is confirmed for the whole team.";
  const goal = { id: "goal_tk", roomId: c.room.id, text: "Tell Bob how the quarter went", status: "running", contract: { objective: "Send Bob the Q3 results", constraints: ["Keep it short"], deliverables: [], outOfScope: [], version: 1, lockedAt: 1, amendments: [], requirements: [{ id: "G1", text: "Bob is told the revenue number", status: "open" }] }, createdAt: 1 } as unknown as Goal;
  c.store.saveGoal(goal);
  const task = { id: "task_tk", roomId: c.room.id, goalId: goal.id, title: "Email Bob the results", description: "Write and send the quarter summary to Bob.", taskType: "writing", acceptance: "", dependsOn: [], assignee: "claude", owner: "claude", status: "running", attempts: 1, createdAt: 1, updatedAt: 1, criteria: [{ id: "AC1", text: "Mentions the revenue" }] } as unknown as Task;
  c.store.saveTask(task);
  const say = (kind: "human" | "agent", aid: string, name: string, text: string) => c.store.addMessage({ roomId: c.room.id, author: kind === "human" ? { kind: "human", id: "owner", name } : { kind: "agent", id: aid, name }, text, type: kind, mentions: [] });
  say("human", "owner", "Blake", "Please email Bob the Q3 results, he is waiting.");
  say("agent", "claude", "Claude", `My draft: subject "${secretSubject}". ${secretLine}`);
  say("agent", "hermes", "Hermes", "Revenue was up this quarter, I checked the dashboard.");
  const input = { to: ["bob@example.com"], cc: [], subject: secretSubject, body: `Hi Bob,\n\n${secretLine}\n\nThe Q3 report is attached.\n\nBest,\nClaude` };
  const a = asked(c, grant(c, "claude", { taskId: task.id }), "gmail", SEND, input);
  await until(() => cards(c).length === 1 || secondKeyCalls().length > 0, "the second agent");
  await sleep(40);
  const prompt = secondKeyCalls()[0].prompt;
  for (const leak of [secretSubject, secretLine, "Platypus", "Zebra", "bob@example.com", SEND, JSON.stringify(input), "The Q3 report is attached"]) assert.ok(!prompt.includes(leak), `the prompt leaks ${JSON.stringify(leak)}`);
  for (const given of ["Send Bob the Q3 results", "Bob is told the revenue number", "Email Bob the results", "Mentions the revenue", "Please email Bob the Q3 results", "Revenue was up this quarter", "Keep it short", "(tool: gmail)"]) assert.ok(prompt.includes(given), `the prompt lacks ${JSON.stringify(given)}`);
  assert.match(prompt, /^\[\[TWOKEY\]\]/);
  assert.match(prompt, /"to": \["address"\]/);
  assert.ok(cards(c).length === 1 || (await a).status !== "pending");
  for (const x of c.store.listApprovals("pending")) c.approvals.decide(x.id, "rejected");
  await a;
});

test("AC1: a second agent of the same family is never used; with one family available the owner decides, never one key", async () => {
  // claude2 is a second Claude: better quality than anyone, and still not a second key
  let c = hub();
  c.store.saveAgent({ ...agentOf(c, "claude"), id: "claude2", name: "Claude 2", settings: { quality: 0.99, twokey: EMAIL } });
  answer(c, "codex", EMAIL_B);
  const got = track(sendEmail(c));
  await got.p;
  assert.deepEqual(secondKeyCalls().map((x) => x.agentId), ["codex"], "codex, not claude2");

  // Hermes routed to a Claude model is Claude's family, so with Codex gone nobody else is left
  c = hub();
  c.store.deleteAgent("codex");
  c.store.saveAgent({ ...agentOf(c, "hermes"), settings: { quality: 0.65, model: "claude-sonnet-5-5", twokey: EMAIL } });
  autoApprove(c, "claude", "gmail");
  const one = track(sendEmail(c));
  await until(() => cards(c).length === 1, "the owner's card");
  assert.equal(secondKeyCalls().length, 0, "nobody was asked");
  const k = cards(c)[0].twoKey!;
  assert.equal(k.verdict, "unavailable"); assert.match(k.why, /same model family/); assert.equal(k.b, undefined);
  assert.deepEqual(k.choices.map((x) => x.id), ["a", "neither"], "run it as asked, or not at all");
  assert.equal(one.s.done, false, "claude auto-approves email, and still nothing runs on one key");
  c.approvals.decide(cards(c)[0].id, "approved", "owner", "a");
  assert.equal((await one.p).status, "approved");
  assert.equal(rows(c)[0].verdict, "unavailable");

  // one agent in the whole hub
  c = hub();
  c.store.deleteAgent("codex"); c.store.deleteAgent("hermes");
  const solo = track(sendEmail(c));
  await until(() => cards(c).length === 1, "the owner's card");
  assert.match(cards(c)[0].twoKey!.why, /no other agent is ready/);
  c.approvals.decide(cards(c)[0].id, "rejected");
  assert.equal((await solo.p).status, "rejected");
});

test("AC1: the second agent comes from this room's roster; an agent that is off, out of the roster or on probation is not asked", async (t) => {
  const c = hub();
  answer(c, "codex", EMAIL_B); answer(c, "hermes", EMAIL_B);
  autoApprove(c, "claude", "gmail");
  const { root, control } = await withControl(t, c);
  const pipeline = c.store.createRoom("pipeline", { topic: "x" });
  writeRoom(root, "pipeline", { roster: ["claude", "hermes"], tools: {} });
  await control.load();
  const res = await sendEmail(c, grant(c, "claude", { roomId: pipeline.id }));
  assert.equal(res.auto, true);
  assert.deepEqual(secondKeyCalls().map((x) => x.agentId), ["hermes"], "codex is better but not in this room");
  // a roster with only claude: nobody to ask, the owner decides
  writeRoom(root, "pipeline", { roster: ["claude"], tools: {} });
  await control.load();
  const alone = track(sendEmail(c, grant(c, "claude", { roomId: pipeline.id })));
  await until(() => cards(c).length === 1, "the card");
  assert.equal(secondKeyCalls().length, 1, "no new call");
  c.approvals.decide(cards(c)[0].id, "rejected");
  await alone.p;
  // an agent that is switched off
  const d = hub();
  answer(d, "codex", EMAIL_B); answer(d, "hermes", EMAIL_B);
  d.store.saveAgent({ ...agentOf(d, "codex"), enabled: false });
  autoApprove(d, "claude", "gmail");
  await sendEmail(d);
  assert.deepEqual(secondKeyCalls().map((x) => x.agentId), ["hermes"]);
});

test("AC1: a CRM update goes through the same check; a different field value is a disagreement", async () => {
  const c = hub();
  autoApprove(c, "claude", "salesforce");
  const input = { sobject: "Opportunity", operation: "update", id: "006xx000001AbCd", data: { StageName: "Closed Won", Amount: "50,000" } };
  const tool = "mcp__salesforce__update_record";
  answer(c, "codex", { object: "opportunity", op: "update", id: "006xx000001AbCd", fields: { stagename: "closed won", amount: 50000 } });
  const ok = await asked(c, grant(c), "salesforce", tool, input);
  assert.equal(ok.auto, true);
  assert.equal(secondKeyCalls().length, 1);
  assert.deepEqual([rows(c)[0].kind, rows(c)[0].verdict, rows(c)[0].tool], ["crm", "match", "salesforce"]);

  answer(c, "codex", { object: "Opportunity", op: "update", id: "006xx000001AbCd", fields: { StageName: "Closed Won", Amount: 5000 } });
  const bad = track(asked(c, grant(c), "salesforce", tool, input));
  await until(() => cards(c).length === 1, "the card");
  const k = cards(c)[0].twoKey!;
  assert.equal(k.kind, "crm"); assert.match(k.why, /Amount differs/);
  assert.deepEqual(k.diffs.find((d) => d.field === "field Amount"), { field: "field Amount", a: "50,000", b: "5000", level: "critical" });
  assert.equal(bad.s.done, false);
  c.approvals.decide(cards(c)[0].id, "approved", "owner", "a");
  assert.equal((await bad.p).choice, "a");

  // reads are not two-key, and neither is a request that names no CRM write
  const calls = secondKeyCalls().length;
  autoApprove(c, "claude", "salesforce");
  assert.equal((await c.orch.requestApproval(grant(c), "salesforce", "mcp__Atmosphere_CW_AI__salesforce_search", "{}", {})).auto, true);
  assert.equal(secondKeyCalls().length, calls);
});

test("AC1: shell `rm -rf` is two-key (matching target lists proceed, differing ones ask); `ls` is not", async () => {
  const c = hub();
  const work = realpathSync(mkdtempSync(join(tmpdir(), "tk-cwd-")));
  mkdirSync(join(work, "build")); writeFileSync(join(work, "build", "x.o"), "x"); writeFileSync(join(work, "keep.txt"), "k");
  autoApprove(c, "claude", "shell");
  const g = grant(c, "claude", { cwd: work });
  const rm = (cmd: string) => c.orch.requestApproval(g, "shell", "Bash", JSON.stringify({ command: cmd }), { command: cmd });

  assert.equal((await rm("ls -la")).auto, true); assert.equal(secondKeyCalls().length, 0, "ls is not two-key");
  answer(c, "codex", { targets: ["./build/"] });
  const ok = await rm("rm -rf build");
  assert.equal(ok.auto, true); assert.equal(secondKeyCalls().length, 1);
  assert.deepEqual((rows(c)[0].draftA as { targets: string[] }).targets, [join(work, "build")]);
  assert.equal(rows(c)[0].verdict, "match");
  const prompt = secondKeyCalls()[0].prompt;
  assert.ok(prompt.includes("build/") && prompt.includes("keep.txt"), "it is shown what is in the folder");
  assert.ok(!prompt.includes("rm -rf"), "never the command");

  answer(c, "codex", { targets: ["keep.txt"] });
  const bad = track(rm("rm -rf build"));
  await until(() => cards(c).length === 1, "the card");
  const k = cards(c)[0].twoKey!;
  assert.equal(k.kind, "delete"); assert.match(k.why, /only the first deletes .*build.*only the second deletes .*keep\.txt/);
  assert.equal(bad.s.done, false);
  c.approvals.decide(cards(c)[0].id, "rejected", "owner", "neither");
  assert.equal((await bad.p).status, "rejected");

  // a command that deletes more than it lists can never match a list: the owner decides
  answer(c, "codex", { targets: ["build"] });
  const clean = track(rm("git clean -fdx"));
  await until(() => cards(c).length === 1, "the card for git clean");
  assert.match(cards(c)[0].twoKey!.why, /deletes more than it lists/);
  c.approvals.decide(cards(c)[0].id, "rejected");
  await clean.p;
  // and one it cannot read at all
  const odd = track(rm("eval \"$X\""));
  await until(() => cards(c).length === 1, "the card for eval");
  c.approvals.decide(cards(c)[0].id, "rejected");
  await odd.p;
});

// ---- a file delete, through the broker

function folder(files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tk-grant-")));
  for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); }
  return root;
}
const FILES = { "gone.txt": "bye\n", "other.txt": "other\n", "keep.txt": "keep\n" };
function writeBack(c: Ctx, root: string, changes: { relPath: string; content: Buffer | null }[]) {
  const g = c.orch.files.addGrant({ path: root, agentId: "claude", read: true, write: true });
  const r = c.orch.files.proposeTask({ grantId: g.id, agentId: "claude", roomId: c.room.id, goalId: "goal_x", taskId: "task_x", title: "Tidy the notes", changes });
  assert.ok(r.ok && r.proposal);
  return r.ok && r.proposal ? r.proposal : (undefined as never);
}
const DELETE_GONE = [{ relPath: "gone.txt", content: null }, { relPath: "keep.txt", content: Buffer.from("keep, edited\n") }];

test("AC1: a file delete goes through the same check; matching drafts leave the owner's usual approval (with a note), and the file goes only when the owner approves", async () => {
  const c = hub();
  const root = folder(FILES);
  answer(c, "codex", { targets: ["gone.txt"] });
  const p = writeBack(c, root, DELETE_GONE);
  await until(() => c.store.listApprovals("pending").length === 1, "the owner's approval");
  const apr = c.store.listApprovals("pending")[0];
  assert.equal(apr.twoKey, undefined); assert.equal(apr.proposalId, p.id);
  assert.match(apr.detail, /Two-key check passed: codex \(openai\) drafted the same delete on its own/);
  assert.equal(existsSync(join(root, "gone.txt")), true, "nothing deleted before the owner approves");
  assert.equal(secondKeyCalls().length, 1);
  assert.ok(secondKeyCalls()[0].prompt.includes("other.txt"), "the folder listing is the input");
  assert.ok(!secondKeyCalls()[0].prompt.includes("keep, edited"), "never the new content");
  c.approvals.decide(apr.id, "approved");
  await until(() => c.orch.files.proposal(p.id)!.status === "applied", "applied");
  assert.equal(existsSync(join(root, "gone.txt")), false);
  assert.equal(existsSync(join(root, "other.txt")), true);
  assert.deepEqual([rows(c)[0].kind, rows(c)[0].verdict, rows(c)[0].tool], ["delete", "match", "filesystem"]);

  // a proposal that deletes nothing is not two-key
  const calls = secondKeyCalls().length;
  const q = writeBack(c, folder(FILES), [{ relPath: "new.txt", content: Buffer.from("n\n") }]);
  await until(() => c.store.listApprovals("pending").length === 1, "the plain approval");
  assert.equal(secondKeyCalls().length, calls);
  c.approvals.decide(c.store.listApprovals("pending")[0].id, "rejected");
  await until(() => c.orch.files.proposal(q.id)!.status === "rejected", "rejected");
});

test("AC2: a file delete the drafts disagree on is one card; A deletes what was asked, B deletes the other agent's list, neither deletes nothing", async () => {
  const run = async (pick: "a" | "b" | "neither") => {
    const c = hub();
    const root = folder(FILES);
    answer(c, "codex", { targets: ["other.txt"] });
    const p = writeBack(c, root, DELETE_GONE);
    await until(() => cards(c).length === 1, "the two-key card");
    await sleep(40);
    assert.equal(c.store.listApprovals("pending").length, 1, "one card, not a card and an approval");
    const card = cards(c)[0];
    assert.equal(card.proposalId, p.id, "the apps can open the diff");
    assert.equal(c.orch.files.proposal(p.id)!.approvalId, card.id);
    assert.equal(card.twoKey!.kind, "delete");
    assert.deepEqual((card.twoKey!.a.draft as { targets: string[] }).targets, [join(root, "gone.txt")]);
    assert.deepEqual((card.twoKey!.b!.draft as { targets: string[] }).targets, [join(root, "other.txt")]);
    for (const f of Object.keys(FILES)) assert.equal(existsSync(join(root, f)), true, "nothing is deleted before the owner picks");
    assert.equal(c.orch.files.proposal(p.id)!.status, "pending");
    if (pick === "neither") c.approvals.decide(card.id, "rejected", "owner", "neither"); else c.approvals.decide(card.id, "approved", "owner", pick);
    await until(() => c.orch.files.proposal(p.id)!.status !== "pending", "settled");
    return { c, root, p: c.orch.files.proposal(p.id)! };
  };
  let r = await run("a");
  assert.equal(r.p.status, "applied");
  assert.deepEqual(Object.keys(FILES).map((f) => existsSync(join(r.root, f))), [false, true, true], "A only: gone.txt");
  r = await run("b");
  assert.equal(r.p.status, "applied");
  assert.deepEqual(Object.keys(FILES).map((f) => existsSync(join(r.root, f))), [true, false, true], "B only: other.txt");
  assert.deepEqual(r.p.files!.map((f) => `${f.op} ${f.relPath}`), ["delete other.txt", "edit keep.txt"].sort((a, b) => a.split(" ")[1].localeCompare(b.split(" ")[1])), "the edit of keep.txt stays");
  assert.ok(r.c.store.listAudit(500).some((a) => a.action === "file.write.redrafted"));
  r = await run("neither");
  assert.equal(r.p.status, "rejected");
  assert.deepEqual(Object.keys(FILES).map((f) => existsSync(join(r.root, f))), [true, true, true]);
});

test("AC2: a file delete with no second family is the owner's decision on a card (never one key); an unusable second draft is the same", async () => {
  const c = hub();
  c.store.deleteAgent("codex"); c.store.deleteAgent("hermes");
  const root = folder(FILES);
  const p = writeBack(c, root, DELETE_GONE);
  await until(() => cards(c).length === 1, "the card");
  assert.equal(cards(c)[0].twoKey!.verdict, "unavailable");
  c.approvals.decide(cards(c)[0].id, "approved", "owner", "a");
  await until(() => c.orch.files.proposal(p.id)!.status === "applied", "applied");
  assert.equal(existsSync(join(root, "gone.txt")), false);
  // an owner who never answers: nothing is deleted
  const d = hub();
  d.store.deleteAgent("codex"); d.store.deleteAgent("hermes");
  const root2 = folder(FILES);
  const q = writeBack(d, root2, DELETE_GONE);
  await until(() => cards(d).length === 1, "the card");
  d.approvals.decide(cards(d)[0].id, "expired", "system");
  await until(() => d.orch.files.proposal(q.id)!.status === "expired", "expired");
  assert.equal(existsSync(join(root2, "gone.txt")), true);
});

// ---- MCP, HTTP, shadow runs, subagents, settings, audit

async function boot(t: TestContext) {
  const c = hub();
  const app = await buildServer({ ...c, ownerName: "Blake" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const pair = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: (app as unknown as { pairingCode: () => string }).pairingCode(), deviceName: "Mac" }) });
  const { token } = (await pair.json()) as { token: string };
  const owner = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const connect = async (agentId: string, extra: Record<string, unknown> = {}) => {
    const key = `tok_${id("t")}`;
    c.orch.grants.set(key, { agentId, roomId: c.room.id, locked: true, expiresAt: Date.now() + 60_000, ...extra });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    t.after(() => client.close());
    return async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text;
  };
  return { ...c, app, base, owner, connect };
}

test("AC2 over MCP and HTTP: request_approval and Claude Code's approval_prompt both go through the check; the owner's pick comes back as the tool's answer", async (t) => {
  const c = await boot(t);
  const asClaude = await c.connect("claude");
  answer(c, "codex", { ...EMAIL_B, cc: ["carol@example.com"] });
  const answerCard = async (choice: string) => {
    await until(() => cards(c).length === 1, "the card");
    return fetch(`${c.base}/approvals/${cards(c)[0].id}`, { method: "POST", headers: c.owner, body: JSON.stringify({ choice }) });
  };

  // request_approval: B is run by the agent itself, so it is told exactly what to run
  let reply = asClaude("request_approval", { tool: "gmail", action: "send the Q3 email", detail: JSON.stringify(EMAIL) });
  assert.equal((await answerCard("b")).status, 200);
  const text = await reply;
  assert.match(text, /^APPROVED, WITH THE OTHER DRAFT/);
  assert.deepEqual(JSON.parse(text.slice(text.indexOf("{"))).cc, ["carol@example.com"]);
  // A
  reply = asClaude("request_approval", { tool: "gmail", action: "send the Q3 email", detail: JSON.stringify(EMAIL) });
  assert.equal((await answerCard("a")).status, 200);
  assert.equal(await reply, "APPROVED: go ahead.");
  // neither, and a plain Reject
  reply = asClaude("request_approval", { tool: "gmail", action: "send the Q3 email", detail: JSON.stringify(EMAIL) });
  assert.equal((await answerCard("neither")).status, 200);
  assert.match(await reply, /^DENIED \(rejected\)/);
  reply = asClaude("request_approval", { tool: "gmail", action: "send the Q3 email", detail: JSON.stringify(EMAIL) });
  await until(() => cards(c).length === 1, "the card");
  assert.equal((await fetch(`${c.base}/approvals/${cards(c)[0].id}`, { method: "POST", headers: c.owner, body: JSON.stringify({ decision: "rejected" }) })).status, 200);
  assert.match(await reply, /^DENIED/);
  // the card cannot be approved without saying which draft, or with an answer it does not offer
  reply = asClaude("request_approval", { tool: "gmail", action: "send the Q3 email", detail: JSON.stringify(EMAIL) });
  await until(() => cards(c).length === 1, "the card");
  const cardId = cards(c)[0].id;
  assert.equal((await fetch(`${c.base}/approvals/${cardId}`, { method: "POST", headers: c.owner, body: JSON.stringify({ decision: "approved" }) })).status, 400);
  assert.equal((await fetch(`${c.base}/approvals/${cardId}`, { method: "POST", headers: c.owner, body: JSON.stringify({ choice: "c" }) })).status, 400);
  assert.equal(c.store.getApproval(cardId)!.status, "pending");
  await fetch(`${c.base}/approvals/${cardId}`, { method: "POST", headers: c.owner, body: JSON.stringify({ choice: "neither" }) });
  await reply;

  // approval_prompt: B is put into the tool's own input when it fits
  const input = { to: "bob@example.com", subject: "Q3 report", body: EMAIL.body, cc: "" };
  reply = asClaude("approval_prompt", { tool_name: SEND, input });
  assert.equal((await answerCard("b")).status, 200);
  const allow = JSON.parse(await reply) as { behavior: string; updatedInput: Record<string, string> };
  assert.equal(allow.behavior, "allow");
  assert.equal(allow.updatedInput.cc, "carol@example.com"); assert.equal(allow.updatedInput.to, "bob@example.com");
  // ... and when it does not fit (no cc in the input), the agent is told to ask again with it, and that second ask goes through once
  const bare = { to: "bob@example.com", subject: "Q3 report", body: EMAIL.body };
  const before = secondKeyCalls().length;
  reply = asClaude("approval_prompt", { tool_name: SEND, input: bare });
  assert.equal((await answerCard("b")).status, 200);
  const deny = JSON.parse(await reply) as { behavior: string; message: string };
  assert.equal(deny.behavior, "deny"); assert.match(deny.message, /Do exactly this instead, and ask again/);
  assert.equal(secondKeyCalls().length, before + 1);
  const again = JSON.parse(await asClaude("approval_prompt", { tool_name: SEND, input: { to: "Bob@Example.com", cc: "carol@example.com", subject: EMAIL_B.subject, body: EMAIL_B.body } })) as { behavior: string };
  assert.equal(again.behavior, "allow", "the owner already picked exactly this");
  assert.equal(secondKeyCalls().length, before + 1, "no second agent for it");
  assert.equal(rows(c)[0].outcome, "permitted");
  const twice = track(asClaude("approval_prompt", { tool_name: SEND, input: { to: "Bob@Example.com", cc: "carol@example.com", subject: EMAIL_B.subject, body: EMAIL_B.body } }));
  await until(() => secondKeyCalls().length === before + 2, "a fresh check: the pick is good once");
  for (const x of c.store.listApprovals("pending")) c.approvals.decide(x.id, "rejected");
  await twice.p;

  // Claude Code's Bash goes the same way
  answer(c, "codex", { targets: ["nothing"] });
  const rmp = track(asClaude("approval_prompt", { tool_name: "Bash", input: { command: "rm -rf build" } }));
  await until(() => cards(c).length === 1, "the card for rm");
  assert.equal(cards(c)[0].twoKey!.kind, "delete");
  assert.equal(rmp.s.done, false);
  c.approvals.decide(cards(c)[0].id, "rejected");
  assert.equal(JSON.parse(await rmp.p).behavior, "deny");
  // a harmless command is not held up
  assert.equal(JSON.parse(await asClaude("approval_prompt", { tool_name: "Bash", input: { command: "ls" } }).catch(() => "{}")).behavior === undefined, false, "asks as before (the owner is not asked twice)");
});

test("GET /twokey lists every check; the table survives with drafts and the verdict", async (t) => {
  const c = await boot(t);
  answer(c, "codex", EMAIL_B); autoApprove(c, "claude", "gmail");
  await sendEmail(c);
  const list = (await (await fetch(`${c.base}/twokey`, { headers: c.owner })).json()) as { id: string; verdict: string }[];
  assert.equal(list.length, 1); assert.equal(list[0].verdict, "match");
  assert.equal(((await (await fetch(`${c.base}/twokey/${list[0].id}`, { headers: c.owner })).json()) as { agentB: string }).agentB, "codex");
  assert.equal((await fetch(`${c.base}/twokey/nope`, { headers: c.owner })).status, 404);
  assert.equal(((await (await fetch(`${c.base}/twokey?verdict=mismatch`, { headers: c.owner })).json()) as unknown[]).length, 0);
  // settings: the owner turns it off or tightens it
  const put = await fetch(`${c.base}/settings`, { method: "PUT", headers: c.owner, body: JSON.stringify({ twoKey: { enabled: true, threshold: 0.99 } }) });
  assert.equal(((await put.json()) as { twoKey: { threshold: number } }).twoKey.threshold, 0.99);
  assert.equal(c.store.getSettings().twoKey?.threshold, 0.99);
});

test("a practice run never reaches the second key; a subagent's request is handled like anyone's; switching two-key off, or a stricter threshold, changes the check", async () => {
  // shadow: refused up front, no second agent, no card, no record
  let c = hub();
  const shadow = await c.orch.requestApproval(grant(c, "claude", { shadow: true }), "gmail", SEND, JSON.stringify(EMAIL), EMAIL);
  assert.equal(shadow.status, "rejected");
  assert.equal(secondKeyCalls().length, 0); assert.equal(rows(c).length, 0); assert.equal(c.store.listApprovals().length, 0);

  // a helper (a subagent) that asks to send email: its own family decides who may be the second key
  c = hub();
  const parent = { id: "task_parent", roomId: c.room.id, goalId: "goal_h", title: "Write the update", description: "d", taskType: "writing", acceptance: "", dependsOn: [], assignee: "claude", status: "running", attempts: 1, createdAt: 1, updatedAt: 1 } as unknown as Task;
  const helper = { ...parent, id: "task_helper", title: "Draft the email to Bob", description: "Draft and send Bob the figures.", kind: "subagent", parentTaskId: parent.id, assignee: "codex" } as unknown as Task;
  c.store.saveTask(parent); c.store.saveTask(helper);
  answer(c, "claude", EMAIL_B); answer(c, "hermes", EMAIL_B);
  autoApprove(c, "codex", "gmail");
  const res = await sendEmail(c, grant(c, "codex", { taskId: helper.id }));
  assert.equal(res.auto, true);
  assert.ok(secondKeyCalls().every((x) => x.agentId !== "codex"), "never the helper's own family");
  assert.equal(secondKeyCalls()[0].agentId, "claude", "the best of the other families");
  assert.ok(secondKeyCalls()[0].prompt.includes("Draft the email to Bob") && secondKeyCalls()[0].prompt.includes("a helper for: Write the update"));
  assert.equal(rows(c)[0].agentA, "codex"); assert.equal(rows(c)[0].taskId, helper.id);

  // off: the old behaviour, no second agent
  c = hub();
  c.store.setSettings({ ...c.store.getSettings(), twoKey: { enabled: false } });
  autoApprove(c, "claude", "gmail");
  assert.equal((await sendEmail(c)).auto, true);
  assert.equal(secondKeyCalls().length, 0); assert.equal(rows(c).length, 0);

  // threshold: the same pair that matched at 0.85 is a disagreement at 0.99
  c = hub();
  answer(c, "codex", EMAIL_B); autoApprove(c, "claude", "gmail");
  c.store.setSettings({ ...c.store.getSettings(), twoKey: { enabled: true, threshold: 0.99 } });
  const strict = track(sendEmail(c));
  await until(() => cards(c).length === 1, "the card");
  assert.match(cards(c)[0].twoKey!.why, /too different/);
  assert.equal(cards(c)[0].twoKey!.words!.a.some((w) => w.d), true, "the card carries the words that differ");
  c.approvals.decide(cards(c)[0].id, "rejected");
  await strict.p;
});

test("a room that forbids the tool is refused before any second agent is asked", async (t) => {
  const c = hub();
  const { root, control } = await withControl(t, c);
  const pipeline = c.store.createRoom("pipeline", { topic: "x" });
  writeRoom(root, "pipeline", { roster: ["claude", "codex", "hermes"], tools: { gmail: "off" } });
  await control.load();
  const res = await sendEmail(c, grant(c, "claude", { roomId: pipeline.id }));
  assert.equal(res.status, "rejected");
  assert.equal(secondKeyCalls().length, 0); assert.equal(rows(c).length, 0); assert.deepEqual(c.store.listApprovals("pending"), []);
});

test("AC3: every check is audited and kept in the twokey table; email bodies are cut and secrets never reach the log or the table", async () => {
  const c = hub();
  autoApprove(c, "claude", "gmail");
  const longBody = `Hi Bob,\n\nMy login is password: hunter2hunter2 and the key sk-abcdefghijklmnop1234567890. ${"Details follow. ".repeat(80)}\n\nBest,\nClaude`;
  const email = { ...EMAIL, subject: "Credentials", body: longBody };
  answer(c, "codex", { ...email, body: longBody.replace("My login is", "My own login is") });
  await asked(c, grant(c), "gmail", SEND, email); // match
  answer(c, "codex", { ...email, to: ["eve@example.org"], body: longBody });
  const bad = track(asked(c, grant(c), "gmail", SEND, email)); // mismatch
  await until(() => cards(c).length === 1, "the card");
  c.approvals.decide(cards(c)[0].id, "approved", "owner", "b");
  await bad.p;
  answer(c, "codex", { action: "none", reason: "no" });
  const none = track(asked(c, grant(c), "gmail", SEND, email)); // no action
  await until(() => cards(c).length === 1, "the card");
  c.approvals.decide(cards(c)[0].id, "rejected", "owner", "neither");
  await none.p;

  const audit = c.store.listAudit(1000);
  const tk = audit.filter((a) => a.action.startsWith("twokey."));
  for (const action of ["twokey.requested", "twokey.match", "twokey.mismatch", "twokey.no_action", "twokey.decided"]) assert.ok(tk.some((a) => a.action === action), `${action} is audited: ${[...new Set(tk.map((a) => a.action))]}`);
  assert.equal(tk.filter((a) => a.action === "twokey.requested").length, 3, "one per check");
  for (const a of tk) {
    assert.ok(!/hunter2|sk-abcdefghijklmnop/.test(a.detail), `no secrets in the audit: ${a.detail}`);
    assert.ok(a.detail.length < 900, `bodies are cut short in the audit (${a.detail.length})`);
  }
  assert.match(tk.find((a) => a.action === "twokey.mismatch")!.detail, /A: to=bob@example\.com .*\| B \(codex, openai\): to=eve@example\.org/);
  assert.ok(tk.some((a) => a.action === "twokey.decided" && /run draft B/.test(a.detail) && a.actor === "owner"));
  assert.ok(tk.some((a) => a.action === "twokey.decided" && /run neither/.test(a.detail)));
  const stored = rows(c);
  assert.equal(stored.length, 3);
  assert.deepEqual(stored.map((r) => r.verdict).sort(), ["match", "mismatch", "no_action"]);
  for (const r of stored) {
    const json = JSON.stringify(r);
    assert.ok(!/hunter2|sk-abcdefghijklmnop/.test(json), "no secrets in the table");
    assert.ok(json.length < 20_000);
    assert.ok(r.agentA && r.familyA && r.agentB && r.familyB && r.outcome !== "pending", "who, and what came of it");
  }
  assert.ok(stored.some((r) => r.outcome === "owner_b") && stored.some((r) => r.outcome === "owner_neither") && stored.some((r) => r.outcome === "proceeded"));
  assert.ok(audit.some((a) => a.action === "approval.requested" && /gmail/.test(a.detail)), "the owner's card is in the usual approval log too");
});

// ---------------------------------------------------------------- helpers that need the control folder

async function withControl(t: TestContext, c: Ctx) {
  const root = join(c.dir, "Agent Room");
  const control = new ControlFolder(root, c.store, { debounceMs: 40, ownerName: "Blake", watch: false });
  await control.init();
  control.start();
  c.orch.control = control;
  t.after(() => { control.close(); c.orch.standing.stop(); });
  return { root, control };
}
function writeRoom(root: string, slug: string, extra: Record<string, unknown>) {
  const file = join(root, "rooms", slug, "ROOM.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, emitFile({ kind: "room", schema: 1, updated: "2026-10-23", updated_by: "owner", name: slug, folders: [], in_scope: [], out_of_scope: [], ...extra }, `${slug} room\n`));
}

// A new TwoKey on a fake host, for what the orchestrator hides (quota, capacity)
test("second agent: quota and capacity are read from the host", async () => {
  const c = hub();
  answer(c, "codex", EMAIL_B); answer(c, "hermes", EMAIL_B);
  const seen: string[] = [];
  const host = (limited: string[]) => new TwoKey({
    store: c.store, approvals: c.approvals, readyAgents: async () => c.store.listAgents(),
    call: async (a) => { seen.push(a.id); return { ok: true, text: JSON.stringify(EMAIL_B), durationMs: 1 }; },
    quotaLimited: (aid) => limited.includes(aid),
  });
  const g = { agentId: "claude", roomId: c.room.id };
  const proceed = async () => ({ id: "x", agentId: "claude", tool: "gmail", action: "a", detail: "d", status: "approved" as const, createdAt: 1 });
  await host(["codex"]).gate(g, "gmail", SEND, JSON.stringify(EMAIL), EMAIL, proceed);
  assert.deepEqual(seen, ["hermes"], "codex is out of quota");
});
