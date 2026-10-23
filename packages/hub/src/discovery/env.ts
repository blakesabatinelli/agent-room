import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runProc, which } from "../adapters/proc.js";

/**
 * 1.3: every way discovery touches the machine, so tests can fake all of it (a fake home folder, a fake PATH,
 * fake command output, fake model servers). The default implementation is the real machine.
 */
export interface DiscoveryEnv {
  /** The owner's home folder. */
  home: string;
  /** Environment variables discovery cares about (HERMES_HOME, ANTHROPIC_API_KEY). */
  vars: Record<string, string | undefined>;
  /** Absolute path of a program on PATH, or undefined. */
  which(bin: string): Promise<string | undefined>;
  /** Text of a file, or undefined when it can't be read. */
  readFile(path: string): string | undefined;
  /** Names in a folder, or undefined when it isn't one. */
  listDir(path: string): string[] | undefined;
  /** Is this a folder? */
  isDir(path: string): boolean;
  /** GET a URL. undefined when nothing answered in time. */
  fetchJson(url: string, timeoutMs: number): Promise<{ status: number; json?: unknown } | undefined>;
  /** Run a program with a time limit. */
  run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Ports to probe on localhost, by server. Overridable so tests can use ephemeral ports. */
  ports?: Partial<Record<"llama.cpp" | "ollama" | "lm-studio" | "vllm-mlx", number>>;
  /** Milliseconds a model server probe may take. */
  probeTimeoutMs?: number;
}

export const DEFAULT_PORTS = { "llama.cpp": 8080, ollama: 11434, "lm-studio": 1234, "vllm-mlx": 8000 } as const;

export function defaultEnv(overrides: Partial<DiscoveryEnv> = {}): DiscoveryEnv {
  return {
    home: homedir(),
    vars: process.env,
    which: async (bin) => (await which(bin)) ?? undefined,
    readFile: (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
    listDir: (p) => { try { return readdirSync(p); } catch { return undefined; } },
    isDir: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
    fetchJson: async (url, timeoutMs) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        const json = await res.json().catch(() => undefined);
        return { status: res.status, json };
      } catch { return undefined; }
    },
    run: (bin, args, timeoutMs) => runProc(bin, args, { timeoutMs }),
    ...overrides,
  };
}

export const joinPath = (...p: string[]) => join(...p);
