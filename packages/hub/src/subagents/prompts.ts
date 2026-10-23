/**
 * 3.3 What a helper (a room subagent) is told. It starts with the same "# Your task:" heading every task prompt has, so every adapter treats it as a
 * task run. A helper's reply is plain text for its parent: no STATUS block, no judging.
 */
export interface HelperBrief {
  parentName: string;
  parentTitle: string;
  title: string;
  instructions: string;
  expects?: string;
  files: string[];
  readOnly: boolean;
  depth: number;
  maxDepth: number;
  /** Where its own folder is, when it has one. */
  folder?: string;
  /** Other agents it may ask, by id. */
  others: { id: string; name: string }[];
}

export function helperPrompt(b: HelperBrief): string {
  const lines = [
    `# Your task: ${b.title}`,
    ``,
    `You are a helper. ${b.parentName} is working on "${b.parentTitle}" and asked you to do one part of it. ${b.parentName} is accountable for the result and will read your answer, so answer them directly. Your work is not graded separately.`,
    ``,
    `## What ${b.parentName} asked`,
    b.instructions.trim(),
    ...(b.expects ? [``, `## What to hand back`, b.expects.trim()] : [``, `## What to hand back`, `Your findings or result as plain text in your reply, short and specific. No status block.`]),
    ``,
    `## Rules`,
  ];
  if (b.readOnly) {
    lines.push(
      `- This is a READ-ONLY job. Do not create, change, move or delete any file, do not run commands that write anything, and do not propose file writes. Read, search and report.`,
      ...(b.files.length ? [`- Start with: ${b.files.join(", ")}.`] : []),
    );
  } else {
    lines.push(
      `- You work in your own folder${b.folder ? ` (${b.folder})` : ""}, a copy of ${b.parentName}'s current work. Nothing you change reaches ${b.parentName} until they accept it, and they may drop it.`,
      b.files.length ? `You may create or change only: ${b.files.join(", ")}. Read anything else you need.` : `You may create or change the files this job needs. Keep the change small and say which files you touched.`,
    );
  }
  lines.push(
    `- You can ask another agent one specific question with the ask_agent tool, or post to the room with post_message, the same as any agent. Don't start work for them and don't hand yours off.`,
    b.depth >= b.maxDepth ? `- You cannot start further helpers. Do this yourself.` : `- Start a further helper (spawn_agent) only if this part really splits; there is a limit on how many a goal may use.`,
    `- Stay on what was asked. If you can't do it, say what stopped you in your first line.`,
  );
  if (b.others.length) lines.push(``, `Agents you can ask: ${b.others.map((a) => `@${a.id} (${a.name})`).join(", ")}.`);
  return lines.join("\n");
}

/** Sent to a writing helper whose changes clashed with its parent's latest work (once). */
export function clashPrompt(b: HelperBrief, conflict: string[]): string {
  return [
    `# Your task: ${b.title} (merge fix)`,
    ``,
    `You are a helper for ${b.parentName}. Your work was finished, but it could not be merged because ${b.parentName} changed ${conflict.join(", ")} too. Your folder now holds ${b.parentName}'s latest work, and those files contain conflict markers (<<<<<<<, =======, >>>>>>>).`,
    ``,
    `Open each of those files, keep BOTH your change and ${b.parentName}'s (never drop theirs), remove every marker, and reply with one line saying what you did.`,
    `You may change only the conflicting files: ${conflict.join(", ")}. Read anything else you need.`,
  ].join("\n");
}
