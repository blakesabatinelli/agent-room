// 1.2 hardening: how the Mac app proves it is the Mac app. A loopback connection and a "localhost" Host header prove nothing once anything on
// the Mac forwards TCP to the hub (`tailscale funnel --tls-terminated-tcp`, `ssh -L`, `socat`): the hub sees 127.0.0.1 for the remote caller too.
// So POST /pair/local also needs a secret that only a process able to read the owner's data folder has.
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

export const LOCAL_SECRET_FILE = "local-pair.secret";
export const LOCAL_SECRET_HEADER = "x-agent-room-local-secret";

/** Makes a new random secret and writes it to <dataDir>/local-pair.secret, mode 0600. Called once per hub start, so a restart rotates it. */
export function writeLocalSecret(dataDir: string): string {
  const secret = randomBytes(32).toString("hex");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, LOCAL_SECRET_FILE);
  // New file with 0600 from the start, then moved over the old one: the secret is never readable under looser permissions, even briefly.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, secret, { mode: 0o600 });
  chmodSync(tmp, 0o600); // the mode above is masked by umask and ignored when the file already exists
  renameSync(tmp, file);
  return secret;
}

/** Constant-time comparison of the header against the hub's secret. A missing or repeated header never matches. */
export function localSecretMatches(secret: string, header: string | string[] | undefined): boolean {
  if (typeof header !== "string" || !header) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header), digest(secret));
}
