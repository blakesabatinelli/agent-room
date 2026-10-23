import { basename } from "node:path";

/**
 * 4.1 Does this shell command delete anything, send email or write to a CRM? A HEURISTIC second layer, not a boundary. The boundary for a local agent is
 * the sandbox and the task worktree (1.1); this scanner only decides which commands the owner should see on a card before they run.
 *
 * It reads the other way round from what it first did. A simple command is "deletes nothing" only when its program word is a plain name or path (no
 * whitespace, braces, `$`, backticks, globs) AND everything around it is something the scanner understands. A construct it cannot fully read is
 * `unsure`, which callers treat as a delete: the owner decides. That covers a computed or brace-expanded program name, an environment variable that makes
 * a program run another program (`GIT_EXTERNAL_DIFF=... git diff`, `PATH=`, `NODE_OPTIONS=`...), a git option that runs a command (`rebase -x`,
 * `bisect run`, `submodule foreach`, `fetch --upload-pack`, `-c alias.x=!...`), a wrapper that takes a command string (`sudo -s`, `su`, `flock -c`,
 * `parallel`, `doppler run --command`, `ssh host '...'`), text piped into a program that starts a shell, code on `/dev/stdin`, `python -m <module>`,
 * `trap`, an alias defined in the same command and then used, a script the same command writes and then runs, `at`, `crontab`, `tmux` and the like.
 *
 * A command that deletes is found through quotes, `&&`, `;`, pipes, `$( )`, backticks, `sh -c '...'`, `eval`, `sudo`/`env`/`xargs`/`find -exec` wrappers.
 * Unsure, and so a delete: text piped, here-string'd, here-doc'd or process-substituted into a shell or an interpreter (python, node, ruby, perl, php,
 * osascript, pwsh, deno, bun, expect...), and any inline code given to an interpreter (-c, -e, -Command, eval...): code is never matched against a denylist.
 * Also read as deletes: `mv` (anywhere: it removes the source and can overwrite the target), a redirect that truncates a file with nothing written
 * (`: > f`, `> f`, `: | tee f`), `cp /dev/null f`, `install /dev/null f`, `ln -f`, `dd of=`, `truncate`, `shred`, `find -delete`, `aws s3 rm`/`sync --delete`,
 * `rsync --delete`, `gsutil rm`, and git's ref and history removers (`update-ref -d`, `branch -D`, `tag -d`, `notes remove`, `reflog delete`, `stash drop`...).
 * Sending mail (`mail`, `sendmail`, `curl smtp://`) and CRM writes (`sf data update`, `sfdx force:data:*`) are reported in `sends`.
 *
 * Not caught on purpose: editors (`sed -i`) and a command that writes output over a file (`echo hi > f`); a script file run by name (`./clean.sh`) is not
 * opened unless the same command wrote it; `git reset --hard` and `git checkout -- f` discard work but are not deletes.
 */
export interface ShellDelete {
  /** The program that deletes (rm, git clean, find -delete...). */
  program: string;
  /** What it names, as written. Empty when the command doesn't say (git clean, find with a pattern, xargs). */
  targets: string[];
  /** The command deletes things it does not list (a glob, a variable, find -delete, git clean): the targets above are not the whole story. */
  opaque: boolean;
}
/** A shell command that sends email or writes to a CRM (kind `email` or `crm`). */
export interface ShellSend { kind: "email" | "crm"; program: string }
export interface ShellScan { deletes: ShellDelete[]; unsure: string[]; sends?: ShellSend[] }

interface Word { text: string; dynamic: boolean; /** Was written with a quote or a backslash. */ quoted?: boolean; /** A process substitution: <(...) or >(...). */ proc?: boolean }
/** A redirect: its operator (`>`, `>>`, `<`, `<<`, `<<<`...) and the word it names (a file, a here-string, a here-doc's delimiter). */
interface Redir { op: string; target?: Word }
/** `from`: the command whose output this one reads, when it is piped from one. */
interface Cmd { words: Word[]; piped: boolean; redirs: Redir[]; from?: Cmd }
/** The command reads its standard input from a pipe, a file, a here-string, a here-doc or a process substitution. */
const readsStdin = (c: Cmd) => c.piped || c.redirs.some((r) => ["<", "<<", "<<-", "<<<", "<>"].includes(r.op)) || c.words.some((w) => w.proc && w.text.startsWith("<"));

const MAX_DEPTH = 4;
const MAX_LEN = 20_000;
/** How many commands one scan will look at before it gives up and says unsure (a wrapper checks every later word, so a long line costs a lot). */
const MAX_WORK = 4000;

