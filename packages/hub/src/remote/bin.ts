// 1.2 Finding a program to run. The hub is a long-lived process that runs `tailscale` and `open` as the owner, so it must not run
// whatever comes first on PATH: a program dropped into a folder the owner's own processes can write to would run with the hub's rights.
// Fixed absolute locations come first. PATH is only a fallback, and only for entries nobody but an administrator can change.
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/** True when the current user could write this path. Injectable: tests run as root, where everything is writable. */
export type IsWritable = (path: string) => boolean;

export const defaultIsWritable: IsWritable = (p) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } };

const isExecutableFile = (p: string) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };

/** Absolute paths on PATH where `name` is an executable file that neither its folder nor the file itself lets this user change. */
export function pathFallbacks(name: string, pathEnv: string | undefined, isWritable: IsWritable = defaultIsWritable): string[] {
  const out: string[] = [];
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue; // an empty or relative entry means "the current folder"
    const file = join(dir, name);
    if (!isExecutableFile(file)) continue;
    if (isWritable(dirname(file)) || isWritable(file)) continue;
    if (!out.includes(file)) out.push(file);
  }
  return out;
}

/** The first fixed location that is an executable file, else the first safe PATH entry, else undefined. */
export function resolveBin(name: string, fixed: string[], pathEnv: string | undefined, isWritable: IsWritable = defaultIsWritable): string | undefined {
  for (const f of fixed) if (isAbsolute(f) && isExecutableFile(f)) return f;
  return pathFallbacks(name, pathEnv, isWritable)[0];
}
