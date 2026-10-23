import { existsSync, mkdirSync } from "node:fs";
import type { ForkMerge } from "@agent-room/shared";
import type { FileBroker } from "../files/broker.js";
import { applyDeltas, folderDeltas, readChanges, type GitFn } from "./files.js";

/**
 * 4.4 AC3: apply the chosen side's result to the original target. Three landings, by what the goal worked on:
 *  - the hub's own folder (the forked goal's folder, or the fork's result folder): the side's files become the result;
 *  - a git repository the owner granted: the side's branch is made the branch agent-room/<goal> (never the checked-out branch, never forced);
 *  - any other granted folder: one write proposal with the side's whole diff, which waits for the owner's approval.
 */

export type MergeOutcome = { ok: true; merge: Pick<ForkMerge, "how" | "detail" | "branch" | "proposalId" | "files"> } | { ok: false; error: string; status: number };

const ZERO = "0000000000000000000000000000000000000000";

/** Hub folder: copy what the side added or changed, remove what it deleted. */
export function mergeIntoFolder(startDir: string, sideFolder: string, targetFolder: string): MergeOutcome {
  if (!existsSync(sideFolder)) return { ok: false, status: 409, error: "That side's folder is gone, so there is nothing to merge." };
  mkdirSync(targetFolder, { recursive: true });
  const deltas = folderDeltas(startDir, sideFolder);
  const n = applyDeltas(sideFolder, targetFolder, deltas);
  return { ok: true, merge: { how: "folder", files: n, detail: n ? `${n} file${n === 1 ? "" : "s"} written to the goal's folder.` : "That side changed no files, so the goal's folder is as it was." } };
}

/** Git: make `target` (agent-room/<goal>) point at the side's branch. Refuses a target that moved on, or one that is checked out. */
export async function mergeBranch(git: GitFn, sideBranch: string, target: string): Promise<MergeOutcome> {
  const tip = await git(["rev-parse", "--verify", "-q", `refs/heads/${sideBranch}`]);
  if (tip.code !== 0) return { ok: false, status: 409, error: "That side never put work on a branch in your repository, so there is nothing to merge." };
  const sha = tip.stdout.trim();
  const head = await git(["symbolic-ref", "-q", "HEAD"]);
  if (head.code === 0 && head.stdout.trim() === `refs/heads/${target}`) return { ok: false, status: 409, error: `${target} is the branch checked out in your repository. Check out another branch first; the hub never changes your branch.` };
  const cur = await git(["rev-parse", "--verify", "-q", `refs/heads/${target}`]);
  const old = cur.code === 0 ? cur.stdout.trim() : "";
  if (old && old !== sha) {
    const anc = await git(["merge-base", "--is-ancestor", old, sha]);
    if (anc.code !== 0) return { ok: false, status: 409, error: `${target} has changed since this fork started, so it can't be moved to the chosen side without losing work. Merge ${sideBranch} yourself.` };
  }
  if (old !== sha) {
    const upd = await git(["update-ref", "-m", "Agent Room: merged fork", `refs/heads/${target}`, sha, old || ZERO]);
    if (upd.code !== 0) return { ok: false, status: 500, error: `Could not update ${target}: ${upd.stderr.trim().split("\n")[0] || "git failed"}` };
  }
  return { ok: true, merge: { how: "branch", branch: target, detail: `${target} now holds the chosen side's work (${sha.slice(0, 8)}). Your own branch and files are untouched; merge ${target} when you're ready.` } };
}

/** A folder that isn't a git repository: one proposal through the file broker's approval flow, with the whole diff. */
export function mergeProposal(files: FileBroker, a: { grantId: string; agentId: string; roomId: string; goalId: string; forkId: string; title: string; startDir: string; sideFolder: string }): MergeOutcome {
  const deltas = folderDeltas(a.startDir, a.sideFolder);
  const { changes, skipped } = readChanges(a.sideFolder, deltas);
  const r = files.proposeTask({ grantId: a.grantId, agentId: a.agentId, roomId: a.roomId, goalId: a.goalId, taskId: a.forkId, title: a.title, changes, skipped });
  if (!r.ok) return { ok: false, status: 409, error: `The write could not be prepared: ${r.reason}` };
  if (!r.proposal) return { ok: true, merge: { how: "proposal", files: 0, detail: `The chosen side changed nothing that can be written back.${r.skipped.length ? ` ${r.skipped.length} file${r.skipped.length === 1 ? " was" : "s were"} left out.` : ""}` } };
  const n = r.proposal.files?.length ?? 1;
  return { ok: true, merge: { how: "proposal", proposalId: r.proposal.id, files: n, detail: `${n} file${n === 1 ? "" : "s"} wait for your approval. Open Approvals to see the whole diff; nothing changes until you approve.${r.skipped.length ? ` ${r.skipped.length} can't be written back; the approval lists them.` : ""}` } };
}
