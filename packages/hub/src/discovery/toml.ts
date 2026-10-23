/**
 * 1.3: just enough TOML to read ~/.codex/config.toml: table headers and plain `key = value` lines.
 * It finds `[mcp_servers.<name>]` tables (and their `enabled = false`) and the top-level model settings.
 * Everything else is skipped. Not a general parser; it never throws.
 */
export interface CodexConfig {
  /** MCP servers by name, with whether the table switches them off. */
  mcpServers: { name: string; enabled: boolean }[];
  model?: string;
  modelProvider?: string;
}

const unquote = (s: string) => {
  const t = s.trim();
  const m = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(t);
  return m ? (m[1] ?? m[2]) : t.replace(/\s+#.*$/, "");
};

/** Split a dotted table name (`mcp_servers."my server".env`) into parts. */
function tableParts(header: string): string[] {
  const parts: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/y;
  let pos = 0;
  while (pos < header.length) {
    re.lastIndex = pos;
    const m = re.exec(header);
    if (!m) break;
    parts.push(m[1] ?? m[2] ?? m[3]);
    pos = re.lastIndex;
  }
  return parts;
}

export function parseCodexToml(text: string): CodexConfig {
  const out: CodexConfig = { mcpServers: [] };
  const servers = new Map<string, boolean>();
  let table: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const h = /^\[\[?\s*(.+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (h) {
      table = tableParts(h[1]);
      if (table[0] === "mcp_servers" && table[1] && !servers.has(table[1])) servers.set(table[1], true);
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (table.length === 0) {
      if (key === "model") out.model = unquote(value);
      if (key === "model_provider") out.modelProvider = unquote(value);
    } else if (table[0] === "mcp_servers" && table.length === 2 && key === "enabled") {
      servers.set(table[1], !/^false\b/i.test(value.trim()));
    }
  }
  out.mcpServers = [...servers].map(([name, enabled]) => ({ name, enabled }));
  return out;
}
