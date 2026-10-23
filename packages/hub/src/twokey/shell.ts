import { basename } from "node:path";

/**
 * 4.1 Does this shell command delete anything? Parsed conservatively: a command that deletes is found through quotes, `&&`, `;`, pipes, `$( )`,
 * backticks, `sh -c '...'`, `eval`, `sudo`/`env`/`xargs`/`find -exec` wrappers; and a command that cannot be read with confidence (an unbalanced quote,
 * a program name that is computed, a pipe into a bare shell, `eval` of a computed string) is reported as `unsure`, which callers treat as a delete.
 *
 * Unsure, and so a delete: text piped, here-string'd, here-doc'd or process-substituted into a shell or an interpreter (python, node, ruby, perl, php,
 * osascript, pwsh, deno, bun...), and any inline code given to an interpreter (-c, -e, -Command, eval...): code is never matched against a denylist.
 * Also read as deletes: `mv` (anywhere: it removes the source and can overwrite the target), a redirect that truncates a file with nothing written
 * (`: > f`, `> f`), `cp /dev/null f`, `dd of=`, `truncate`, `shred`, `find -delete`, `aws s3 rm`/`sync --delete`, `rsync --delete`, `gsutil rm`.
 *
 * Not caught on purpose: editors (`sed -i`) and a command that writes output over a file (`echo hi > f`); a script file run by name (`./clean.sh`) is not opened.
 */
export interface ShellDelete {
  /** The program that deletes (rm, git clean, find -delete...). */
  program: string;
  /** What it names, as written. Empty when the command doesn't say (git clean, find with a pattern, xargs). */
  targets: string[];
  /** The command deletes things it does not list (a glob, a variable, find -delete, git clean): the targets above are not the whole story. */
  opaque: boolean;
}
export interface ShellScan { deletes: ShellDelete[]; unsure: string[] }

interface Word { text: string; dynamic: boolean; /** Was written with a quote or a backslash. */ quoted?: boolean; /** A process substitution: <(...) or >(...). */ proc?: boolean }
/** A redirect: its operator (`>`, `>>`, `<`, `<<`, `<<<`...) and the word it names (a file, a here-string, a here-doc's delimiter). */
interface Redir { op: string; target?: Word }
interface Cmd { words: Word[]; piped: boolean; redirs: Redir[] }
/** The command reads its standard input from a pipe, a file, a here-string, a here-doc or a process substitution. */
const readsStdin = (c: Cmd) => c.piped || c.redirs.some((r) => ["<", "<<", "<<-", "<<<", "<>"].includes(r.op)) || c.words.some((w) => w.proc && w.text.startsWith("<"));

const MAX_DEPTH = 4;
const MAX_LEN = 20_000;

