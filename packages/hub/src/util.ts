import { randomBytes, randomInt, randomUUID } from "node:crypto";
export const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const now = () => Date.now();
export const token = () => randomBytes(32).toString("hex");
/** Six digits from the system CSPRNG (not a seeded PRNG). `pick` is injectable for tests. */
export const pairingCode = (pick: (min: number, max: number) => number = randomInt) => String(pick(100000, 1000000));
