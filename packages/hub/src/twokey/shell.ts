import { basename } from "node:path";

/**
 * 4.1 Does this shell command delete anything? Parsed conservatively: a command that deletes is found through quotes, `&&`, `;`, pipes, `$( )`,
 * backticks, `sh -c '...'`, `eval`, `sudo`/`env`/`xargs`/`find -exec` wrappers; and a command that cannot be read with confidence (an unbalanced quote,
 * a program name that is computed, a pipe into a bare shell, `eval` of a computed string) is reported as `unsure`, which callers treat as a delete.
 *
 * Not caught on purpose: truncating redirects (`> file`) and editors (`sed -i`); a script file run by name (`./clean.sh`) is not opened.
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

interface Word { text: string; dynamic: boolean }
interface Cmd { words: Word[]; piped: boolean }

const MAX_DEPTH = 4;
const MAX_LEN = 20_000;

/** Programs whose job is deleting. */
export const DELETE_PROGRAMS = new Set(["rm", "rmdir", "unlink", "shred", "srm", "trash", "trash-put", "rimraf", "del-cli", "del", "erase", "rd", "remove-item", "ri"]);
/** Programs that run the program after them. Every later word is checked as a program, so `timeout 5 rm x` and `sudo -u me rm x` are found. */
const WRAPPERS = new Set(["sudo", "doas", "env", "nice", "nohup", "time", "timeout", "command", "exec", "builtin", "stdbuf", "ionice", "setsid", "xargs", "watch", "chronic", "parallel", "busybox", "then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "caffeinate", "unbuffer", "npx", "bunx", "dlx", "pnpx", "xvfb-run", "flock", "strace", "ltrace", "doppler", "dotenv", "op", "chroot", "su"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);
const INTERPRETERS = new Set(["python", "python2", "python3", "node", "nodejs", "deno", "bun", "perl", "ruby", "php", "pwsh", "powershell", "osascript", "lua", "tclsh", "awk", "gawk"]);
/** Inline code that deletes, for `python -c`, `node -e`, `perl -e`, `pwsh -Command`. */
const INLINE_DELETE = /\b(unlink|unlinkSync|rmSync|rmdirSync|rmtree|rmdir|os\.remove|os\.unlink|os\.removedirs|fs\.rm|fs\.rmdir|fs\.unlink|File\.delete|FileUtils\.(rm|remove)\w*|rm_rf|Remove-Item|remove_tree|trash|deleteRecursively|\.unlink\(|\.rmdir\(|system\s*\(\s*["']rm)\b/i;
/** Command-line tools whose delete verbs delete things outside the file system. A word after the program that matches is a delete. */
const INFRA: Record<string, RegExp> = {
  kubectl: /^(delete|drain)$/, helm: /^(delete|uninstall)$/, terraform: /^(destroy)$/, tofu: /^(destroy)$/, pulumi: /^(destroy)$/,
  docker: /^(rm|rmi|prune|kill)$/, podman: /^(rm|rmi|prune|kill)$/, aws: /^(rm|delete-.*|terminate-.*|remove-.*|deregister-.*)$/, gcloud: /^(delete|destroy)$/,
  gsutil: /^(rm)$/, az: /^(delete)$/, heroku: /^(destroy)$/, fly: /^(destroy)$/, flyctl: /^(destroy)$/, gh: /^(delete)$/, glab: /^(delete)$/,
  doctl: /^(delete)$/, vercel: /^(rm|remove)$/, netlify: /^(delete)$/, supabase: /^(delete)$/, rclone: /^(delete|deletefile|purge|rmdirs|rmdir)$/, npm: /^(unpublish|deprecate)$/,
};

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
  let words: Word[] = [], cur = "", has = false, dyn = false, piped = false;
  const endWord = () => { if (has) words.push({ text: cur, dynamic: dyn }); cur = ""; has = false; dyn = false; };
  const endCmd = (pipe: boolean) => { endWord(); if (words.length) cmds.push({ words, piped }); words = []; piped = pipe; };
  const sub = (inner: string) => { void scanInto(inner, depth + 1, scan); };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { if (src[i + 1] === "\n") { i++; continue; } if (i + 1 < src.length) { cur += src[i + 1]; has = true; i++; } continue; }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) { scan.unsure.push("an unbalanced quote"); break; }
      cur += src.slice(i + 1, j); has = true; i = j; continue;
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
      has = true; i = j; continue;
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
    if (c === "\n" || c === ";") { endCmd(false); continue; }
    if (c === " " || c === "\t" || c === "\r") { endWord(); continue; }
    if (c === "&") {
      if (src[i - 1] === ">" || src[i - 1] === "<" || src[i + 1] === ">") { cur += c; has = true; continue; } // 2>&1, &>file
      if (src[i + 1] === "&") i++;
      endCmd(false); continue;
    }
    if (c === "|") { const dbl = src[i + 1] === "|"; if (dbl || src[i + 1] === "&") i++; endCmd(!dbl); continue; }
    if (c === "(" || c === ")") { endCmd(false); continue; }
    if (c === "#" && !has) { while (i < src.length && src[i] !== "\n") i++; continue; }
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

function inspect(words: Word[], piped: boolean, depth: number, scan: ShellScan) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].text)) i++;
  if (i >= words.length) return;
  words = words.slice(i);
  const prog = words[0], args = words.slice(1);
  if (prog.dynamic) { scan.unsure.push("a command name is computed"); return; }
  const base = progName(prog.text);
  const del = (program: string, targets: string[], opaque: boolean) => { scan.deletes.push({ program, targets, opaque }); };

  if (WRAPPERS.has(base)) {
    for (let k = 1; k < words.length; k++) inspect(words.slice(k), piped, depth, scan);
    return;
  }
  if (SHELLS.has(base)) {
    const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a.text));
    if (ci >= 0) {
      const script = args[ci + 1];
      if (!script) return;
      if (script.dynamic) { scan.unsure.push("a shell is given a computed command"); return; }
      void scanInto(script.text, depth + 1, scan);
    } else if (piped || !args.some((a) => !isFlag(a.text))) scan.unsure.push("text is piped into a shell");
    return;
  }
  if (base === "eval") {
    if (args.some((a) => a.dynamic)) scan.unsure.push("eval of a computed string");
    else if (args.length) void scanInto(args.map((a) => a.text).join(" "), depth + 1, scan);
    return;
  }
  if (DELETE_PROGRAMS.has(base)) { const t = targetsOf(args); del(base, t.targets, t.opaque); return; }
  if (base === "truncate") { const t = targetsOf(args.filter((a) => !/^\d+[kmgt]?$/i.test(a.text))); del(base, t.targets, true); return; }
  if (base === "find" || base === "fd") {
    const start = args.findIndex((a) => isFlag(a.text) || a.text === "(" || a.text === "!");
    const roots = (start < 0 ? args : args.slice(0, start)).map((a) => a.text);
    if (args.some((a) => a.text === "-delete" || a.text === "--delete")) del("find -delete", roots, true);
    for (let k = 0; k < args.length; k++) {
      if (/^(-exec|-execdir|-ok|-okdir|-x|--exec|-X|--exec-batch)$/.test(args[k].text)) inspect(args.slice(k + 1), false, depth, scan);
    }
    return;
  }
  if (base === "git") {
    let k = 0;
    while (k < args.length && isFlag(args[k].text)) k += /^-[Cc]$/.test(args[k].text) ? 2 : 1;
    const sub = args[k]?.text, rest = args.slice(k + 1), has = (re: RegExp) => rest.some((a) => re.test(a.text));
    if (!sub) return;
    if (sub === "clean") del("git clean", [], true);
    else if (sub === "rm") { const t = targetsOf(rest); del("git rm", t.targets, t.opaque); }
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
    return;
  }
  if (INTERPRETERS.has(base)) {
    const code = (base === "awk" || base === "gawk" ? args.filter((a) => !isFlag(a.text)) : args.filter((a, k) => !isFlag(a.text) && /^(-[a-z]*[ce]|--eval|-command)$/i.test(args[k - 1]?.text ?? ""))).map((a) => a.text);
    if (code.some((c) => INLINE_DELETE.test(c))) del(`${base} (inline code)`, [], true);
  }
}

function scanInto(src: string, depth: number, scan: ShellScan): void {
  if (depth > MAX_DEPTH) { scan.unsure.push("commands nested too deeply to read"); return; }
  for (const c of lex(src, depth, scan)) inspect(c.words, c.piped, depth, scan);
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