/** Programs whose job is deleting. */
export const DELETE_PROGRAMS = new Set(["rm", "rmdir", "unlink", "shred", "srm", "wipe", "trash", "trash-put", "rimraf", "del-cli", "del", "erase", "rd", "remove-item", "ri"]);
/** Programs that run the program after them. Every later word is checked as a program, so `timeout 5 rm x` and `sudo -u me rm x` are found. */
const WRAPPERS = new Set(["sudo", "doas", "env", "nice", "nohup", "time", "timeout", "command", "exec", "builtin", "stdbuf", "ionice", "setsid", "xargs", "watch", "chronic", "parallel", "busybox", "then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "caffeinate", "unbuffer", "npx", "bunx", "dlx", "pnpx", "xvfb-run", "flock", "strace", "ltrace", "doppler", "dotenv", "op", "chroot", "su", "runuser", "script"]);
/** Wrappers that take a whole command line as one word after a flag. */
const STRING_FLAGS: Record<string, RegExp> = { su: /^(-c|--command)$/, runuser: /^(-c|--command)$/, script: /^(-c|--command)$/, env: /^(-S|--split-string)$/ };
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "csh", "tcsh", "rbash"]);
/** Programs that run code they are given: inline (-c, -e...), from standard input, or from a file. Inline code and code on stdin are never read, only reported. */
const CODE_FLAGS: Record<string, RegExp> = {
  python: /^-[A-Za-z]*c[A-Za-z]*$/, pypy: /^-[A-Za-z]*c[A-Za-z]*$/, ipython: /^-[A-Za-z]*c[A-Za-z]*$/,
  node: /^(-[A-Za-z]*[ep][A-Za-z]*|--eval(=.*)?|--print(=.*)?)$/, nodejs: /^(-[A-Za-z]*[ep][A-Za-z]*|--eval(=.*)?|--print(=.*)?)$/,
  deno: /^(-[A-Za-z]*e[A-Za-z]*|--eval(=.*)?)$/, bun: /^(-[A-Za-z]*[ep][A-Za-z]*|--eval(=.*)?|--print(=.*)?)$/, tsx: /^(-[A-Za-z]*[ep][A-Za-z]*|--eval(=.*)?|--print(=.*)?)$/, "ts-node": /^(-[A-Za-z]*[ep][A-Za-z]*|--eval(=.*)?|--print(=.*)?)$/,
  perl: /^-[A-Za-z]*[eE][A-Za-z]*$/, ruby: /^-[A-Za-z]*e[A-Za-z]*$/, irb: /^-[A-Za-z]*e[A-Za-z]*$/, php: /^-[A-Za-z]*[rRBE][A-Za-z]*$/,
  pwsh: /^[-/](c|command|commandwithargs|cwa|e|ec|enc|encodedcommand|encodedarguments|ea)$/i, powershell: /^[-/](c|command|commandwithargs|cwa|e|ec|enc|encodedcommand|encodedarguments|ea)$/i,
  osascript: /^-[A-Za-z]*e[A-Za-z]*$/, lua: /^-[A-Za-z]*e[A-Za-z]*$/, luajit: /^-[A-Za-z]*e[A-Za-z]*$/, tclsh: /(?!)/, rscript: /^-[A-Za-z]*e[A-Za-z]*$/,
  julia: /^(-[A-Za-z]*[eE][A-Za-z]*|--eval(=.*)?|--print(=.*)?)$/, groovy: /^-[A-Za-z]*e[A-Za-z]*$/, jshell: /(?!)/,
};
/** `deno eval`, `bun repl`: a word that makes the program run code it was handed. */
const CODE_SUBCOMMANDS: Record<string, RegExp> = { deno: /^(eval|repl)$/, bun: /^(eval|repl)$/ };
/** `python3.11` is python, `ruby3.2` is ruby. */
const interpreterOf = (base: string): string | undefined => { const n = base.replace(/[0-9.]+$/, ""); return Object.hasOwn(CODE_FLAGS, n) ? n : undefined; };
const ASKS_ONLY = /^(-[vVhH]|--version|-version|--help|-help|-\?)$/;
/** Inline code that deletes, for awk (whose program is the first word that is not a flag). */
const INLINE_DELETE = /\b(unlink|unlinkSync|rmSync|rmdirSync|rmtree|rmdir|os\.remove|os\.unlink|os\.removedirs|fs\.rm|fs\.rmdir|fs\.unlink|File\.delete|FileUtils\.(rm|remove)\w*|rm_rf|Remove-Item|remove_tree|trash|deleteRecursively|\.unlink\(|\.rmdir\(|system\s*\(\s*["']rm)\b/i;
/** Command-line tools whose delete verbs delete things outside the file system. A word after the program that matches is a delete. */
const INFRA: Record<string, RegExp> = {
  kubectl: /^(delete|drain)$/, helm: /^(delete|uninstall)$/, terraform: /^(destroy)$/, tofu: /^(destroy)$/, pulumi: /^(destroy)$/,
  docker: /^(rm|rmi|prune|kill)$/, podman: /^(rm|rmi|prune|kill)$/, aws: /^(rm|mv|rb|delete-.*|terminate-.*|remove-.*|deregister-.*)$/, gcloud: /^(delete|destroy|rm|mv|remove-.*)$/,
  gsutil: /^(rm|mv)$/, az: /^(delete)$/, heroku: /^(destroy)$/, fly: /^(destroy)$/, flyctl: /^(destroy)$/, gh: /^(delete)$/, glab: /^(delete)$/,
  doctl: /^(delete)$/, vercel: /^(rm|remove)$/, netlify: /^(delete)$/, supabase: /^(delete)$/, rclone: /^(delete|deletefile|purge|rmdirs|rmdir|sync|move|moveto)$/, npm: /^(unpublish|deprecate)$/,
};
/** Flags that make a sync delete what the other side lacks. */
const SYNC_DELETE: Record<string, RegExp> = { aws: /^--delete(-.*)?$/, gcloud: /^--delete.*$/, rclone: /^--delete.*$/ };
/** git settings that run a program when they are set on the command line. */
const GIT_RUNS = /^(alias\.|core\.(pager|editor|sshcommand|fsmonitor|hookspath|askpass)|credential\.|diff\.external|filter\.|pager\.|sequence\.editor|gpg\.program|merge\.tool|mergetool\.|difftool\.)/i;
/** git global options that take the next word as their value. */
const GIT_VALUE = /^(-C|-c|--work-tree|--git-dir|--namespace|--super-prefix|--config-env|--attr-source)$/;
const GIT_KNOWN = new Set(("add am apply archive bisect blame branch bundle cat-file check-ignore checkout cherry cherry-pick clean clone commit commit-tree config count-objects describe diff diff-tree difftool fetch filter-branch format-patch fsck gc " +
  "grep hash-object help init lfs log ls-files ls-remote ls-tree maintenance merge merge-base mergetool mv name-rev notes pull push range-diff read-tree rebase reflog remote repack replace request-pull reset restore " +
  "rev-list rev-parse revert rm shortlog show show-branch show-ref sparse-checkout stash status submodule switch symbolic-ref tag update-index update-ref var version whatchanged worktree write-tree prune").split(" "));

const isFlag = (w: string) => w.startsWith("-") && w.length > 1;

/** Find the `)` that closes the `(` at `open`, or -1. */
function matchParen(src: string, open: number): number {
  let depth = 0, q = "";
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = ""; continue; }
    if (c === "\\") { i++; continue; }
    if (c === "'" || c === '"') q = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

function lex(src: string, depth: number, scan: ShellScan): Cmd[] {
  const cmds: Cmd[] = [];
  let words: Word[] = [], redirs: Redir[] = [], cur = "", has = false, dyn = false, quoted = false, piped = false;
  /** A redirect operator was read and its word has not been: the next word is its target, not an argument. */
  let pending: string | undefined;
  /** Here-docs whose bodies start after the next newline. */
  const heredocs: { delim: string; quoted: boolean; strip: boolean }[] = [];
  const endWord = () => {
    if (has) {
      const w: Word = { text: cur, dynamic: dyn, ...(quoted ? { quoted: true } : {}) };
      if (pending !== undefined) {
        const op = pending; pending = undefined;
        if ((op === ">&" || op === "<&") && /^(\d+-?|-)$/.test(cur)) { /* 2>&1: a copy of a descriptor, not a file */ }
        else {
          redirs.push({ op: op === ">&" ? ">" : op === "<&" ? "<" : op, target: w });
          if (op === "<<" || op === "<<-") heredocs.push({ delim: cur, quoted, strip: op === "<<-" });
        }
      } else words.push(w);
    }
    cur = ""; has = false; dyn = false; quoted = false;
  };
  const endCmd = (pipe: boolean) => { endWord(); pending = undefined; if (words.length || redirs.length) cmds.push({ words, piped, redirs }); words = []; redirs = []; piped = pipe; };
  const sub = (inner: string) => { void scanInto(inner, depth + 1, scan); };
  /** The body of a here-doc whose delimiter was not quoted still runs `$( )` and backticks. */
  const heredocBody = (body: string) => {
    for (let j = 0; j < body.length; j++) {
      if (body[j] === "\\") { j++; continue; }
      if (body[j] === "$" && body[j + 1] === "(") { const end = matchParen(body, j + 1); if (end < 0) { scan.unsure.push("an unclosed $( )"); return; } sub(body.slice(j + 2, end)); j = end; }
      else if (body[j] === "`") { const end = body.indexOf("`", j + 1); if (end < 0) { scan.unsure.push("an unclosed backtick"); return; } sub(body.slice(j + 1, end)); j = end; }
    }
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { if (src[i + 1] === "\n") { i++; continue; } if (i + 1 < src.length) { cur += src[i + 1]; has = true; quoted = true; i++; } continue; }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) { scan.unsure.push("an unbalanced quote"); break; }
      cur += src.slice(i + 1, j); has = true; quoted = true; i = j; continue;
    }
    if (c === '"') {
      let j = i + 1, closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '"') { closed = true; break; }
        if (d === "\\") { cur += src[j + 1] ?? ""; j += 2; continue; }
        if (d === "$" && src[j + 1] === "(") {
          const end = matchParen(src, j + 1);
          if (end < 0) { scan.unsure.push("an unclosed $( )"); j = src.length; break; }
          sub(src.slice(j + 2, end)); cur += "$(...)"; dyn = true; j = end + 1; continue;
        }
        if (d === "`") {
          const end = src.indexOf("`", j + 1);
          if (end < 0) { scan.unsure.push("an unclosed backtick"); j = src.length; break; }
          sub(src.slice(j + 1, end)); cur += "`...`"; dyn = true; j = end + 1; continue;
        }
        if (d === "$" && /[A-Za-z_{]/.test(src[j + 1] ?? "")) dyn = true;
        cur += d; j++;
      }
      if (!closed) { if (!scan.unsure.length) scan.unsure.push("an unbalanced quote"); break; }
      has = true; quoted = true; i = j; continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      const end = matchParen(src, i + 1);
      if (end < 0) { scan.unsure.push("an unclosed $( )"); break; }
      sub(src.slice(i + 2, end)); cur += "$(...)"; dyn = true; has = true; i = end; continue;
    }
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end < 0) { scan.unsure.push("an unclosed backtick"); break; }
      sub(src.slice(i + 1, end)); cur += "`...`"; dyn = true; has = true; i = end; continue;
    }
    if (c === "$") { dyn = true; cur += c; has = true; continue; }
    if (c === "\n") {
      endCmd(false);
      // the bodies of the here-docs this line opened start on the next line and end at a line that is only the delimiter
      let at = i + 1;
      for (const h of heredocs.splice(0)) {
        let body = "";
        while (at < src.length) {
          let eol = src.indexOf("\n", at); if (eol < 0) eol = src.length;
          const line = src.slice(at, eol).replace(/\r$/, "");
          at = eol + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          body += `${line}\n`;
        }
        if (!h.quoted) heredocBody(body);
      }
      i = Math.max(i, Math.min(src.length, at) - 1);
      continue;
    }
    if (c === ";") { endCmd(false); continue; }
    if (c === " " || c === "\t" || c === "\r") { endWord(); continue; }
    if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
      // a redirect. A descriptor right before it (`2>`) belongs to it, not to the command.
      if (has && !/^\d+$/.test(cur)) endWord(); else if (has) { cur = ""; has = false; dyn = false; quoted = false; }
      if ((c === "<" || c === ">") && src[i + 1] === "(") { // process substitution: <(cmd) hands the command's output to this one as a file
        const end = matchParen(src, i + 1);
        if (end < 0) { scan.unsure.push("an unclosed process substitution"); break; }
        sub(src.slice(i + 2, end));
        endWord();
        words.push({ text: `${c}(...)`, dynamic: true, proc: true });
        i = end; continue;
      }
      const three = src.slice(i, i + 3);
      let op: string;
      if (c === "&") op = three === "&>>" ? "&>>" : "&>";
      else if (c === "<") op = three === "<<<" ? "<<<" : three === "<<-" ? "<<-" : src[i + 1] === "<" ? "<<" : src[i + 1] === "&" ? "<&" : src[i + 1] === ">" ? "<>" : "<";
      else op = src[i + 1] === ">" ? ">>" : src[i + 1] === "|" ? ">|" : src[i + 1] === "&" ? ">&" : ">";
      endWord();
      pending = op === "&>" || op === "&>>" ? op.slice(1) : op;
      i += op.length - 1;
      continue;
    }
    if (c === "&") { if (src[i + 1] === "&") i++; endCmd(false); continue; }
    if (c === "|") { const dbl = src[i + 1] === "|"; if (dbl || src[i + 1] === "&") i++; endCmd(!dbl); continue; }
    if (c === "(" || c === ")") { endCmd(false); continue; }
    if (c === "#" && !has) { while (i < src.length && src[i] !== "\n") i++; i--; continue; }
    cur += c; has = true;
  }
  endCmd(false);
  return cmds;
}

