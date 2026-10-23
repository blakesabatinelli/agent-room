import type { DiscoveryEnv } from "./env.js";

/** Names only (never the text) of skills under a folder: every `<name>/SKILL.md`, down a few levels. */
export function skillNames(env: DiscoveryEnv, root: string, maxDepth = 3, cap = 400): string[] {
  const out = new Set<string>();
  const seen = { n: 0 };
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || out.size >= cap || seen.n++ > 4000) return;
    const names = env.listDir(dir);
    if (!names) return;
    if (depth > 0 && names.includes("SKILL.md")) {
      out.add(nameFrom(env.readFile(`${dir}/SKILL.md`)) ?? dir.split("/").pop()!);
      return; // a skill's own folders (references, scripts) hold no more skills
    }
    for (const n of names.sort()) {
      if (n.startsWith(".") || n === "node_modules") continue;
      const p = `${dir}/${n}`;
      if (env.isDir(p)) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return [...out].sort();
}

/** `name:` from a SKILL.md's front matter. */
export function nameFrom(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const m = fm && /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm);
  const n = m?.[1]?.trim();
  return n ? n.slice(0, 60) : undefined;
}

/** Names of the `*.md` files in a folder, without the extension (Codex custom prompts). */
export function markdownNames(env: DiscoveryEnv, dir: string): string[] {
  return (env.listDir(dir) ?? []).filter((f) => f.endsWith(".md") && !f.startsWith(".")).map((f) => f.slice(0, -3)).sort();
}
