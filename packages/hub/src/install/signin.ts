// 1.7 In-app CLI sign-in. The hub runs the CLI's own login command headless (no Terminal), reads the sign-in link or
// one-time code from its output, hands that to the app, and notices when the CLI says it is signed in.
//   Claude Code: `claude auth login`   (browser OAuth; `claude auth status` exits 0 when signed in)
//                https://code.claude.com/docs/en/cli-usage  https://code.claude.com/docs/en/authentication
//   Codex:       `codex login`  (browser OAuth, local callback on port 1455) or `codex login --device-auth` (one-time code)
//                `codex login status` shows the account.  https://developers.openai.com/codex/auth
// A CLI that insists on a terminal is retried once inside macOS's own `script -q /dev/null` pseudo-terminal (no native modules).
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, SignInState, SignInView } from "@agent-room/shared";
import { adapters } from "../adapters/index.js";
import { runProc, which as whichBin } from "../adapters/proc.js";
import { installCli, type CliInstaller } from "./cliInstall.js";
import { callbackPortBusy, needsTty, parseSignIn, redactSignIn, stripAnsi } from "./parse.js";

/** A running login command, reduced to what the manager needs (tests supply a scripted one). */
export interface LoginProc {
  onOutput(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  write(s: string): void;
  kill(): void;
}
export type StartProc = (cmd: string, args: string[]) => LoginProc;

export const spawnLogin: StartProc = (cmd, args) => {
  const outs: ((c: string) => void)[] = []; const exits: ((c: number | null) => void)[] = [];
  let exited = false;
  const exit = (code: number | null) => { if (!exited) { exited = true; exits.forEach((f) => f(code)); } };
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", TERM: "dumb" } });
  for (const s of [child.stdout, child.stderr]) s.on("data", (d: Buffer) => outs.forEach((f) => f(d.toString())));
  child.stdin.on("error", () => undefined);
  child.on("error", (e) => { outs.forEach((f) => f(String(e))); exit(-1); });
  child.on("close", (code) => exit(code));
  return {
    onOutput: (cb) => { outs.push(cb); },
    onExit: (cb) => { exits.push(cb); },
    write: (s) => { child.stdin.write(s); },
    kill: () => { child.kill("SIGTERM"); },
  };
};

export interface SignInDeps {
  start?: StartProc;
  which?: (bin: string) => Promise<string | null>;
  install?: CliInstaller;
  /** true signed in, false not, undefined can't tell. */
  signedIn?: (agent: AgentConfig) => Promise<boolean | undefined>;
  /** Where signin-<agent>.log goes (the app's "Log" button reads it). Omit to write no log. */
  logDir?: string;
  pollMs?: number;
  /** How long one sign-in may take before it is given up. Device codes last 15 minutes. */
  timeoutMs?: number;
  ptyBin?: string;
  /** Called with (action, detail) for the audit log; never with links or codes. */
  audit?: (action: string, detail: string) => void;
  /** Called when a flow ends signed in, so the hub can drop its cached agent status. */
  onDone?: (agent: AgentConfig) => void;
}

const SPEC: Record<string, { bin: (a: AgentConfig) => string; args: (mode: "browser" | "device") => string[] }> = {
  "claude-code": { bin: () => "claude", args: () => ["auth", "login"] },
  codex: { bin: (a) => (a.settings as { binary?: string }).binary || "codex", args: (m) => (m === "device" ? ["login", "--device-auth"] : ["login"]) },
};
export const canSignIn = (adapter: string) => adapter in SPEC;

export async function defaultSignedIn(agent: AgentConfig): Promise<boolean | undefined> {
  if (agent.adapter === "codex") {
    const s = await adapters.codex.status(agent);
    return s.state === "ready" ? true : s.state === "signed_out" ? false : undefined;
  }
  if (agent.adapter === "claude-code") {
    const r = await runProc("claude", ["auth", "status"], { timeoutMs: 8000, keepEnv: /^(ANTHROPIC|CLAUDE)_/ });
    if (r.code === 0) return true;
    if (r.code === null || r.code < 0 || /unknown command|did you mean|unknown option|ENOENT/i.test(`${r.stdout}${r.stderr}`)) return undefined;
    return false;
  }
  return undefined;
}

interface Flow {
  agent: AgentConfig; mode: "browser" | "device"; force: boolean;
  view: SignInView; out: string; proc?: LoginProc;
  poll?: NodeJS.Timeout; limit?: NodeJS.Timeout;
  usedPty: boolean; switchedToDevice: boolean; closed: boolean; checking: boolean;
}
const ACTIVE: SignInState[] = ["installing", "starting", "waiting"];
const CODE_OK = /^[A-Za-z0-9_#.~%+/=-]{6,1024}$/;

export class SignInManager {
  private flows = new Map<string, Flow>();
  constructor(private deps: SignInDeps = {}) {}

  view(agentId: string): SignInView {
    const f = this.flows.get(agentId);
    return f ? { ...f.view } : { agent: agentId, state: "idle", message: "", updatedAt: Date.now() };
  }

  /** Starts a sign-in and returns at once; the app polls view(). A flow already running is returned as it is. */
  async start(agent: AgentConfig, o: { mode?: "browser" | "device"; force?: boolean } = {}): Promise<SignInView> {
    const cur = this.flows.get(agent.id);
    if (cur && ACTIVE.includes(cur.view.state)) return { ...cur.view };
    const f: Flow = {
      agent, mode: o.mode ?? "browser", force: !!o.force, out: "", usedPty: false, switchedToDevice: false, closed: false, checking: false,
      view: { agent: agent.id, state: "starting", message: "Starting sign-in…", updatedAt: Date.now() },
    };
    if (!canSignIn(agent.adapter)) { f.view = { ...f.view, state: "failed", message: "This agent doesn't have a sign-in step." }; this.flows.set(agent.id, f); return { ...f.view }; }
    this.flows.set(agent.id, f);
    this.deps.audit?.("setup.signin.start", `${agent.id} ${f.mode}${f.force ? " (again)" : ""}`);
    void this.run(f).catch((e) => this.fail(f, `Couldn't start sign-in: ${(e as Error).message}`));
    return { ...f.view };
  }

  /** Claude Code sometimes asks for a code pasted back. The code goes straight to the CLI and is never stored or logged. */
  submitCode(agentId: string, code: string): boolean {
    const f = this.flows.get(agentId);
    if (!f?.proc || f.closed || !CODE_OK.test(code.trim())) return false;
    f.proc.write(`${code.trim()}\n`);
    f.out = ""; // so the old "paste a code" prompt isn't read again
    this.set(f, "waiting", "Checking the code…", { needsPaste: false });
    return true;
  }

  cancel(agentId: string): SignInView {
    const f = this.flows.get(agentId);
    if (f && ACTIVE.includes(f.view.state)) { this.end(f); f.proc?.kill(); this.set(f, "cancelled", "Sign-in cancelled."); }
    return this.view(agentId);
  }

  // ---------- internals
  private set(f: Flow, state: SignInState, message: string, extra: Partial<SignInView> = {}) {
    f.view = { ...f.view, ...extra, state, message, updatedAt: Date.now() };
  }
  private end(f: Flow) { f.closed = true; clearInterval(f.poll); clearTimeout(f.limit); }
  private fail(f: Flow, message: string) {
    if (f.closed) return;
    this.end(f); f.proc?.kill();
    this.set(f, "failed", message);
    this.deps.audit?.("setup.signin.failed", f.agent.id);
  }
  private log(f: Flow, text: string) {
    if (!this.deps.logDir || !text.trim()) return;
    try {
      mkdirSync(this.deps.logDir, { recursive: true });
      appendFileSync(join(this.deps.logDir, `signin-${f.agent.adapter === "claude-code" ? "claude" : f.agent.adapter}.log`), `${redactSignIn(text).trimEnd()}\n`);
    } catch { /* the log is a convenience */ }
  }
  private signedIn(f: Flow) { return (this.deps.signedIn ?? defaultSignedIn)(f.agent).catch(() => undefined); }

  private describe(f: Flow): string {
    const v = f.view;
    if (f.mode === "device") return v.code ? "Open the sign-in page and type this code." : "Getting your sign-in code…";
    if (v.needsPaste) return "If your browser shows a code instead of finishing, paste it here.";
    return v.url ? "Finish signing in in your browser. This page updates when you're done." : "A sign-in page should open in your browser. If it doesn't, use Sign in with Terminal.";
  }

  private async run(f: Flow) {
    const spec = SPEC[f.agent.adapter];
    const bin = spec.bin(f.agent);
    const find = this.deps.which ?? whichBin;
    let path = await find(bin);
    if (!path) {
      this.set(f, "installing", `Installing ${f.agent.adapter === "codex" ? "Codex" : "Claude Code"}… this takes under a minute.`);
      const r = await (this.deps.install ?? installCli)(f.agent.adapter);
      this.log(f, r.output);
      if (f.closed) return;
      path = r.ok ? await find(bin) : null;
      if (!path) return this.fail(f, "Couldn't install it automatically. Use Sign in with Terminal, or open the log.");
    }
    if (!f.force && (await this.signedIn(f)) === true) {
      this.end(f); this.set(f, "done", "Already signed in."); this.deps.onDone?.(f.agent); return;
    }
    f.limit = setTimeout(() => this.fail(f, "Timed out waiting for sign-in. Try again."), this.deps.timeoutMs ?? 10 * 60_000);
    f.limit.unref?.();
    this.launch(f, path);
  }

  private launch(f: Flow, path: string) {
    const args = SPEC[f.agent.adapter].args(f.mode);
    const [cmd, argv] = f.usedPty ? [this.deps.ptyBin ?? "/usr/bin/script", ["-q", "/dev/null", path, ...args]] : [path, args];
    f.out = "";
    delete f.view.url; delete f.view.code;
    f.view = { ...f.view, method: f.mode, needsPaste: false };
    this.set(f, "waiting", this.describe(f));
    const proc = (this.deps.start ?? spawnLogin)(cmd, argv);
    f.proc = proc;
    proc.onOutput((chunk) => {
      if (f.proc !== proc || f.closed) return;
      this.log(f, chunk);
      f.out = (f.out + chunk).slice(-16_000);
      const p = parseSignIn(f.agent.adapter, f.out);
      const change: Partial<SignInView> = {};
      if (p.url && p.url !== f.view.url) change.url = p.url;
      if (f.mode === "device" && p.code && p.code !== f.view.code) change.code = p.code;
      if (p.needsPaste !== !!f.view.needsPaste) change.needsPaste = p.needsPaste;
      if (Object.keys(change).length) { Object.assign(f.view, change); this.set(f, "waiting", this.describe(f)); }
    });
    proc.onExit((code) => { void this.exited(f, proc, path, code).catch((e) => this.fail(f, String((e as Error).message))); });
    clearInterval(f.poll);
    if (!f.force) {
      f.poll = setInterval(() => {
        if (f.closed || f.checking) return;
        f.checking = true;
        void this.signedIn(f).then((ok) => { if (ok === true && !f.closed) this.done(f); }).finally(() => { f.checking = false; });
      }, this.deps.pollMs ?? 2000);
      f.poll.unref?.();
    }
  }

  private async exited(f: Flow, proc: LoginProc, path: string, code: number | null) {
    if (f.proc !== proc || f.closed) return;
    const out = f.out;
    if (code !== 0 && !f.usedPty && needsTty(out)) { f.usedPty = true; this.log(f, "That needs a terminal; retrying inside a pseudo-terminal."); return this.launch(f, path); }
    if (code !== 0 && f.mode === "browser" && f.agent.adapter === "codex" && !f.switchedToDevice && callbackPortBusy(out)) {
      f.mode = "device"; f.switchedToDevice = true; this.log(f, "Browser sign-in port is busy; switching to a one-time code.");
      return this.launch(f, path);
    }
    const ok = await this.signedIn(f);
    if (f.closed) return;
    if (ok === true || (ok === undefined && code === 0)) return this.done(f);
    const last = stripAnsi(out).split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
    this.fail(f, code === 0 ? "The sign-in finished, but you're still signed out. Try again." : `Sign-in didn't finish${last ? `: ${redactSignIn(last).slice(0, 160)}` : "."}`);
  }

  private done(f: Flow) {
    if (f.closed) return;
    this.end(f);
    this.set(f, "done", "Signed in.", { needsPaste: false });
    this.deps.audit?.("setup.signin.done", f.agent.id);
    this.deps.onDone?.(f.agent);
    const proc = f.proc; // the CLI usually exits by itself a moment later; make sure it does
    if (proc) setTimeout(() => proc.kill(), 5000).unref?.();
  }
}
