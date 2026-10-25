import type { FailureTag, IssueKind } from "@agent-room/shared";

/**
 * The one suggested next step for each kind of issue, in plain words. A small fixed table: the hub never writes advice of its own,
 * so the same problem always gets the same sentence. Failure issues are told apart by their tag.
 */
export const NEXT_STEP: Record<Exclude<IssueKind, "failure"> | `failure:${FailureTag}`, string> = {
  "failure:spec": "Say more clearly what done means for these tasks, with a check a command can run",
  "failure:misalignment": "Narrow what these tasks may touch, and list the files each one owns",
  "failure:verification": "Add a runnable check to these tasks, so a command decides and not the agent",
  "failure:placement": "Route this kind of task to an agent on this Mac",
  "failure:other": "Open the traces to see what went wrong, or route this kind of task to another agent",
  placement: "Route this kind of task to an agent on this Mac",
  reply: "Check the agent's sign-in on the Agents page",
  repeat_post: "Tell the agent to post its reply once and then stop",
  approval_wait: "Open Approvals and decide the ones waiting",
  judge: "Add a second agent to the judge rotation",
};

export const nextStep = (kind: IssueKind, tag?: FailureTag): string => (kind === "failure" ? NEXT_STEP[`failure:${tag ?? "other"}`] : NEXT_STEP[kind]);
