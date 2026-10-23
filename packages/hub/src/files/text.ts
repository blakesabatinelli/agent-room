/**
 * One rule for "is this text", used by every MCP file tool and by task write-back:
 * a file is text when it has no NUL byte and its bytes are valid UTF-8. Anything else is
 * never returned to an agent and never accepted from one.
 */

const strict = new TextDecoder("utf-8", { fatal: true });

export function isValidUtf8(buf: Uint8Array): boolean {
  try { strict.decode(buf); return true; } catch { return false; }
}

/** NUL anywhere, or bytes that are not valid UTF-8. */
export function isBinaryOrInvalid(buf: Buffer): boolean {
  return buf.includes(0) || !isValidUtf8(buf);
}

/**
 * A read that stopped at a byte limit may end in the middle of a multi-byte character.
 * Drop that partial tail (at most 3 bytes) so the rest can be validated on its own.
 */
export function withoutPartialTail(buf: Buffer): Buffer {
  for (let cut = 0; cut <= 3 && cut <= buf.length; cut++) {
    const part = buf.subarray(0, buf.length - cut);
    if (isValidUtf8(part)) return part;
  }
  return buf;
}

/** A JS string with an unpaired surrogate would be silently turned into U+FFFD when written; refuse it instead. */
export function isWellFormedText(s: string): boolean {
  return (s as string & { isWellFormed?: () => boolean }).isWellFormed ? (s as string & { isWellFormed: () => boolean }).isWellFormed() : !/[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""));
}

export const NOT_TEXT = "binary or not valid UTF-8";