/** Programs whose job is deleting. */
export const DELETE_PROGRAMS = new Set(["rm", "rmdir", "unlink", "shred", "srm", "wipe", "trash", "trash-put", "rimraf", "del-cli", "del", "erase", "rd", "remove-item", "ri", "atrm"]);
/** Programs that run the program after them. Every later word is checked as a program, so `timeout 5 rm x` and `sudo -u me rm x` are found. */
const WRAPPERS = new Set(["sudo", "doas", "env", "nice", "nohup", "time", "timeout", "command", "exec", "builtin", "stdbuf", "ionice", "setsid", "xargs", "watch", "chronic", "parallel", "busybox", "toybox", "then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "function", "coproc", "caffeinate", "unbuffer", "npx", "bunx", "dlx", "pnpx", "xvfb-run", "flock", "strace", "ltrace", "doppler", "dotenv", "op", "chroot", "su", "runuser", "sg", "script", "entr", "systemd-run", "launchctl", "unshare", "nsenter", "fakeroot", "fakechroot", "firejail", "bwrap", "proot", "taskset", "chrt", "cpulimit", "ts", "valgrind", "perf", "sshpass", "ssh-agent", "aws-vault", "direnv", "mise", "asdf", "uv", "poetry", "pipenv", "pdm", "hatch", "conda", "micromamba", "rye", "bundle", "bundler", "setpriv", "numactl", "faketime", "devbox", "nix-shell", "toolbox", "distrobox"]);
/** Shell grammar words: what follows one is a command of its own. */
const GRAMMAR = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}"]);
/** Wrappers that take a whole command line as one word after a flag (`su -c '...'`, `flock f -c '...'`, `doppler run --command '...'`). */
const STRING_FLAGS: Record<string, RegExp> = {
  su: /^(-c|--command)$/, runuser: /^(-c|--command)$/, script: /^(-c|--command)$/, sg: /^-c$/, env: /^(-S|--split-string)$/,
  flock: /^(-c|--command)$/, doppler: /^--command$/, entr: /^-s$/, "nix-shell": /^(--run|--command)$/,
};
const stringFlagOf = (base: string): RegExp | undefined => (Object.hasOwn(STRING_FLAGS, base) ? STRING_FLAGS[base] : undefined);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "csh", "tcsh", "rbash", "mksh", "busybox-sh"]);
/** Programs that run code they are given: inline (-c, -e...), from standard input, or from a file. Inline code and code on stdin are never read, only reported. */
const CODE_FLAGS: Record<string, RegExp> = {
  python: /^-[A-Za-z]*c[A-Za-z]*$/, pypy: /^-[A-Za-z]*c[A-Za-z]*$/, ipython: /^-[A-Za-z]*c[A-Za-z]*$/,
  node: /^(-[A-Za-z]*[ep][A-Za-z]*|--eval(=.*)?|--print(=.*)?)$/, nodejs: /^(-[A-Za-z]*[ep][A-Za-z]*|--eval(=.*)?|--print(=.*)?)$/,
  deno: /^(-[A-Za-z]*e[A-Za-z]*|--eval(=.*)?)$/, bun: /^(-[A-Za-z]*[ep][A-Za-z]*|--eval(=.*)?|--print(=.*)?)$/, tsx: /^(-[A-Za-z]*[ep][A-Za-z]*|--eval(=.*)?|--print(=.*)?)$/, "ts-node": /^(-[A-Za-z]*[ep][A-Za-z]*|--eval(=.*)?|--print(=.*)?)$/,
  perl: /^-[A-Za-z]*[eE][A-Za-z]*$/, ruby: /^-[A-Za-z]*e[A-Za-z]*$/, irb: /^-[A-Za-z]*e[A-Za-z]*$/, php: /^-[A-Za-z]*[rRBE][A-Za-z]*$/,
  pwsh: /^[-/](c|command|commandwithargs|cwa|e|ec|enc|encodedcommand|encodedarguments|ea)$/i, powershell: /^[-/](c|command|commandwithargs|cwa|e|ec|enc|encodedcommand|encodedarguments|ea)$/i,
  osascript: /^-[A-Za-z]*e[A-Za-z]*$/, lua: /^-[A-Za-z]*e[A-Za-z]*$/, luajit: /^-[A-Za-z]*e[A-Za-z]*$/, tclsh: /(?!)/, rscript: /^-[A-Za-z]*e[A-Za-z]*$/,
  julia: /^(-[A-Za-z]*[eE][A-Za-z]*|--eval(=.*)?|--print(=.*)?)$/, groovy: /^-[A-Za-z]*e[A-Za-z]*$/, jshell: /(?!)/,
  expect: /^-c$/, // an expect script is Tcl: `exec rm` runs a program
};
/** `deno eval`, `bun repl`: a word that makes the program run code it was handed. */
const CODE_SUBCOMMANDS: Record<string, RegExp> = { deno: /^(eval|repl)$/, bun: /^(eval|repl)$/ };
/** `python3.11` is python, `ruby3.2` is ruby. */
const interpreterOf = (base: string): string | undefined => { const n = base.replace(/[0-9.]+$/, ""); return Object.hasOwn(CODE_FLAGS, n) ? n : undefined; };
const ASKS_ONLY = /^(-[vVhH]|--version|-version|--help|-help|-\?)$/;
/** `python -m <module>` runs that module's code. Only modules that take file names and flags, never code, are let through. */
const PYTHON_SAFE_MODULES = /^(pytest|pip|pip3|venv|unittest|json\.tool|http\.server|ensurepip|build|mypy|ruff|black|flake8|isort|pylint|coverage|tox|nox)$/;
/** A file name that stands for standard input. */
const STDIN_FILE = /^(\/dev\/(stdin|fd\/\d+|tty)|\/proc\/(self|thread-self|\d+)\/fd\/\d+)$/;
/** Inline code that deletes, for awk (whose program is the first word that is not a flag). */
const INLINE_DELETE = /\b(unlink|unlinkSync|rmSync|rmdirSync|rmtree|rmdir|os\.remove|os\.unlink|os\.removedirs|fs\.rm|fs\.rmdir|fs\.unlink|File\.delete|FileUtils\.(rm|remove)\w*|rm_rf|Remove-Item|remove_tree|trash|deleteRecursively|\.unlink\(|\.rmdir\(|system\s*\(\s*["']rm)\b/i;
/** Command-line tools whose delete verbs delete things outside the file system. A word after the program that matches is a delete. (Case-insensitive: macOS file systems are, and so are some CLIs.) */
const INFRA_VERBS: Record<string, RegExp> = {
  kubectl: /^(delete|drain)$/, helm: /^(delete|uninstall)$/, terraform: /^(destroy)$/, tofu: /^(destroy)$/, pulumi: /^(destroy)$/,
  docker: /^(rm|rmi|prune|kill)$/, podman: /^(rm|rmi|prune|kill)$/, aws: /^(rm|mv|rb|delete-.*|terminate-.*|remove-.*|deregister-.*)$/, gcloud: /^(delete|destroy|rm|mv|remove-.*)$/,
  gsutil: /^(rm|mv)$/, az: /^(delete)$/, heroku: /^(destroy)$/, fly: /^(destroy)$/, flyctl: /^(destroy)$/, gh: /^(delete)$/, glab: /^(delete)$/,
  doctl: /^(delete)$/, vercel: /^(rm|remove)$/, netlify: /^(delete)$/, supabase: /^(delete)$/, rclone: /^(delete|deletefile|purge|rmdirs|rmdir|sync|move|moveto)$/, npm: /^(unpublish|deprecate)$/,
};
const INFRA = new Map(Object.entries(INFRA_VERBS).map(([k, v]) => [k, new RegExp(v.source, "i")]));
/** Flags that make a sync delete what the other side lacks. */
const SYNC_DELETE = new Map(Object.entries({ aws: /^--delete(-.*)?$/, gcloud: /^--delete.*$/, rclone: /^--delete.*$/ }).map(([k, v]) => [k, new RegExp(v.source, "i")]));
/** git settings that run a program when they are set on the command line. */
const GIT_RUNS = /^(alias\.|core\.(pager|editor|sshcommand|fsmonitor|hookspath|askpass)|credential\.|diff\.external|filter\.|pager\.|sequence\.editor|gpg\.program|merge\.tool|mergetool\.|difftool\.|ssh\.variant|protocol\.ext|uploadpack\.|receive\.|http\.proxy|url\..*\.insteadof)/i;
/** git global options that take the next word as their value. */
const GIT_VALUE = /^(-C|-c|--work-tree|--git-dir|--namespace|--super-prefix|--config-env|--attr-source)$/;
const GIT_KNOWN = new Set(("add am apply archive bisect blame branch bundle cat-file check-ignore checkout cherry cherry-pick clean clone commit commit-tree config count-objects describe diff diff-tree difftool fetch filter-branch format-patch fsck gc " +
  "grep hash-object help init lfs log ls-files ls-remote ls-tree maintenance merge merge-base mergetool mv name-rev notes pull push range-diff read-tree rebase reflog remote repack replace request-pull reset restore " +
  "rev-list rev-parse revert rm shortlog show show-branch show-ref sparse-checkout stash status submodule switch symbolic-ref tag update-index update-ref var version whatchanged worktree write-tree prune send-email").split(" "));

/**
 * Environment variables that make a program run another program, load code or change which program runs. Setting one as a prefix of a command,
 * through `env`, `export`, `declare` and the like, or on its own, is unsure.
 */
const RISKY_ENV = /^(GIT_[A-Z0-9_]*|EDITOR|VISUAL|PAGER|MANPAGER|FCEDIT|SUDO_EDITOR|SUDO_ASKPASS|SSH_ASKPASS|LESSOPEN|LESSCLOSE|BASH_ENV|ENV|PERL5OPT|PERL5LIB|PERLLIB|PYTHONSTARTUP|PYTHONHOME|NODE_OPTIONS|PATH|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|RUBYOPT|RUBYLIB|SHELL|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|IFS|BROWSER|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|CDPATH)$/;
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=/;
/** Builtins whose arguments are assignments. */
const ASSIGN_BUILTINS = new Set(["export", "declare", "typeset", "local", "readonly", "setenv"]);

/** A program word the scanner can read: a plain name or path. Whitespace, braces, quotes with spaces, `$`, backticks and globs are not. */
const PLAIN = /^[A-Za-z0-9_.+@%^:~/-]+$/;
/** Words that are shell syntax, not programs. */
const SYNTAX = new Set(["{", "}", "!", "[[", "]]", "[", "]", "((", "))"]);

/** Programs that send mail. */
const MAIL_PROGRAMS = new Set(["mail", "mailx", "s-nail", "nail", "heirloom-mailx", "sendmail", "mutt", "neomutt", "msmtp", "ssmtp", "swaks", "mpack", "mailsend", "sendemail", "blat", "himalaya", "aerc", "mblaze", "mhsend", "postsuper"]);
/** Programs that start something to run later or somewhere else; what they run is not read. */
const DEFERRED = new Set(["at", "batch", "crontab", "schtasks", "anacron", "tmux", "screen", "zellij", "dtach", "abduco", "byobu", "gdb", "lldb"]);
const DEFERRED_READS = /^(ls|list|list-sessions|list-windows|list-panes|list-clients|has-session|display-message|show|show-options|show-environment|-ls|-list|-l|-v|-V|--version|-version)$/;
/** Programs whose arguments are data or their own subcommands, never a command line: the generic reading of an unknown program's arguments skips them. */
const DATA = new Set(("ls cat grep egrep fgrep zgrep rg ag ack head tail wc sort uniq cut tr diff cmp comm stat file du df pwd cd pushd popd echo printf mkdir touch cp chmod chown chgrp date which whoami id uname hostname basename dirname realpath readlink tree less more bat jq yq test true false : sleep seq yes " +
  "md5sum sha1sum sha256sum shasum cksum b2sum base64 xxd od hexdump strings column fold fmt nl paste join expand unexpand rev tac split csplit tar zip unzip gzip gunzip bzip2 bunzip2 xz unxz zstd zcat curl wget ping dig nslookup host whois git gh glab pnpm npm yarn cargo rustc rustup go gcc clang cc c++ g++ " +
  "make gmake cmake ninja gradle mvn tsc eslint prettier vitest jest mocha playwright cypress pytest pip pip3 pipx man help type whereis info open code sed awk gawk mawk tput clear reset cal uptime ps top htop lsof pgrep kill free printenv set unset shift read wait jobs hash " +
  "docker podman kubectl helm terraform tofu pulumi aws gcloud gsutil az heroku fly flyctl doctl vercel netlify supabase rclone rsync find fd sf sfdx").split(" "));
/** Flags that hand a command line to the program, whatever the program: scanned as shell. */
const EXEC_FLAG = /^(-c|--command|--cmd|--exec|--execute|--shell-command|--run|--rsh|--ssh-command|--proxy-command|--to-command|--use-compress-program|--checkpoint-action|--pager|--editor|--upload-pack|--receive-pack|-exec|-execdir|-ok|-okdir)$/;
/** ssh's `-o ProxyCommand=...` and its kin. */
const SSH_RUNS = /^(ProxyCommand|LocalCommand|RemoteCommand|KnownHostsCommand)[= ]([\s\S]*)$/i;

const isFlag = (w: string) => w.startsWith("-") && w.length > 1;
/** A file name as used to compare what a command writes with what it runs. */
const fileKey = (t: string) => basename(t.replace(/^\.\//, "")).toLowerCase();
const WS = /\s/;

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
  /** The command just before this one, so a command that reads a pipe knows what feeds it. */
  let last: Cmd | undefined;
  const endCmd = (pipe: boolean) => {
    endWord(); pending = undefined;
    if (words.length || redirs.length) { const c: Cmd = { words, piped, redirs, ...(piped && last ? { from: last } : {}) }; cmds.push(c); last = c; } else last = undefined;
    words = []; redirs = []; piped = pipe;
  };
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
/** A file git or a hook runner runs by itself. */
const HOOK_DIR = /(^|\/)(\.git\/hooks|\.husky)\//;

// ---- what one scan remembers across the commands of one command line

interface Shared { aliases: Set<string>; written: Set<string>; work: number }
interface Ctx { shared: Shared; seen: Set<string> }
const ctxs = new WeakMap<ShellScan, Ctx>();
function ctxOf(scan: ShellScan): Ctx {
  let c = ctxs.get(scan);
  if (!c) { c = { shared: { aliases: new Set(), written: new Set(), work: 0 }, seen: new Set() }; ctxs.set(scan, c); }
  return c;
}
/**
 * How a command is being looked at. `top`: a command of its own, read strictly. `wrap`: a word after a wrapper (`sudo`, `env`...), which may be the program it
 * runs or just one of its arguments: strict about computed names and patterns, quiet about words with spaces. `generic`: a word after a program the hub has no
 * special reading for: only plain names count, and nothing else is a finding. `probe`: a later word of a wrapper's line that is not the first command word:
 * read like `wrap`, but its own arguments are not read again (the first command word's reading covers them).
 */
type Mode = "top" | "wrap" | "probe" | "generic";

function checkAssign(w: Word, scan: ShellScan) {
  const m = ASSIGN.exec(w.text);
  if (m && RISKY_ENV.test(m[1])) scan.unsure.push(`${m[1]} is set, and it can make a program run another program`);
}
/** The values given to a flag, in the forms `-c VALUE`, `--flag VALUE` and `--flag=VALUE`. */
function flagValues(args: Word[], re: RegExp): Word[] {
  const out: Word[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k], eq = /^(--[\w-]+)=([\s\S]*)$/.exec(a.text);
    if (eq) { if (re.test(eq[1])) out.push({ text: eq[2], dynamic: a.dynamic }); continue; }
    if (re.test(a.text) && args[k + 1]) out.push(args[k + 1]);
  }
  return out;
}
/** `--exec` or an unambiguous start of it (git accepts `--exe`). */
const longIs = (t: string, ...full: string[]) => /^--[\w-]+$/.test(t) && t.length > 3 && full.some((f) => f === t || f.startsWith(t));
/** The values of git's command-taking options: long names (or their abbreviations) with `=` or a next word, and an optional one-letter form (`-x CMD`, `-xCMD`). */
function gitOptWords(rest: Word[], fulls: string[], short?: string): Word[] {
  const out: Word[] = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k], t = a.text;
    if (t === "--") break;
    const eq = /^(--[\w-]+)=([\s\S]*)$/.exec(t);
    if (eq) { if (longIs(eq[1], ...fulls)) out.push({ text: eq[2], dynamic: a.dynamic }); continue; }
    if (longIs(t, ...fulls)) { if (rest[k + 1]) out.push(rest[k + 1]); continue; }
    if (short) {
      const m = new RegExp(`^-[A-Za-z]*?${short}([\\s\\S]*)$`).exec(t); // `-x CMD`, `-xCMD`, `-ix CMD`
      if (m) { if (m[1]) out.push({ text: m[1], dynamic: a.dynamic }); else if (rest[k + 1]) out.push(rest[k + 1]); }
    }
  }
  return out;
}
/** GNU sed's `e` command and the `e` flag of `s` run a shell command. */
const SED_RUNS = /(^|[;{}\n]\s*)(?:[0-9$]+\s*|\/[^/\n]*\/\s*)?e(?:\s|;|}|$)|(^|[;{}\n]\s*)(?:[0-9,$]+\s*|\/[^/\n]*\/\s*)?s(.)(?:\\.|(?!\3)[^\\])*\3(?:\\.|(?!\3)[^\\])*\3[a-zA-Z0-9]*e/;

function inspect(cmd: Cmd, depth: number, scan: ShellScan, mode: Mode = "top") {
  const ctx = ctxOf(scan), shared = ctx.shared;
  if (++shared.work > MAX_WORK) { scan.unsure.push("a command line too long to read with confidence"); return; }
  let i = 0;
  while (i < cmd.words.length && ASSIGN.test(cmd.words[i].text)) { if (mode === "top") checkAssign(cmd.words[i], scan); i++; }
  const words = cmd.words.slice(i);
  const emptyIn = (!!cmd.from && writesNothing(cmd.from.words)) || cmd.redirs.some((r) => r.op === "<" && r.target?.text === "/dev/null");
  // A word looked at as a guess at a program (after a wrapper or an unknown program) is looked at once per command line.
  if (mode !== "top") {
    const key = [mode, depth, cmd.piped ? 1 : 0, emptyIn ? 1 : 0, cmd.redirs.map((r) => `${r.op}${r.target?.text ?? ""}`).join(","), words.map((w) => (w.dynamic ? "\u0001" : "") + w.text).join("\u0000")].join("|");
    if (ctx.seen.has(key)) return;
    ctx.seen.add(key);
  }
  const del = (program: string, targets: string[], opaque: boolean) => { scan.deletes.push({ program, targets, opaque }); };
  const send = (kind: ShellSend["kind"], program: string) => { (scan.sends ??= []).push({ kind, program }); };
  const unsure = (why: string) => { scan.unsure.push(why); };

  // what this command writes: a script it writes and then runs is unsure, and so is a git hook
  for (const r of cmd.redirs) {
    if (r.target && !r.target.dynamic && [">", ">>", ">|", "<>"].includes(r.op) && !NOT_A_FILE.test(r.target.text)) {
      shared.written.add(fileKey(r.target.text));
      if (HOOK_DIR.test(r.target.text)) unsure("a git hook is written, and git runs hooks");
    }
  }
  // `: > f`, `> f`: nothing is written, so the file is emptied
  if (mode !== "generic" && writesNothing(words)) {
    for (const r of cmd.redirs) if ((r.op === ">" || r.op === ">|") && r.target && !NOT_A_FILE.test(r.target.text)) del("> (empties the file)", [r.target.text], !!r.target.dynamic || /[*?[]/.test(r.target.text));
  }
  if (!words.length) return;
  const prog = words[0], args = words.slice(1);
  if (prog.dynamic) { if (mode !== "generic") unsure("a command name is computed"); return; }
  const t = prog.text;
  // A program is read only when its name is a plain name or path. Whitespace, braces, quotes with spaces, `$`, backticks and globs mean the scanner
  // can't say what runs, so the owner decides.
  if (!SYNTAX.has(t) && !PLAIN.test(t)) {
    if (mode === "generic" || ((mode === "wrap" || mode === "probe") && WS.test(t))) return;
    unsure(/[*?[\]]/.test(t) ? "a command name is a pattern" : WS.test(t) ? "a command name has spaces in it" : "a command name is not a plain name or path");
    return;
  }
  if ((mode === "wrap" || mode === "probe") && isFlag(t)) return; // a flag of the wrapper, not a program
  if (shared.aliases.has(t)) { unsure("an alias defined in this command is used"); return; }
  if (mode !== "generic" && shared.written.has(fileKey(t)) && !SYNTAX.has(t)) { unsure("a file this command wrote is run"); return; }
  const base = progName(t);
  const stdin = readsStdin(cmd);
  const sub = (ws: Word[], m: Mode = "wrap") => inspect({ words: ws, piped: cmd.piped, redirs: cmd.redirs, from: cmd.from }, depth, scan, m);
  /** A command line given as one word: read it as shell. A computed one is unsure. */
  const str = (w: Word | undefined, why: string) => { if (!w) return; if (w.dynamic) unsure(why); else void scanInto(w.text, depth + 1, scan); };
  const runsWritten = (ws: Word[]) => ws.some((a) => !isFlag(a.text) && shared.written.has(fileKey(a.text)));

  // ---- builtins that set, define or defer things
  if (ASSIGN_BUILTINS.has(base)) {
    for (const a of args) checkAssign(a, scan);
    if (base === "setenv" && args[0] && RISKY_ENV.test(args[0].text)) unsure(`${args[0].text} is set, and it can make a program run another program`);
    return;
  }
  if (base === "alias") {
    for (const a of args) {
      const m = /^([^=\s]+)=([\s\S]*)$/.exec(a.text);
      if (isFlag(a.text) || !m) continue;
      shared.aliases.add(m[1]);
      str({ text: m[2], dynamic: a.dynamic }, "an alias is computed");
    }
    return;
  }
  if (base === "trap") {
    const a = args[0]?.text === "--" ? args.slice(1) : args;
    if (a.length >= 2 && !/^-[pl]+$/.test(a[0].text) && a[0].text !== "-") str(a[0], "a trap is computed");
    return;
  }
  if (DEFERRED.has(base)) {
    if (base === "crontab") {
      if (args.some((a) => /^-[A-Za-z]*r/.test(a.text))) del("crontab -r", [], true);
      else if (!args.some((a) => a.text === "-l")) unsure("crontab sets up a command to run later");
      return;
    }
    if (!args.every((a) => DEFERRED_READS.test(a.text)) || (!args.length && stdin)) unsure(`${base} runs a command later or somewhere else`);
    return;
  }
  if (base === "launchctl" && args.some((a) => /^(submit|load|bootstrap|kickstart|start|enable|attach|debug)$/.test(a.text))) unsure("launchctl starts a job");

  // ---- wrappers: programs that run a command line they are given
  const sf = stringFlagOf(base);
  const given = sf ? flagValues(args, sf) : [];
  if (base === "env") for (const a of args) { const m = /^-S([\s\S]+)$/.exec(a.text); if (m) given.push({ text: m[1], dynamic: a.dynamic }); }
  for (const v of given) str(v, "a command line is computed");
  if (base === "watch") { const line = args.filter((a) => !isFlag(a.text)); if (line.length === 1 && !line[0].dynamic) void scanInto(line[0].text, depth + 1, scan); }
  if (stdin) {
    // text piped into a program that starts a shell is run by it
    const sudoShell = (base === "sudo" || base === "doas") && args.some((a) => /^-[A-Za-z]*[si][A-Za-z]*$/.test(a.text) || /^--(shell|login)$/.test(a.text));
    if (sudoShell || ((base === "su" || base === "runuser" || base === "script") && !given.length)) unsure("text is piped into a program that starts a shell");
  }
  if (WRAPPERS.has(base)) {
    const shellStarter = (base === "sudo" || base === "doas") && args.some((a) => /^-[A-Za-z]*[si][A-Za-z]*$/.test(a.text) || /^--(shell|login)$/.test(a.text));
    // the first word that is not a flag, an assignment or a duration: where the command (or its one command string) starts
    const isCommandWord = (a: Word) => !isFlag(a.text) && !ASSIGN.test(a.text) && !/^\d+(\.\d+)?[smhd]?$/.test(a.text);
    const lead = args.findIndex(isCommandWord);
    // shell grammar words (`do`, `then`, `{`, `!`...) are followed by one command: its own reading covers its arguments
    if (GRAMMAR.has(base)) { sub(words.slice(1), "wrap"); return; }
    // A later word can be the program (`sudo -u me $CMD`), but the words after a plain program's own first arguments are its arguments: a glob or a
    // computed word there (`timeout 5 eslint src/**/*.ts`, `sudo ls $DIR`) is only looked at when it is the program's turn to be one.
    let seen = 0, strict = true;
    const own = new Set<string>(); // files an earlier word of this same wrapper line wrote (`sudo tee f`: f is tee's argument, not a program that ran)
    for (let k = 1; k < words.length; k++) {
      const w = words[k];
      if (!w.dynamic && own.has(fileKey(w.text))) continue;
      if (ASSIGN.test(w.text) && (lead < 0 || k - 1 < lead)) checkAssign(w, scan);
      const commandWord = isCommandWord(w);
      if (commandWord) { if (seen >= 2) strict = false; seen++; }
      if (!w.dynamic && WS.test(w.text)) { if (k - 1 === lead || shellStarter) str(w, "a command line is computed"); continue; }
      if (k - 1 === lead && !w.dynamic && PLAIN.test(w.text)) { const lb = progName(w.text); if (DATA.has(lb) && !WRAPPERS.has(lb)) strict = false; } // `sudo ls $DIR`: ls is the program
      if (!strict && (w.dynamic || !PLAIN.test(w.text))) continue;
      const had = new Set(shared.written);
      sub(words.slice(k), k - 1 === lead ? "wrap" : "probe");
      for (const f of shared.written) if (!had.has(f)) own.add(f);
    }
    return;
  }
  if (base === "pnpm" || base === "npm" || base === "yarn") {
    const j = args.findIndex((a) => /^(exec|dlx|x)$/.test(a.text));
    if (j >= 0) { const h = args.findIndex((a, n) => n > j && !isFlag(a.text)); if (h >= 0) sub(args.slice(h), "wrap"); return; }
    const first = args.find((a) => !isFlag(a.text));
    if (first && /^(rimraf|del-cli|trash|trash-put)$/.test(first.text)) del(first.text, targetsOf(args.slice(args.indexOf(first) + 1)).targets, true);
  }

  // ---- shells and interpreters
  if (base === "source" || base === ".") {
    if (stdin || args.some((a) => a.proc || STDIN_FILE.test(a.text))) unsure("a script made on the fly is run in this shell");
    else if (runsWritten(args)) unsure("a script this command wrote is run in this shell");
    return;
  }
  if (SHELLS.has(base)) {
    if (args.some((a) => a.proc)) { unsure("a shell is given a script made on the fly"); return; }
    if (args.some((a) => STDIN_FILE.test(a.text))) { unsure("a shell is given a script on standard input"); return; }
    const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a.text));
    if (ci >= 0) {
      const script = args[ci + 1];
      if (!script) return;
      if (script.dynamic) { unsure("a shell is given a computed command"); return; }
      void scanInto(script.text, depth + 1, scan);
    } else if (stdin || !args.some((a) => !isFlag(a.text))) unsure("text is piped or redirected into a shell");
    else if (runsWritten(args)) unsure("a script this command wrote is run");
    return;
  }
  if (base === "eval") {
    if (args.some((a) => a.dynamic)) unsure("eval of a computed string");
    else if (args.length) void scanInto(args.map((a) => a.text).join(" "), depth + 1, scan);
    return;
  }
  const interp = interpreterOf(base);
  if (interp) {
    // Code handed to an interpreter is not read. Inline code, code on standard input and code made on the fly are all unsure.
    const flags = CODE_FLAGS[interp], upto = args.findIndex((a) => a.text === "--"), own = upto < 0 ? args : args.slice(0, upto);
    if (own.some((a) => ASKS_ONLY.test(a.text)) && !own.some((a) => flags.test(a.text))) return;
    if (own.some((a) => flags.test(a.text))) { unsure(`${base} is given code to run (inline)`); return; }
    if (CODE_SUBCOMMANDS[interp] && own.some((a) => !isFlag(a.text) && CODE_SUBCOMMANDS[interp].test(a.text))) { unsure(`${base} is given code to run`); return; }
    if (args.some((a) => a.proc)) { unsure(`${base} is given a script made on the fly`); return; }
    if (!args.some((a) => !isFlag(a.text)) || args.some((a) => STDIN_FILE.test(a.text)) || (stdin && args.some((a) => a.text === "-")) || (interp === "expect" && args.some((a) => a.text === "-"))) { unsure(`${base} reads its code from standard input`); return; }
    if (interp === "python" || interp === "pypy" || interp === "ipython") {
      for (const a of own) {
        const m = /^-[A-Za-z]*m(.*)$/.exec(a.text);
        if (m) {
          const mod = m[1] || own[own.indexOf(a) + 1]?.text;
          if (!mod || !PYTHON_SAFE_MODULES.test(mod)) { unsure(`${base} -m runs a module the hub does not know (${(mod ?? "?").slice(0, 30)})`); return; }
          break;
        }
        if (!isFlag(a.text)) break; // the script: no more python options
      }
    }
    if (runsWritten(args)) unsure(`${base} is given a script this command wrote`);
    return;
  }
  if (base === "make" || base === "gmake" || base === "bmake") {
    const files = [...flagValues(args, /^(-f|--file|--makefile)$/), ...args.filter((a) => /^-f./.test(a.text)).map((a) => ({ text: a.text.slice(2), dynamic: a.dynamic }))];
    if (files.some((f) => f.text === "-" || STDIN_FILE.test(f.text))) unsure("make is given a makefile on standard input");
    else if (files.some((f) => shared.written.has(fileKey(f.text))) || (!files.length && (shared.written.has("makefile") || shared.written.has("gnumakefile")))) unsure("make is given a makefile this command wrote");
    return;
  }

  // ---- deleting programs
  if (DELETE_PROGRAMS.has(base)) { const tg = targetsOf(args); del(base, tg.targets, tg.opaque); return; }
  if (base === "mv") { del("mv", targetsOf(args).targets, true); return; } // it removes the source and can overwrite the target
  if (base === "truncate") { const tg = targetsOf(args.filter((a) => !/^\d+[kmgt]?$/i.test(a.text))); del(base, tg.targets, true); return; }
  if (base === "dd") { const o = args.find((a) => a.text.startsWith("of=")); if (o && !NOT_A_FILE.test(o.text.slice(3))) del("dd of=", [o.text.slice(3)], o.dynamic); return; }
  if ((base === "cp" || base === "install") && args.some((a) => a.text === "/dev/null")) { const ops = targetsOf(args).targets.filter((x) => x !== "/dev/null"); del(`${base} /dev/null`, ops.slice(-1), ops.length !== 1); return; }
  if (base === "ln" && args.some((a) => /^-[A-Za-z]*f[A-Za-z]*$/.test(a.text) || a.text === "--force")) { const ops = targetsOf(args); del("ln -f", ops.targets.slice(-1), ops.opaque || ops.targets.length !== 2); return; } // -f removes what is at the destination
  if (base === "tee") {
    const files = args.filter((a) => !isFlag(a.text));
    for (const f of files) { shared.written.add(fileKey(f.text)); if (HOOK_DIR.test(f.text)) unsure("a git hook is written, and git runs hooks"); }
    // `: | tee f`, `true | tee f`, `tee f < /dev/null`: nothing is written, so the file is emptied (`-a` appends, which changes nothing)
    if (emptyIn && files.length && !args.some((a) => /^-[A-Za-z]*a[A-Za-z]*$/.test(a.text) || a.text === "--append")) del("tee (writes nothing, which empties the file)", files.map((f) => f.text), files.some((f) => f.dynamic || /[*?[]/.test(f.text)));
    return;
  }
  if (base === "tar") {
    if (args.some((a) => a.text === "--remove-files")) { del("tar --remove-files", [], true); return; }
    for (const v of flagValues(args, /^(--to-command|--use-compress-program|--checkpoint-action|-I|--info-script|--new-volume-script)$/)) str({ text: v.text.replace(/^exec=/, ""), dynamic: v.dynamic }, "a command line is computed");
    return;
  }
  if (base === "awk" || base === "gawk" || base === "mawk") {
    const prog2 = args.filter((a) => !isFlag(a.text)).map((a) => a.text);
    if (prog2.some((c) => INLINE_DELETE.test(c))) del(`${base} (inline code)`, [], true);
    else if (prog2.some((c) => /\bsystem\s*\(|\|\s*"|\|&/.test(c))) unsure(`${base} runs commands`);
    return;
  }
  if (base === "sed" || base === "gsed") {
    const scripts = [...flagValues(args, /^(-e|--expression)$/).map((v) => v.text), ...(args.some((a) => /^(-e|--expression(=.*)?|-f|--file(=.*)?)$/.test(a.text)) ? [] : args.filter((a) => !isFlag(a.text)).slice(0, 1).map((a) => a.text))];
    if (scripts.some((s) => SED_RUNS.test(s))) unsure("sed is given a script that runs a command (e)");
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

  // ---- git
  if (base === "git") {
    let k = 0;
    const settingRuns = (kv: string, dynamic: boolean) => {
      if (!GIT_RUNS.test(kv)) return;
      unsure("git is given a setting that runs a program");
      const eq = kv.indexOf("=");
      if (/^alias\./i.test(kv) && eq > 0 && kv[eq + 1] === "!" && !dynamic) void scanInto(kv.slice(eq + 2), depth + 1, scan);
    };
    while (k < args.length && isFlag(args[k].text)) {
      const a = args[k], tx = a.text;
      if (/^(-c|--config-env)$/.test(tx) && args[k + 1]) settingRuns(args[k + 1].text, args[k + 1].dynamic);
      if (/^--config-env=/.test(tx)) settingRuns(tx.slice(13), a.dynamic);
      // a global option's value is not the subcommand (`--work-tree .`, `--git-dir .git`, `-C dir`, `-c k=v`); `--exec-path` takes one only with `=`, but a word that is no subcommand after it is skipped as well
      k += GIT_VALUE.test(tx) || (tx === "--exec-path" && args[k + 1] && !GIT_KNOWN.has(args[k + 1].text)) ? 2 : 1;
    }
    const sub0 = args[k]?.text, rest = args.slice(k + 1), has = (re: RegExp) => rest.some((a) => re.test(a.text)), nonFlags = rest.filter((a) => !isFlag(a.text));
    if (!sub0) return;
    if (!GIT_KNOWN.has(sub0)) { unsure(`git ${sub0.slice(0, 30)} is not a git command the hub knows (it may be an alias)`); return; }
    // settings given after the subcommand (`git clone -c core.sshCommand=...`)
    for (let j = 0; j < rest.length; j++) {
      const tx = rest[j].text;
      if ((tx === "-c" || tx === "--config") && rest[j + 1]) settingRuns(rest[j + 1].text, rest[j + 1].dynamic);
      else if (/^--config=/.test(tx)) settingRuns(tx.slice(9), rest[j].dynamic);
    }
    const cmdOpts = (fulls: string[], short?: string) => { for (const v of gitOptWords(rest, fulls, short)) str(v, "git is given a computed command"); };
    if (sub0 === "clean") del("git clean", [], true);
    else if (sub0 === "rm") { const tg = targetsOf(rest); del("git rm", tg.targets, tg.opaque); }
    else if (sub0 === "mv") del("git mv", [], true); // a move is a delete of the old path (and an overwrite with -f)
    else if (sub0 === "branch" && has(/^(-[a-z]*d[a-z]*|--delete)$/i)) del("git branch -d", nonFlags.map((a) => `branch:${a.text}`), false);
    else if (sub0 === "branch" && has(/^(-[a-z]*m[a-z]*|--move)$/i)) del("git branch -m", nonFlags.map((a) => `branch:${a.text}`), false); // a rename removes the old name
    else if (sub0 === "tag" && has(/^(-d|--delete)$/)) del("git tag -d", nonFlags.map((a) => `tag:${a.text}`), false);
    else if (sub0 === "push" && (has(/^(-d|--delete|--prune|--mirror)$/) || rest.some((a) => /^:\S/.test(a.text)))) del("git push --delete", [], true);
    else if (sub0 === "stash" && /^(drop|clear)$/.test(rest[0]?.text ?? "")) del("git stash drop", [], true);
    else if (sub0 === "worktree" && /^(remove|prune)$/.test(rest[0]?.text ?? "")) del("git worktree remove", [], true);
    else if (sub0 === "remote" && /^(remove|rm|prune)$/.test(rest[0]?.text ?? "")) del("git remote remove", [], true);
    else if (sub0 === "update-ref" && has(/^(-d|--delete)$/)) del("git update-ref -d", nonFlags.slice(0, 1).map((a) => `ref:${a.text}`), false);
    else if (sub0 === "notes" && /^(remove|prune)$/.test(rest[0]?.text ?? "")) del("git notes remove", [], true);
    else if (sub0 === "reflog" && /^(delete|expire)$/.test(rest[0]?.text ?? "")) del("git reflog delete", [], true);
    else if (sub0 === "submodule" && has(/^deinit$/)) del("git submodule deinit", [], true);
    else if (sub0 === "lfs" && /^prune$/.test(rest[0]?.text ?? "")) del("git lfs prune", [], true);
    else if (sub0 === "prune" || (sub0 === "gc" && has(/^--prune(=.*)?$/))) del("git prune", [], true);
    else if (sub0 === "config") {
      const key = nonFlags[0]?.text ?? "";
      if (nonFlags.length >= 2 && GIT_RUNS.test(key)) { unsure("git config sets something that runs a program"); const v = nonFlags[1]; if (/^alias\./i.test(key) && v.text.startsWith("!") && !v.dynamic) void scanInto(v.text.slice(1), depth + 1, scan); }
    } else if (sub0 === "send-email") send("email", "git send-email");
    // options whose value is a command that git runs
    if (sub0 === "bisect" && rest[0]?.text === "run") sub(rest.slice(1));
    if (sub0 === "rebase") cmdOpts(["--exec"], "x");
    if (sub0 === "submodule" && rest.some((a) => a.text === "foreach")) { const at = rest.findIndex((a) => a.text === "foreach"), line = rest.slice(at + 1).filter((a) => !isFlag(a.text)); if (line.some((a) => a.dynamic)) unsure("git submodule foreach is given a computed command"); else if (line.length) void scanInto(line.map((a) => a.text).join(" "), depth + 1, scan); }
    if (sub0 === "filter-branch") cmdOpts(["--env-filter", "--tree-filter", "--index-filter", "--parent-filter", "--msg-filter", "--commit-filter", "--tag-name-filter"]);
    if (sub0 === "fetch" || sub0 === "pull" || sub0 === "ls-remote") cmdOpts(sub0 === "ls-remote" ? ["--upload-pack", "--exec"] : ["--upload-pack"]);
    if (sub0 === "clone") cmdOpts(["--upload-pack"], "u");
    if (sub0 === "push") cmdOpts(["--receive-pack", "--exec"]);
    if (sub0 === "archive") cmdOpts(["--exec"]);
    if (sub0 === "difftool") cmdOpts(["--extcmd"], "x");
    if (sub0 === "grep") for (const a of rest) {
      if (/^--open-files-in-pager/.test(a.text) || /^--open-files/.test(a.text)) { const eq = a.text.indexOf("="); if (eq > 0) str({ text: a.text.slice(eq + 1), dynamic: a.dynamic }, "git grep is given a computed pager"); else unsure("git grep -O opens a pager"); }
      else if (/^-[A-Za-z]*O/.test(a.text) && !a.text.startsWith("--")) { const v = a.text.slice(a.text.indexOf("O") + 1); if (v) str({ text: v, dynamic: a.dynamic }, "git grep is given a computed pager"); else unsure("git grep -O opens a pager"); }
    }
    return;
  }

  // ---- other tools with their own ways to run, delete, send or write
  if (base === "rsync") {
    for (const v of [...flagValues(args, /^--rsh$/), ...args.flatMap((a, n) => (/^-[A-Za-z]*e$/.test(a.text) && args[n + 1] ? [args[n + 1]] : []))]) str(v, "a command line is computed");
    if (args.some((a) => /^--(delete|remove-source-files|del)\b/.test(a.text))) del("rsync --delete", [], true);
    return;
  }
  if (MAIL_PROGRAMS.has(base)) { send("email", base); return; }
  if (base === "curl" || base === "wget") {
    if (args.some((a) => /smtps?:\/\//i.test(a.text) || /^--mail-(rcpt|from|auth)/.test(a.text))) send("email", base);
    // what a download writes may be run next
    for (const v of flagValues(args, /^(-o|--output|-O|--output-document)$/)) { shared.written.add(fileKey(v.text)); if (HOOK_DIR.test(v.text)) unsure("a git hook is written, and git runs hooks"); }
    if (args.some((a) => /^-[A-Za-z]*O$/.test(a.text) || a.text === "--remote-name")) for (const a of args) if (/^https?:\/\//i.test(a.text)) shared.written.add(fileKey(a.text.replace(/[?#].*$/, "")));
    return;
  }
  if (base === "nc" || base === "ncat" || base === "netcat" || base === "telnet" || base === "openssl") {
    if (args.some((a) => /^(25|465|587|2525)$/.test(a.text) || /:(25|465|587|2525)$/.test(a.text) || /^smtp/i.test(a.text))) send("email", base);
    // netcat's `-c` and `-e` (and ncat's `--sh-exec`, `--exec`) run a command for each connection
    for (const v of flagValues(args, /^(-c|-e|--sh-exec|--exec)$/)) str(v, "a command line is computed");
    return;
  }
  if (base === "sf" || base === "sfdx") {
    // Salesforce CLI: data writes and Apex (which can write) are CRM writes; queries and gets are reads
    const tk = args.filter((a) => !isFlag(a.text)).flatMap((a) => a.text.split(":"));
    const at = (name: string) => tk.indexOf(name);
    const d = at("data"), fo = tk.indexOf("force");
    const method = flagValues(args, /^(-X|--method)$/).map((v) => v.text.toUpperCase()).pop() ?? args.map((a) => /^-X(.+)$/.exec(a.text)?.[1]?.toUpperCase()).find((x) => x);
    if (d >= 0 && (fo < 0 || fo + 1 !== d) && /^(delete|update|create|upsert|import)$/.test(tk[d + 1] ?? "")) send("crm", `${base} data ${tk[d + 1]}`);
    else if (fo >= 0 && tk[fo + 1] === "data" && !/^(soql|query)$/.test(tk[fo + 2] ?? "") && !(tk[fo + 2] === "record" && tk[fo + 3] === "get") && !(tk[fo + 2] === "tree" && tk[fo + 3] === "export") && !(tk[fo + 2] === "bulk" && /^(status|report)$/.test(tk[fo + 3] ?? ""))) send("crm", `${base} force:data`);
    else if ((at("apex") >= 0 && /^(run|execute)$/.test(tk[at("apex") + 1] ?? "")) || (fo >= 0 && tk[fo + 1] === "apex" && tk[fo + 2] === "execute")) send("crm", `${base} apex run`);
    else if (at("api") >= 0 && tk[at("api") + 1] === "request" && (method ? method !== "GET" : args.some((a) => /^(--body|-b)$/.test(a.text)))) send("crm", `${base} api request`);
    return;
  }
  if (base === "gh" && args.find((a) => !isFlag(a.text))?.text === "api") {
    const method = flagValues(args, /^(-X|--method)$/).map((v) => v.text.toUpperCase()).pop() ?? args.map((a) => /^-X=?(.+)$/.exec(a.text)?.[1]?.toUpperCase()).filter((x): x is string => !!x).pop();
    const graphql = args.some((a) => a.text === "graphql");
    const hasBody = args.some((a) => /^(-f|-F|--field|--raw-field|--input)(=.*)?$/.test(a.text) || /^-[fF]./.test(a.text));
    const writes = method ? /^(DELETE|PUT|PATCH|POST)$/.test(method) && !(graphql && !args.some((a) => /\bmutation\b/i.test(a.text))) : graphql ? args.some((a) => /\bmutation\b/i.test(a.text)) : hasBody;
    if (writes) del(`gh api ${method ?? "POST"}`, [], true);
    return;
  }
  if (INFRA.has(base)) {
    const verbs = INFRA.get(base)!;
    if (args.some((a) => !isFlag(a.text) && verbs.test(a.text))) del(base, [], true);
    else if (SYNC_DELETE.get(base) && args.some((a) => SYNC_DELETE.get(base)!.test(a.text))) del(`${base} --delete`, [], true);
    else if (base === "gsutil" && args.some((a) => a.text === "rsync") && args.some((a) => /^-[A-Za-z]*d[A-Za-z]*$/.test(a.text))) del("gsutil rsync -d", [], true);
    return;
  }

  // ---- a program the hub has no special reading for: read what it is given the way a wrapper's arguments are read
  if (mode === "generic" || mode === "probe" || DATA.has(base)) return;
  for (let k = 0; k < args.length; k++) {
    const a = args[k], eq = /^(--[\w-]+)=([\s\S]*)$/.exec(a.text), name = eq ? eq[1] : a.text;
    // a flag that hands the program a command line (`--exec 'rm x'`, `-c '...'`), and ssh's `-o ProxyCommand=...`
    if (EXEC_FLAG.test(name)) str(eq ? { text: eq[2].replace(/^exec=/, ""), dynamic: a.dynamic } : args[k + 1] && { text: args[k + 1].text.replace(/^exec=/, ""), dynamic: args[k + 1].dynamic }, "a command line is computed");
    else if (name === "-o" || /^-o./.test(name)) {
      const v = name === "-o" ? args[k + 1] : { text: name.slice(2), dynamic: a.dynamic };
      const m = v ? SSH_RUNS.exec(v.text) : null;
      if (v && m) str({ text: m[2], dynamic: v.dynamic }, "a command line is computed");
    }
  }
  for (const a of args) {
    // a string with spaces may be a command line for a wrapper the hub doesn't know: only what it deletes or sends counts, as it may be plain words
    if (a.dynamic || !WS.test(a.text) || a.text.length > 2000) continue;
    const tmp: ShellScan = { deletes: [], unsure: [], sends: [] };
    ctxs.set(tmp, { shared, seen: new Set() });
    void scanInto(a.text, depth + 1, tmp);
    scan.deletes.push(...tmp.deletes); (scan.sends ??= []).push(...(tmp.sends ?? []));
  }
  // and a later word may be the program it runs
  for (let k = 0; k < args.length; k++) if (!args[k].dynamic && !isFlag(args[k].text) && PLAIN.test(args[k].text)) sub(args.slice(k), "generic");
}

function scanInto(src: string, depth: number, scan: ShellScan): void {
  if (depth > MAX_DEPTH) { scan.unsure.push("commands nested too deeply to read"); return; }
  for (const c of lex(src, depth, scan)) inspect(c, depth, scan);
}

export function scanShell(command: string): ShellScan {
  const scan: ShellScan = { deletes: [], unsure: [], sends: [] };
  if (command.length > MAX_LEN) { scan.unsure.push("a very long command"); return scan; }
  scanInto(command, 0, scan);
  // The same finding can be seen twice (a wrapper checks every later word): keep each once.
  const seen = new Set<string>();
  scan.deletes = scan.deletes.filter((d) => { const k = `${d.program}|${d.targets.join("\0")}|${d.opaque}`; if (seen.has(k)) return false; seen.add(k); return true; });
  scan.unsure = [...new Set(scan.unsure)];
  const sent = new Set<string>();
  scan.sends = (scan.sends ?? []).filter((s) => { const k = `${s.kind}|${s.program}`; if (sent.has(k)) return false; sent.add(k); return true; });
  return scan;
}
