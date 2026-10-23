import { randomBytes, randomUUID } from "node:crypto";
export const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const now = () => Date.now();
export const token = () => randomBytes(32).toString("hex");
export const pairingCode = () => String(Math.floor(100000 + Math.random() * 900000));