const progName = (w: string) => basename(w.replace(/^\\/, "")).toLowerCase();
const targetsOf = (args: Word[]): { targets: string[]; opaque: boolean } => {
  const targets: string[] = []; let opaque = false, rest = false;
  for (const a of args) {
    if (!rest && a.text === "--") { rest = true; continue; }
    if (!rest && isFlag(a.text)) continue;
    targets.push(a.text);
    if (a.dynamic || /[*?[]/.test(a.text)) opaque = true;
  }
  if (!targets.length) opaque = true;
  return { targets, opaque };
};

/** A command that writes nothing, so a `>` after it only empties the file. */
function writesNothing(words: Word[]): boolean {
  if (!words.length) return true;
  const b = progName(words[0].text), args = words.slice(1);
  if (b === ":" || b === "true" || b === "false") return true;
  if (b === "echo") return args.every((a) => a.text === "" || /^-[neE]+$/.test(a.text));
  if (b === "printf") return args.every((a) => a.text === "");
  if (b === "cat") return args.length > 0 && args.every((a) => a.text === "/dev/null");
  return false;
}
const NOT_A_FILE = /^\/dev\/(null|stdout|stderr|tty|zero|full|fd\/\d+)$/;

function inspect(cmd: Cmd, depth: number, scan: ShellScan) {
  let i = 0;
  while (i < cmd.words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd.words[i].text)) i++;
  const words = cmd.words.slice(i);
  const del = (program: string, targets: string[], opaque: boolean) => { scan.deletes.push({ program, targets, opaque }); };

  // `: > f`, `> f`: nothing is written, so the file is emptied
  if (writesNothing(words)) {
    for (const r of cmd.redirs) if ((r.op === ">" || r.op === ">|") && r.target && !NOT_A_FILE.test(r.target.text)) del("> (empties the file)", [r.target.text], !!r.target.dynamic || /[*?[]/.test(r.target.text));
  }
  if (!words.length) return;
  const prog = words[0], args = words.slice(1);
  if (prog.dynamic) { scan.unsure.push("a command name is computed"); return; }
  if (/[*?]/.test(prog.text) || (prog.text.length > 1 && prog.text !== "[[" && prog.text.includes("["))) { scan.unsure.push("a command name is a pattern"); return; }
  const base = progName(prog.text);
  const stdin = readsStdin(cmd);
  const inner = (ws: Word[], redirs = cmd.redirs) => inspect({ words: ws, piped: cmd.piped, redirs }, depth, scan);

  const sf = STRING_FLAGS[base];
  if (sf) {
    const k = args.findIndex((a) => sf.test(a.text));
    if (k >= 0 && args[k + 1]) { if (args[k + 1].dynamic) scan.unsure.push("a command line is computed"); else void scanInto(args[k + 1].text, depth + 1, scan); }
  }
  if (base === "watch") { const line = args.filter((a) => !isFlag(a.text)); if (line.length === 1 && !line[0].dynamic) void scanInto(line[0].text, depth + 1, scan); }
  if (WRAPPERS.has(base)) {
    for (let k = 1; k < words.length; k++) inner(words.slice(k));
    return;
  }
  if (base === "source" || base === ".") {
    if (stdin || args.some((a) => a.proc)) scan.unsure.push("a script made on the fly is run in this shell");
    return;
  }
  if (SHELLS.has(base)) {
    if (args.some((a) => a.proc)) { scan.unsure.push("a shell is given a script made on the fly"); return; }
    const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a.text));
    if (ci >= 0) {
      const script = args[ci + 1];
      if (!script) return;
      if (script.dynamic) { scan.unsure.push("a shell is given a computed command"); return; }
      void scanInto(script.text, depth + 1, scan);
    } else if (stdin || !args.some((a) => !isFlag(a.text))) scan.unsure.push("text is piped or redirected into a shell");
    return;
  }
  if (base === "eval") {
    if (args.some((a) => a.dynamic)) scan.unsure.push("eval of a computed string");
    else if (args.length) void scanInto(args.map((a) => a.text).join(" "), depth + 1, scan);
    return;
  }
  const interp = interpreterOf(base);
  if (interp) {
    // Code handed to an interpreter is not read. Inline code, code on standard input and code made on the fly are all unsure.
    const flags = CODE_FLAGS[interp], upto = args.findIndex((a) => a.text === "--"), own = upto < 0 ? args : args.slice(0, upto);
    if (own.some((a) => ASKS_ONLY.test(a.text)) && !own.some((a) => flags.test(a.text))) return;
    if (own.some((a) => flags.test(a.text))) scan.unsure.push(`${base} is given code to run (inline)`);
    else if (CODE_SUBCOMMANDS[interp] && own.some((a) => !isFlag(a.text) && CODE_SUBCOMMANDS[interp].test(a.text))) scan.unsure.push(`${base} is given code to run`);
    else if (args.some((a) => a.proc)) scan.unsure.push(`${base} is given a script made on the fly`);
    else if (!args.some((a) => !isFlag(a.text)) || (stdin && args.some((a) => a.text === "-"))) scan.unsure.push(`${base} reads its code from standard input`);
    return;
  }
  if (DELETE_PROGRAMS.has(base)) { const t = targetsOf(args); del(base, t.targets, t.opaque); return; }
  if (base === "mv") { del("mv", targetsOf(args).targets, true); return; } // it removes the source and can overwrite the target
  if (base === "truncate") { const t = targetsOf(args.filter((a) => !/^\d+[kmgt]?$/i.test(a.text))); del(base, t.targets, true); return; }
  if (base === "dd") { const o = args.find((a) => a.text.startsWith("of=")); if (o && !NOT_A_FILE.test(o.text.slice(3))) del("dd of=", [o.text.slice(3)], o.dynamic); return; }
  if (base === "cp" && args.some((a) => a.text === "/dev/null")) { const ops = targetsOf(args).targets.filter((t) => t !== "/dev/null"); del("cp /dev/null", ops.slice(-1), ops.length !== 1); return; }
  if (base === "tar" && args.some((a) => a.text === "--remove-files")) { del("tar --remove-files", [], true); return; }
  if (base === "awk" || base === "gawk" || base === "mawk") {
    const prog2 = args.filter((a) => !isFlag(a.text)).map((a) => a.text);
    if (prog2.some((c) => INLINE_DELETE.test(c))) del(`${base} (inline code)`, [], true);
    else if (prog2.some((c) => /\bsystem\s*\(|\|\s*"|\|&/.test(c))) scan.unsure.push(`${base} runs commands`);
    return;
  }
  if (base === "find" || base === "fd") {
    const start = args.findIndex((a) => isFlag(a.text) || a.text === "(" || a.text === "!");
    const roots = (start < 0 ? args : args.slice(0, start)).map((a) => a.text);
    if (args.some((a) => a.text === "-delete" || a.text === "--delete")) del("find -delete", roots, true);
    for (let k = 0; k < args.length; k++) {
      if (/^(-exec|-execdir|-ok|-okdir|-x|--exec|-X|--exec-batch)$/.test(args[k].text)) inspect({ words: args.slice(k + 1), piped: false, redirs: [] }, depth, scan);
    }
    return;
  }
  if (base === "git") {
    let k = 0;
    while (k < args.length && isFlag(args[k].text)) {
      const t = args[k].text;
      if (/^(-c|--config-env)$/.test(t) && GIT_RUNS.test(args[k + 1]?.text ?? "")) scan.unsure.push("git is given a setting that runs a program");
      if (/^--config-env=/.test(t) && GIT_RUNS.test(t.slice(13))) scan.unsure.push("git is given a setting that runs a program");
      // a global option's value is not the subcommand (`--work-tree .`, `--git-dir .git`, `-C dir`, `-c k=v`); `--exec-path` takes one only with `=`, but a word that is no subcommand after it is skipped as well
      k += GIT_VALUE.test(t) || (t === "--exec-path" && args[k + 1] && !GIT_KNOWN.has(args[k + 1].text)) ? 2 : 1;
    }
    const sub = args[k]?.text, rest = args.slice(k + 1), has = (re: RegExp) => rest.some((a) => re.test(a.text));
    if (!sub) return;
    if (!GIT_KNOWN.has(sub)) { scan.unsure.push(`git ${sub.slice(0, 30)} is not a git command the hub knows (it may be an alias)`); return; }
    if (sub === "clean") del("git clean", [], true);
    else if (sub === "rm") { const t = targetsOf(rest); del("git rm", t.targets, t.opaque); }
    else if (sub === "mv") del("git mv", [], true); // a move is a delete of the old path (and an overwrite with -f)
    else if (sub === "branch" && has(/^(-[a-z]*d[a-z]*|--delete)$/i)) del("git branch -d", rest.filter((a) => !isFlag(a.text)).map((a) => `branch:${a.text}`), false);
    else if (sub === "tag" && has(/^(-d|--delete)$/)) del("git tag -d", rest.filter((a) => !isFlag(a.text)).map((a) => `tag:${a.text}`), false);
    else if (sub === "push" && (has(/^(-d|--delete|--prune|--mirror)$/) || rest.some((a) => /^:\S/.test(a.text)))) del("git push --delete", [], true);
    else if (sub === "stash" && /^(drop|clear)$/.test(rest[0]?.text ?? "")) del("git stash drop", [], true);
    else if (sub === "worktree" && /^(remove|prune)$/.test(rest[0]?.text ?? "")) del("git worktree remove", [], true);
    else if (sub === "remote" && /^(remove|rm)$/.test(rest[0]?.text ?? "")) del("git remote remove", [], true);
    return;
  }
  if (base === "rsync") { if (args.some((a) => /^--(delete|remove-source-files|del)\b/.test(a.text))) del("rsync --delete", [], true); return; }
  if (INFRA[base]) {
    if (args.some((a) => !isFlag(a.text) && INFRA[base].test(a.text))) del(base, [], true);
    else if (SYNC_DELETE[base] && args.some((a) => SYNC_DELETE[base].test(a.text))) del(`${base} --delete`, [], true);
    else if (base === "gsutil" && args.some((a) => a.text === "rsync") && args.some((a) => /^-[A-Za-z]*d[A-Za-z]*$/.test(a.text))) del("gsutil rsync -d", [], true);
  }
}

function scanInto(src: string, depth: number, scan: ShellScan): void {
  if (depth > MAX_DEPTH) { scan.unsure.push("commands nested too deeply to read"); return; }
  for (const c of lex(src, depth, scan)) inspect(c, depth, scan);
}

export function scanShell(command: string): ShellScan {
  const scan: ShellScan = { deletes: [], unsure: [] };
  if (command.length > MAX_LEN) { scan.unsure.push("a very long command"); return scan; }
  scanInto(command, 0, scan);
  // The same finding can be seen twice (a wrapper checks every later word): keep each once.
  const seen = new Set<string>();
  scan.deletes = scan.deletes.filter((d) => { const k = `${d.program}|${d.targets.join("\0")}|${d.opaque}`; if (seen.has(k)) return false; seen.add(k); return true; });
  scan.unsure = [...new Set(scan.unsure)];
  return scan;
}
