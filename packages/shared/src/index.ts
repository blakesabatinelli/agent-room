// Shared types between the hub and the apps.

export type AdapterKind = "claude-code" | "codex" | "mcp" | "command" | "openai-api" | "mock";

/** Live connection state of an agent, as shown in the sidebar. */
export type AgentState = "ready" | "signed_out" | "not_installed" | "offline" | "error";
export interface AgentStatus { id: string; ready: boolean; state: AgentState; detail: string; checkedAt: number }

/** Everything an external agent needs to join over MCP. */
export interface McpConnection {
  agentId: string;
  token: string;
  localUrl: string;
  /** Preferred tailnet address: the MagicDNS name when there is one, else the tailnet IP. */
  tailscaleUrl?: string;
  /** 1.2: the tailnet IP form, for clients that can't resolve MagicDNS names. */
  tailscaleIpUrl?: string;
  /** 1.2: public https address of /mcp, present only while Tailscale Funnel is on. */
  funnelUrl?: string;
  /** mcpServers JSON block for clients that take one */
  config: string;
  /** standing instructions to paste into the agent's system prompt */
  instructions: string;
  /** Ready-to-paste config blocks for specific clients (Hermes, Claude Desktop, ...). */
  snippets?: { id: string; label: string; where: string; text: string }[];
}

/** Delegation-policy roles: what kind of work a profile is for. */
export type Role = "explorer" | "worker" | "researcher" | "reviewer";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const ROLES: { id: Role; label: string; hint: string }[] = [
  { id: "explorer", label: "Explorer", hint: "Sweeps many files to answer one question. Cheap, read-only." },
  { id: "researcher", label: "Researcher", hint: "Finds one precise outside fact." },
  { id: "worker", label: "Worker", hint: "Builds a well-specified piece of work." },
  { id: "reviewer", label: "Reviewer", hint: "Independent check. Strongest model; used sparingly." },
];

/** One way of running an agent: a role, a model, an effort, a cost tier. */
export interface Profile {
  id: string;
  label: string;
  role: Role;
  model?: string;
  effort?: Effort;
  /** 1 cheap, 2 standard, 3 strongest. Failed work escalates up a tier. */
  tier: 1 | 2 | 3;
}

export interface AgentConfig {
  id: string;
  name: string;
  provider: string;            // "anthropic" | "openai" | "hermes" | "muse" | ...
  adapter: AdapterKind;
  enabled: boolean;
  color: string;
  /** adapter-specific settings, e.g. command template, model, base URL */
  settings: Record<string, unknown>;
  /** connector/tool id -> enabled */
  tools: Record<string, boolean>;
  canBeOrchestrator?: boolean;
  /** Ways to run this agent. Empty means one default profile from settings.model. */
  profiles?: Profile[];
  /** Sensitive tools this agent may use without asking first (tool id -> true). Only applies while the tool is on. */
  autoApprove?: Record<string, boolean>;
}

export type Author =
  | { kind: "human"; id: "owner"; name: string }
  | { kind: "agent"; id: string; name: string }
  | { kind: "orchestrator"; id: "orchestrator"; name: string }
  | { kind: "system"; id: "system"; name: string };

export type MessageType =
  | "human" | "agent" | "directive" | "task_update" | "tool_call" | "system";

export interface Message {
  id: string;
  roomId: string;
  type: MessageType;
  author: Author;
  text: string;
  mentions: string[];
  taskId?: string;
  /** Plan shown to the owner for approval (renders Approve / Change buttons). */
  planGoalId?: string;
  /** For agent-to-agent tags: how many agent hops deep this exchange is. */
  hop?: number;
  /** Behind-the-scenes coordination (routing, judging). Shown only in the work log. */
  quiet?: boolean;
  createdAt: number;
}

export type TaskStatus =
  | "pending" | "assigned" | "running" | "review" | "revising" | "waiting" | "done" | "failed" | "cancelled";

/** One acceptance criterion in a work contract. */
export interface Criterion {
  id: string;
  text: string;
  /** A shell command run in the goal's shared folder. Exit 0 = PASS. Runs only on an approved plan. */
  check?: string;
}

/** Result of a runnable check. */
export interface CheckRun { criterionId: string; command: string; ok: boolean; exitCode: number | null; output: string; at: number }

export type Verdict = "PASS" | "FAIL" | "UNSURE";

/** The structured block an agent must end its work with. */
export interface TaskReport {
  status: "done" | "blocked" | "needs_input" | "missing";
  criteria: Record<string, { verdict: Verdict; evidence: string }>;
  outOfScope: string;
  reason?: string;
  /** Choices the agent made that other tasks must stay consistent with (names, formats, assumptions). */
  decisions?: string[];
}

/** One line of a task's attempt log (work-contract "Attempts"). */
export interface AttemptLog {
  at: number;
  agentId: string;
  outcome: "ok" | "fail" | "drift" | "blocked" | "needs_input" | "replan" | "redirect";
  note: string;
}

export interface Task {
  id: string;
  roomId: string;
  goalId: string;
  title: string;
  description: string;
  taskType: string;            // writing | research | coding | analysis | data | other
  acceptance: string;
  dependsOn: string[];
  /** Who the plan named as owner. Only the orchestrator sets assignee. */
  owner?: string;
  assignee?: string;
  /** What this task may touch, and what belongs to someone else. */
  scope?: string;
  outOfScope?: string[];
  criteria?: Criterion[];
  report?: TaskReport;
  /** Drift flags raised on this task, newest last. */
  drift?: string[];
  replans?: number;
  triedBy?: string[];
  history?: AttemptLog[];
  claimedAt?: number;
  role?: Role;
  /** Profile actually used on the last run. */
  profileId?: string;
  /** Lowest tier allowed after an escalation. */
  minTier?: 1 | 2 | 3;
  /** Files in the shared folder this task may change (paths or globs). Empty = any. */
  files?: string[];
  checks?: CheckRun[];
  /** What this task hands back: the file(s) or format. Part of every delegation, with objective and boundaries. */
  output?: string;
  /** Goal requirements (G1…) this task delivers. Every requirement is covered by at least one task. */
  covers?: string[];
  /** Criteria the judge couldn't verify after escalation; the owner sees them instead of the task looping. */
  flagged?: string[];
  /** Consecutive reviews where the only blockers were UNSURE verdicts. */
  unsureRounds?: number;
  /** Routing log record for the current attempt (0.2). */
  routingId?: string;
  /** Every failure or send-back on this task, tagged by family (0.5). */
  failures?: FailureRecord[];
  /** A failure the goal already recovered from (so it isn't handled twice). */
  recovered?: boolean;
  /** Added to close a gap found by goal verification or recovery. */
  origin?: "plan" | "recovery" | "verify";
  status: TaskStatus;
  attempts: number;
  result?: string;
  judgment?: Judgment;
  createdAt: number;
  updatedAt: number;
}

export interface Judgment {
  score: number;               // 0..1
  verdict: "accept" | "revise" | "reassign";
  feedback: string;
  judgeAgentId: string;
  /** Per-criterion verdicts. */
  criteria?: Record<string, { verdict: Verdict; evidence: string }>;
  onTask?: boolean;
  drift?: string;
  /** The judge's read on why it isn't accepted (0.5). Mechanical evidence overrides it. */
  failureCategory?: FailureTag;
}

/** How an owner message sent while work is running was taken. */
export type SteerKind = "aside" | "amend" | "redirect" | "replan" | "stop";

/** Written contract for a multi-step goal. Frozen after planning; only the owner amends it. */
export interface Contract {
  objective: string;
  constraints: string[];
  deliverables: string[];
  outOfScope: string[];
  version: number;
  lockedAt: number;
  amendments: { at: number; text: string }[];
  /** The request expanded into every concrete thing "done" must include. Checked at the end, against the files. */
  requirements?: Requirement[];
  /** Choices made up front so parallel tasks don't make conflicting ones (names, formats, tone, structure). */
  decisions?: string[];
}

/** One thing the whole goal must deliver. Status is set by goal verification, not by any single task. */
export interface Requirement { id: string; text: string; status?: "open" | "met" | "unmet"; evidence?: string }

export interface GateLine { taskId: string; task: string; criterion: string; verdict: Verdict; evidence: string; flagged?: boolean }
export interface GateReport { passed: boolean; at: number; lines: GateLine[] }

/** Running state of a goal (work-contract STATE.md). */
export interface GoalState {
  decisions: { at: number; text: string }[];
  nextAction: string;
  gate?: GateReport;
  /** Choices agents reported while working; every later task is told to stay consistent with them. */
  shared?: { at: number; agentId: string; taskTitle: string; text: string }[];
  /** Progress ledger: how the goal is moving, for stall detection and bounded recovery. */
  progress?: GoalProgress;
  /** The orchestrator stopped and asked the owner this. The next owner message answers it and resumes the goal. */
  waitingOnOwner?: string;
}

export interface GoalProgress {
  /** Task runs so far (every attempt, any agent). */
  runs: number;
  /** Reviews in a row that accepted nothing. Reset by an accepted task. */
  stall: number;
  /** Goal-level replans used (after a task failed for good, or the goal stalled). */
  goalReplans: number;
  /** Goal verification rounds used. */
  verifyRounds: number;
  lastAcceptAt?: number;
  /** Task-run cap for this goal; starts at maxTaskRuns and grows when the owner says to keep going. */
  budget?: number;
}

export interface Goal {
  id: string;
  roomId: string;
  text: string;
  status: "planning" | "awaiting_approval" | "running" | "done" | "failed" | "paused" | "superseded";
  /** Set when the owner approved the plan; runnable checks only run on approved plans. */
  approvedAt?: number;
  /** The folder every task in this goal works in. */
  folder?: string;
  summary?: string;
  contract?: Contract;
  state?: GoalState;
  createdAt: number;
}

export interface Room {
  id: string;
  name: string;
  /** Set for a direct-message room with one agent: every message goes straight to it. */
  dmAgentId?: string;
  topic?: string;
  paused: boolean;
  createdAt: number;
}

export type MemoryScope = "shared" | "private";

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  ownerAgentId?: string;       // set for private memory
  roomId?: string;             // null = global shared memory
  text: string;
  sourceAgentId: string;
  confidence: number;
  createdAt: number;
}

export interface MemoryProposal {
  id: string;
  roomId?: string;
  text: string;
  sourceAgentId: string;
  confidence: number;
  /** `asked` (2.5): it contradicts a stored fact and the owner has one question open about it. */
  status: "pending" | "accepted" | "rejected" | "merged" | "asked";
  decidedBy?: "orchestrator" | "owner";
  createdAt: number;
}

export interface AgentScore {
  agentId: string;
  taskType: string;
  runs: number;
  quality: number;             // running mean 0..1
  avgSeconds: number;
  revisions: number;
  failures: number;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Approval {
  id: string;
  /** Approved by the agent's "run without asking" setting rather than by the owner. */
  auto?: boolean;
  roomId?: string;
  agentId: string;
  tool: string;
  action: string;
  detail: string;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt?: number;
}

export interface AuditEntry {
  id: string;
  at: number;
  actor: string;
  action: string;
  detail: string;
}

export interface OrchestratorSettings {
  orchestratorAgentId: string;
  judgeRotation: string[];     // agent ids used as judges, round-robin
  explorationRate: number;     // 0..1 epsilon
  maxAttempts: number;
  calibrationSampleRate: number; // share of judgments surfaced to owner
  /** Max back-and-forth agent-to-agent tags before the owner has to step in. */
  maxAgentHops?: number;
  /** An MCP agent that hasn't picked up its assignment within this loses it. */
  claimTimeoutMinutes?: number;
  /** Drift flags on one task before it is taken away from that agent. */
  driftStrikes?: number;
  /** When to show the plan for approval before work starts. */
  planApproval?: "always" | "big" | "never";
  /** Run plan checks (shell commands) without approval. Off: checks need an approved plan. */
  autoRunChecks?: boolean;
  /** Pick up running work after the hub restarts. */
  autoResume?: boolean;
  /** Reviews in a row with nothing accepted before the goal is replanned. */
  stallLimit?: number;
  /** Goal-level replans before the owner is asked how to proceed. */
  maxGoalReplans?: number;
  /** Rounds of "verify the whole goal, then fix gaps" before finishing. */
  maxVerifyRounds?: number;
  /** Hard cap on task runs per goal; the goal pauses and asks the owner past this. */
  maxTaskRuns?: number;
}

export const SETTING_DEFAULTS = {
  maxAgentHops: 4, claimTimeoutMinutes: 3, driftStrikes: 2,
  planApproval: "big" as "always" | "big" | "never", autoRunChecks: false, autoResume: true,
  stallLimit: 4, maxGoalReplans: 2, maxVerifyRounds: 2, maxTaskRuns: 40,
  memoryTtlDays: { fact: 90, preference: 365, status: 14 }, memoryExportBytes: 4096, // 2.5
  probationRuns: 5, // 2.3
};

/** Suggested profiles per provider, following the delegation policy's routing table. */
export const SUGGESTED_PROFILES: Record<string, Profile[]> = {
  anthropic: [
    { id: "explorer", label: "Haiku · explorer", role: "explorer", model: "claude-haiku-5-5", tier: 1 },
    { id: "worker", label: "Sonnet · high", role: "worker", model: "claude-sonnet-5-5", effort: "high", tier: 2 },
    { id: "lead", label: "Opus 5.5 · medium", role: "worker", model: "claude-opus-5-5", effort: "medium", tier: 3 },
    { id: "reviewer", label: "Opus 5.5 · high", role: "reviewer", model: "claude-opus-5-5", effort: "high", tier: 3 },
  ],
  openai: [
    { id: "explorer", label: "Luna · explorer", role: "explorer", model: "gpt-5.6-luna", effort: "low", tier: 1 },
    { id: "worker", label: "Terra · medium", role: "worker", model: "gpt-5.6-terra", effort: "medium", tier: 2 },
    { id: "reviewer", label: "Sol · high", role: "reviewer", model: "gpt-5.6-sol", effort: "high", tier: 3 },
  ],
};

/** Known connectors; sensitive ones need owner approval per action. */
export const TOOLS: { id: string; label: string; sensitive: boolean }[] = [
  { id: "web", label: "Web browsing", sensitive: false },
  { id: "filesystem", label: "Files in its workspace", sensitive: false },
  { id: "shell", label: "Shell commands", sensitive: true },
  { id: "gmail", label: "Gmail", sensitive: true },
  { id: "slack", label: "Slack", sensitive: true },
  { id: "drive", label: "Google Drive", sensitive: false },
  { id: "salesforce", label: "Salesforce", sensitive: true },
];

export type ServerEvent =
  | { type: "message"; message: Message }
  | { type: "task"; task: Task }
  | { type: "goal"; goal: Goal }
  | { type: "approval"; approval: Approval }
  | { type: "proposal"; proposal: MemoryProposal }
  | { type: "agent"; agent: AgentConfig }
  | { type: "room"; room: Room }
  | { type: "room_deleted"; roomId: string }
  | { type: "calibration"; task: Task }
  | { type: "agent_status"; status: AgentStatus }
  /** An agent started or stopped working in a room (drives the "is working" line). */
  | { type: "working"; roomId: string; agentId: string; label?: string; active: boolean }
  /** The owner has read a room up to this time (synced across the Mac and phone). */
  | { type: "read"; roomId: string; at: number }
  /** A control file changed on disk or in the app and was loaded (1.9). */
  | { type: "control"; at: number; changed: string[]; notices: ControlNotice[] };

// ---- 0.4 Document standard
export type DocStatus = "draft" | "review" | "final";

/** YAML front matter at the top of every Library document (see docs/DOCUMENTS.md). */
export interface DocFrontMatter {
  id: string;
  title: string;
  /** Room slug (the folder name), not the room id. */
  room: string;
  goal?: string;
  status: DocStatus;
  authors: string[];
  /** YYYY-MM-DD */
  created: string;
  /** YYYY-MM-DD */
  updated: string;
  sources: string[];
  tags?: string[];
}

/** A document in the Library, as indexed by the hub. */
export interface LibraryDoc {
  id: string;
  /** Absolute path on the hub's machine. */
  path: string;
  /** Path relative to the Library root. */
  relPath: string;
  roomId: string;
  goalId?: string;
  frontMatter: DocFrontMatter;
  bytes: number;
  indexedAt: number;
}

// ---- 0.3 File access (spike)

/** A folder the owner lets an agent use. The hub is the only thing that touches the disk. */
export interface FolderGrant {
  id: string;
  /** Absolute, realpath-resolved. */
  path: string;
  label?: string;
  /** undefined = every room. */
  roomId?: string;
  /** "*" = any agent. */
  agentId: string;
  read: boolean;
  write: boolean;
  createdAt: number;
}

/** A write an agent asked for. Nothing touches the disk until the owner approves it. */
export interface WriteProposal {
  id: string;
  grantId: string;
  agentId: string;
  roomId?: string;
  relPath: string;
  /** SHA-256 of the file as it was when proposed; null = new file. */
  baseSha256: string | null;
  newSha256: string;
  /** Unified diff (stored truncated if very large). */
  diff: string;
  bytes: number;
  status: "pending" | "applied" | "rejected" | "conflict" | "expired";
  approvalId?: string;
  /** Why it ended in a state other than applied (revoked grant, hub restart, I/O error, ...). */
  reason?: string;
  createdAt: number;
  decidedAt?: number;
}

// ---- 0.2 Routing decision log, 0.5 Failure tags

/** Why a task came back: the MAST failure families (spec 42%, misalignment 37%, verification 21%), plus other. */
export type FailureTag = "spec" | "misalignment" | "verification" | "other";
export const FAILURE_TAGS: { id: FailureTag; label: string; hint: string }[] = [
  { id: "spec", label: "Spec", hint: "The task or goal was unclear, incomplete or contradictory, so the agent blocked, asked, or built the wrong thing." },
  { id: "misalignment", label: "Misalignment", hint: "The agent drifted from its task, went out of scope, or contradicted other agents' work or the room's decisions." },
  { id: "verification", label: "Verification", hint: "The agent called it done when it wasn't: its own checks passed what the reviewer or a command failed, or it skipped checking." },
  { id: "other", label: "Other", hint: "Crashes, timeouts, rate limits, or plain quality shortfalls that fit none of the above." },
];

/** One failure or send-back on a task. */
export interface FailureRecord { at: number; agentId: string; tag: FailureTag; note: string; routingId?: string }

/** Token and cost figures an adapter reports for one run. Anything unknown is left out, never guessed. */
export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** USD as the CLI reports it (for subscription runs this is the notional API price). */
  costUsd?: number;
}

/** How the orchestrator came to pick this agent. */
export type RoutingReason =
  | "learned"          // epsilon-greedy exploit: best expected score
  | "explore"          // epsilon-greedy explore: uniform random
  | "planned_owner"    // the plan named this agent and it was free
  | "revision"         // a revision stays with the same agent
  | "planner_choice"   // the planner answered "direct" and named the agent
  | "only_candidate"   // one agent connected
  | "command"         // 2.6: the owner typed /<agent>:<command>, so no policy chose
  | "shadow";         // 2.3: a probation agent practising on a copy of a real task

export interface RoutingCandidate {
  agentId: string;
  /** Expected quality from learned scores at decision time (optimistic prior for untried agents). */
  expected: number;
  /** Graded runs behind that expectation. */
  runs: number;
  /** Probability this agent would have been picked by the policy that made the decision. */
  p: number;
}

export type RoutingOutcome =
  | "pending" | "accepted" | "revise" | "reassign" | "run_failed" | "blocked" | "needs_input" | "interrupted" | "answered";

/** One routing decision and what came of it. Append-only history: the record for replay and kill-criteria reviews. */
export interface RoutingRecord {
  id: string;
  at: number;
  roomId: string;
  goalId: string;
  goalText: string;
  taskId: string;
  taskTitle: string;
  taskType: string;
  /** "task" = a planned task attempt; "direct" = a conversational answer with no plan; "shadow" (2.3) = a probation agent's practice copy of a real task. */
  kind: "task" | "direct" | "shadow";
  /** Attempt number on this task (1 = first try). */
  attempt: number;
  revision: boolean;
  reason: RoutingReason;
  epsilon: number;
  candidates: RoutingCandidate[];
  chosen: string;
  /** Probability of the chosen agent under the deciding policy (1 for deterministic picks). */
  pChosen: number;
  /** Agents excluded because they already tried this task. */
  excluded?: string[];
  profileId?: string;
  /** The model asked for (profile or agent setting). */
  modelRequested?: string;
  /** The model version the CLI reported actually running, when it says. */
  modelVersion?: string;
  usage?: RunUsage;
  /** Wall-clock seconds of the agent's run(s) for this attempt, retries included. */
  seconds?: number;
  outcome: RoutingOutcome;
  judgment?: { score: number; verdict: Judgment["verdict"]; judgeAgentId: string };
  failureTag?: FailureTag;
  failureNote?: string;
  completedAt?: number;
}

// ---- 1.9 Control files

/** One thing the linter or loader wants the owner to know about a control file. */
export interface ControlNotice {
  level: "block" | "flag";
  /** Path relative to the control folder, e.g. "agents/claude/SOUL.md". */
  file: string;
  /** 1-based line in that file, when known. */
  line?: number;
  message: string;
}

/** A change in the control folder's history. */
export interface ControlCommit { commit: string; author: string; at: string; message: string }

export interface ControlStatus {
  root: string;
  git: boolean;
  /** ISO time of the last load, or null before the first. */
  lastLoad: string | null;
  notices: ControlNotice[];
  lint: { blocks: ControlNotice[]; flags: ControlNotice[] };
}

// ---- 1.5 Scheduling that adapts to the hardware
export type CapacityTier = "small" | "medium" | "large";
/** How heavy an agent is on this machine. local-cli: a CLI process whose model runs in the cloud. */
export type AgentLocality = "local-model" | "local-cli" | "remote";

/** Owner overrides (OrchestratorSettings.capacity). Anything unset follows the detected hardware. */
export interface CapacitySettings {
  /** Most local tasks at once (local models and local CLIs; cloud agents don't count). */
  maxConcurrentTasks?: number;
  /** auto: on when the machine has room. */
  localModels?: "auto" | "on" | "off";
  /** Local CLI agents (Claude Code, Codex) running at once. */
  maxLocalCliAgents?: number;
  /** Biggest local model, in GB, the hub will start. */
  localModelMaxGB?: number;
  /** Free memory, in GB, a local model needs before it starts. */
  minFreeGB?: number;
  /** Total memory below this (GB) is a small machine. Default 12. */
  smallBelowGB?: number;
  /** Total memory at or above this (GB) is a large machine. Default 28. */
  largeFromGB?: number;
}
export interface OrchestratorSettings { capacity?: CapacitySettings }

export interface HardwareInfo {
  /** Memory in GiB, one decimal. */
  totalGB: number;
  freeGB: number;
  cores: number;
  /** Performance cores (Apple silicon). */
  perfCores?: number;
  appleSilicon: boolean;
  chip?: string;
  /** Marketing family when known, e.g. "MacBook Pro". */
  machine?: string;
}

export interface CapacityPlan {
  tier: CapacityTier;
  maxConcurrentTasks: number;
  maxLocalCliAgents: number;
  localModelsAllowed: boolean;
  localModelMaxGB: number;
  minFreeGB: number;
  reason: string;
}

export interface CapacitySnapshot {
  hardware: HardwareInfo;
  plan: CapacityPlan;
  running: { total: number; localModel: number; localCli: number; remote: number };
  /** Local work is at its limit: new tasks go to cloud agents. */
  atLimit: boolean;
  /** One line for the apps. */
  summary: string;
}
// ---- 1.6 Quota awareness

/** "subscription" = a plan with 5-hour and weekly windows; "api" = pay per token; "local" = runs on this Mac, free. */
export type SubscriptionKind = "subscription" | "api" | "local";
export type QuotaWindowId = "fiveHour" | "weekly";

/** What the owner says one window allows. Vendors don't publish remaining quota, so unknown means "learning". */
export interface QuotaWindowLimit { limitTokens?: number; limitRuns?: number }

/** A limit the hub worked out itself: Room usage at the moment a window's limit was hit. */
export interface LearnedLimit { tokens?: number; runs?: number; samples: number; at: number }

/** One place capacity comes from. Usage is tracked per subscription, not per agent (Hermes has two). */
export interface Subscription {
  id: string;
  provider: string;
  label: string;
  /** Plan name as the owner knows it ("Max 5x", "Plus"). */
  plan?: string;
  agentIds: string[];
  kind: SubscriptionKind;
  /** When an agent has several subscriptions, a run lands on this one if the model it ran matches (regex source, case-insensitive). */
  modelMatch?: string;
  windows: { fiveHour?: QuotaWindowLimit; weekly?: QuotaWindowLimit };
  /** Owner-set window boundaries (ms since epoch of any past window start). */
  resetAnchor?: { fiveHourStart?: number; weekStart?: number };
  /** Hub-managed: limits learned from observed rate limits, reset times a CLI reported, and a "limited until" mark. Owner edits don't overwrite it. */
  learned?: {
    fiveHour?: LearnedLimit;
    weekly?: LearnedLimit;
    anchors?: { fiveHourStart?: number; weekStart?: number };
    limitedUntil?: number;
    limitedWindow?: QuotaWindowId;
    /** When the hub marked it limited; a run that started before this finishing fine doesn't clear the mark. */
    limitedAt?: number;
  };
}

export interface QuotaWindowStatus {
  window: QuotaWindowId;
  usedTokens: number;
  usedRuns: number;
  limitTokens?: number;
  limitRuns?: number;
  /** Where the limit came from; undefined while the hub is still learning it. */
  limitSource?: "owner" | "learned";
  /** Unused share of the window, 0..1. Undefined while the limit is unknown. */
  headroom?: number;
  /** Unused share that will be lost at the reset; 0 when the reset is far off or the limit is unknown. */
  expiresSoon: number;
  start: number;
  resetsAt: number;
}

export interface SubscriptionStatus {
  subscription: Subscription;
  windows: { fiveHour: QuotaWindowStatus; weekly: QuotaWindowStatus };
  headroom?: number;
  expiresSoon: number;
  /** True when the hub expects a run on this subscription to be rate limited. */
  limited: boolean;
  limitedUntil?: number;
  limitedReason?: "reported" | "estimated";
  free: boolean;
}

export interface QuotaSettings {
  /** A free (local) agent is preferred when its expected quality is within this of the best candidate's. */
  freeMargin: number;
  /** Largest score bonus given to capacity that is about to expire. */
  expiryBonus: number;
  /** Treat a window as exhausted at this share used (0..1). */
  nearLimit: number;
}
export const QUOTA_DEFAULTS: QuotaSettings = { freeMargin: 0.05, expiryBonus: 0.05, nearLimit: 0.95 };

/** Why the router left an agent out or nudged it up, kept on the routing record. */
export interface QuotaNote {
  excluded: { agentId: string; subscriptionId: string; reason: "reported" | "estimated"; until?: number }[];
  boosted: { agentId: string; subscriptionId: string; bonus: number; reason: "free_tier" | "expiring" }[];
}

export interface QuotaReport {
  days: number;
  since: number;
  rateLimitFailures: number;
  /** Failures that happened while the hub's own estimate said the window was at its limit. The target is zero. */
  predicted: number;
  /** Failures the hub had no way to see coming (limit still unknown, or well under it). */
  unpredicted: number;
  bySubscription: Record<string, { label: string; rateLimitFailures: number; predicted: number; unpredicted: number }>;
}

// Added by 1.6: why the router left agents out or nudged them (optional, so older records stay valid).
export interface RoutingRecord { quota?: QuotaNote }

// ---- 1.2 Remote access over Tailscale
export type TailscaleState = "not_installed" | "stopped" | "needs_login" | "running";

/** What the Tailscale CLI says about this Mac. */
export interface TailscaleStatus {
  state: TailscaleState;
  /** Tailnet IPv4 (or IPv6 when there is no v4). */
  ip?: string;
  /** MagicDNS name without the trailing dot, e.g. blakes-mac.tail1234.ts.net. */
  dnsName?: string;
  tailnet?: string;
  /** What Tailscale Funnel is doing right now, read from the CLI. */
  funnel: {
    on: boolean; url?: string; extraPaths: string[];
    /** A funneled /mcp handler that proxies somewhere other than this hub's /mcp. `on` stays false for it. */
    wrongTarget?: string;
    /** Raw TCP forwards in Tailscale's serve config that end at this hub's port (traffic through them looks local). */
    forwards?: { port: number; target: string; public: boolean }[];
  };
  /** One plain sentence for the UI. */
  detail: string;
  checkedAt: number;
}

/** GET /remote/status: Tailscale's state plus what the owner asked for. */
export interface RemoteStatus extends Omit<TailscaleStatus, "funnel"> {
  /** Best host to give other devices: MagicDNS name, else tailnet IP. */
  host?: string;
  /** Hub address on the tailnet, e.g. http://blakes-mac.tail1234.ts.net:4747 */
  hubUrl?: string;
  funnel: {
    /** Funnel is exposing /mcp right now (per Tailscale). */
    on: boolean;
    /** Public address of /mcp while on. */
    url?: string;
    /** What the owner asked for in the hub (off by default). */
    intent: boolean;
    /** Set when Tailscale and the hub disagree. The hub only reports this; it never changes Funnel by itself. */
    drift?: "on_in_tailscale" | "off_in_tailscale" | "wrong_target";
    /** With drift "wrong_target": where Tailscale's /mcp handler really points. */
    wrongTarget?: string;
    /** Other paths or raw TCP that Funnel exposes on the same port. Anything here is a problem. */
    extraPaths: string[];
  };
  /** Loud problems the owner must fix, in plain words (for example a raw TCP forward to the hub). Empty when all is well. */
  warnings: string[];
}

// ---- 1.1 Local file access
// These interfaces extend ones declared above (TypeScript merges same-named interfaces), so the spike's own definitions stay untouched.

/** Set when the owner granted a folder that is normally off limits (credentials, system or hub folders), with the reason they gave. */
export interface FolderGrant {
  override?: { reason: string; at: number; /** What made the folder protected, in plain words. */ because: string };
}

/** Body of POST /folder-grants (1.1). `force` + `reason` are needed only for folders the hub normally refuses. */
export interface FolderGrantInput {
  path: string; label?: string; roomId?: string; agentId: string; read?: boolean; write?: boolean;
  force?: boolean; reason?: string;
}
/** Body of PUT /folder-grants/:id (1.1). Only what is sent changes. The path itself never changes: remove the grant and add a new one. */
export interface FolderGrantUpdate { label?: string; roomId?: string | null; agentId?: string; read?: boolean; write?: boolean }

/** Error body for a refused grant: `canForce` tells the UI whether to offer "Grant anyway" (it then asks for a reason). */
export interface GrantRefusal { error: string; code: "protected_folder" | "hard_refused" | "invalid"; canForce: boolean; because?: string }

/** The approval card for a file write names its proposal, so a UI can fetch the whole diff from GET /write-proposals/:id. */
export interface Approval { proposalId?: string }

/** One file in a proposal that changes several (a task's accepted work written back to a granted folder). */
export interface WriteProposalFile {
  relPath: string;
  op: "create" | "edit" | "delete";
  baseSha256: string | null;
  /** null = the file is deleted. */
  newSha256: string | null;
  bytes: number;
}
export interface WriteProposal {
  /** "file" = one file an agent proposed through MCP; "task" = everything one task changed, one approval. */
  kind?: "file" | "task";
  goalId?: string;
  taskId?: string;
  title?: string;
  /** kind "task": every file, in order. The diff covers all of them. */
  files?: WriteProposalFile[];
  /** kind "task": files that could not be proposed (binary, too large, symlink...) and why. The owner should know. */
  skipped?: { relPath: string; reason: string }[];
  /** Set when the owner will see that this cannot be applied as asked (the agent is never told why on a write-only grant). */
  unappliable?: string;
  /** What the agent asked for, in its own spelling. Agents see this instead of the resolved path. */
  askedPath?: string;
  /** True when the diff was shortened to save space after the proposal was settled. */
  diffDropped?: boolean;
}

/** A task's accepted work on a goal that targets a granted folder (1.1). */
export interface Goal {
  /** The folder grant this goal works on. Tasks read from it and (when it is writable) their accepted work returns to it. */
  sourceGrantId?: string;
  /** Git folders: the branch accepted work lands on (never the owner's checked-out branch). */
  sourceBranch?: string;
}

/** What GET /mcp-tokens lists. Never the key itself: only a hash is kept. */
export interface McpTokenInfo {
  id: string;
  agentId: string;
  name: string;
  /** When set, the key only works as that room: room-scoped folder grants apply and every room argument is pinned to it. */
  roomId?: string;
  createdAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  expired: boolean;
}
export interface McpTokenCreated extends McpTokenInfo { token: string; url: string }

/** The key is shown once, when it is made or rotated. Later reads of a connection leave `token` empty and set this. */
export interface McpConnection { tokenHidden?: boolean }

// ---- 1.3 Agent discovery and capability map

/** What an agent's own platform lets it reach. Written by discovery (and the owner's declarations), copied into TOOLS.md `platform`. */
export interface AgentCapabilities {
  /** Connectors the agent has, as ids: gmail, slack, drive, salesforce when they are one of the Room's tools, else a short name. */
  connectors: string[];
  /** Business data it can read: a subset of the connectors (salesforce, snowflake, gmail, drive, slack, ...) plus anything the owner declared. */
  dataSources: string[];
  /** Skill (or custom prompt) names, names only. */
  skills: string[];
  /** Native tool families it brings (web, filesystem, shell). */
  tools: string[];
  /** Data sources the owner says this agent has. Discovery never overwrites these. */
  declared?: string[];
  discoveredAt?: number;
}
export interface AgentConfig { capabilities?: AgentCapabilities }
/** Data sources or connectors a task needs ("salesforce", "gmail", "snowflake"). Only agents that have them are routed the task. */
export interface Task { needs?: string[] }
/** Why the pool was narrowed for a task that has needs. */
export interface RoutingRecord { needs?: string[]; needsFilteredOut?: { agentId: string; missing: string[] }[] }

export type LocalServerKind = "llama.cpp" | "ollama" | "lm-studio" | "openai-compatible";
/** A model server answering on this Mac. */
export interface LocalModelServer {
  id: LocalServerKind;
  label: string;
  /** OpenAI-compatible base URL, ending in /v1. */
  baseUrl: string;
  port: number;
  models: string[];
  /** The agent that is configured to use it (Hermes), when there is one. */
  usedBy?: string;
}

export interface DiscoveredAgent {
  id: string;
  name: string;
  provider: string;
  adapter: AdapterKind;
  installed: boolean;
  /** null: installed but sign-in couldn't be confirmed. */
  signedIn: boolean | null;
  detail: string;
  /** Settings to create the agent with (and facts to refresh on an existing one). */
  settings: Record<string, unknown>;
  capabilities: AgentCapabilities;
  /** False when the agent's own config couldn't be read, so an empty list means "unknown", not "none". */
  capabilitiesKnown: boolean;
  /** A new agent is switched on when true. Local model servers start off until the owner turns them on. */
  defaultEnabled: boolean;
}

export interface DiscoveryResult {
  at: number;
  agents: DiscoveredAgent[];
  servers: LocalModelServer[];
  /** One line for the apps: "Found: Claude Code (signed in), Codex (signed in), Hermes, llama.cpp with qwen". */
  summary: string;
  /** What happened when the hub applied it: agents created, capability changes, Hermes connection. */
  applied?: { created: string[]; updated: string[]; hermes?: { status: string; detail: string; configPath?: string; backupPath?: string } };
}
export interface DiscoverySettings {
  /** Write the hub's MCP entry into Hermes's config on its own. On by default. */
  connectAutomatically: boolean;
}
export interface DiscoveryState { last: DiscoveryResult | null; settings: DiscoverySettings; running: boolean }

/** What POST /agents/:id/invite returns: everything a device needs to join over MCP, in one call. */
export interface McpInvite {
  agentId: string;
  name: string;
  /** MCP URL on the tailnet (MagicDNS name when there is one). */
  url: string;
  /** The new key, shown once. Empty when this agent's key was already handed out (see tokenHidden). */
  token: string;
  /** True when the key was already handed out: nothing is replaced, and POST .../invite { rotate: true } makes a new one. */
  tokenHidden?: boolean;
  /** Copy-paste text for the agent's owner: URL, header, and what to tell the agent. */
  block: string;
  /** The same standing instructions as the MCP connection screen. */
  instructions: string;
}

// ---- 1.7 Installable app
/** Where an in-app CLI sign-in is (POST/GET /setup/signin/:agent). */
export type SignInState = "idle" | "installing" | "starting" | "waiting" | "done" | "failed" | "cancelled";
export interface SignInView {
  agent: string;
  state: SignInState;
  /** browser: the CLI's own OAuth page; device: a one-time code typed into a web page. */
  method?: "browser" | "device";
  /** The sign-in page to open. Only ever an https address on the provider's own domain. */
  url?: string;
  /** One-time device code, when the CLI asked for one. */
  code?: string;
  /** The CLI is asking for a code pasted back (Claude Code does this when its browser can't reach the local callback). */
  needsPaste?: boolean;
  /** Set when the sign-in was handed to Terminal instead (the fallback button). */
  terminal?: boolean;
  /** One plain sentence for the UI. */
  message: string;
  updatedAt: number;
}
/** The setup timer (KV `setup.started`, `setup.first_goal_done`), in GET /setup. */
export interface SetupTimer {
  startedAt?: number;
  firstGoalDoneAt?: number;
  /** Seconds from first launch to the first finished goal; while the goal is still to come, seconds so far. */
  elapsedSeconds?: number;
  done: boolean;
  /** The first finished goal ran on practice agents, so it says nothing about a real first goal. */
  firstGoalPractice?: boolean;
}

// ---- 1.1 integration: what the apps read from the folder and write-proposal routes
/** One row of GET /write-proposals: no diff (that is GET /write-proposals/:id), with its size instead. */
export type WriteProposalSummary = Omit<WriteProposal, "diff"> & { diffBytes: number };
/** POST /folder-grants/check: would this folder be accepted? Nothing is stored. */
export type FolderCheck =
  | { ok: true; root: string; protected: boolean; because?: string }
  | { ok: false; error: string; canForce: boolean };

// ---- 2.4 scores per model version
/** An agent's track record on one task type under one model version. `quality` is the running mean (failed runs count as 0). */
export interface VersionScore extends AgentScore {
  /** Normalised model version key, e.g. "claude-opus-5-5-20261001", or "unknown". */
  modelVersion: string;
  /** Sum of squared deviations of per-run quality from the mean (Welch's online update), for the shift test. */
  m2: number;
  firstSeen: number;
  lastSeen: number;
}
/** One entry of GET /model-shifts (KV `model_shifts`). `version_change` is the quiet record of a new version; `shift` is a significant change in results. */
export interface ModelShift {
  id: string;
  at: number;
  kind: "version_change" | "shift";
  agentId: string;
  /** Set for `shift`; a version change covers the whole agent. */
  taskType?: string;
  from: string;
  to: string;
  /** Mean quality and failure rate on each version, and the number of runs behind them (`shift` only). */
  fromQuality?: number; toQuality?: number;
  fromFailRate?: number; toFailRate?: number;
  fromRuns?: number; toRuns?: number;
  /** Welch t-test p for the quality difference (`shift` only). */
  p?: number;
  /** Why it was flagged: the quality test, or a change in failure rate. */
  trigger?: "quality" | "failures";
  /** The line posted in the general room (`shift`), or a plain description (`version_change`). */
  text: string;
}
/** GET /scores/versions: one row per agent, task type and model version, with the weight the version's evidence has now. */
export interface VersionScoreRow extends VersionScore {
  /** True for the version the agent last ran on. */
  current: boolean;
  /** Weight per run in the expected score (1 for the current version). */
  weight: number;
}

// ---- 2.2 Blind cross-vendor juries
/** OrchestratorSettings.jury. Default: on when enough model families are ready; size 3, one local judge, three families. */
export interface JurySettings {
  /** Unset: on when at least `minFamilies` distinct families are ready. false switches it off. */
  enabled?: boolean;
  /** Judges per jury (2 to 5; 3 by default). */
  size?: number;
  /** One judge must be a local model when one is ready. */
  requireLocal?: boolean;
  /** Distinct model families (other than the worker's) a jury needs. */
  minFamilies?: number;
}
export interface OrchestratorSettings { jury?: JurySettings }

/** One judge's read, as kept in the jury record. */
export interface JuryJudgeRecord {
  agentId: string;
  /** anthropic, openai, google, meta, nous, or local-<model>. */
  family: string;
  local: boolean;
  model?: string;
  score: number;
  verdict: Judgment["verdict"];
  criteria: Record<string, Verdict>;
  /** Set when the owner rates the judgment: |judge score - owner score|. */
  distance?: number;
}

/** How much the judges agreed. */
export interface JuryAgreement {
  /** Share of judges that voted with the aggregate verdict (2 of 3 = 0.67). What the apps show. */
  majority: number;
  /** Share of judge pairs with the same verdict. */
  pairwise: number;
  /** Fleiss' kappa over the criterion verdicts; null with fewer than 2 criteria or judges, or when it can't be told. */
  kappa: number | null;
  /** Highest score minus lowest. */
  spread: number;
}

/** juries table, GET /juries. One row per judgment: a real jury, one extra reviewer, or the single judge used when a jury couldn't be formed. */
export interface JuryRecord {
  id: string;
  taskId: string;
  goalId: string;
  at: number;
  /** jury = several families; second = the extra reviewer after an UNSURE; fallback = one judge, the reason says why. */
  kind: "jury" | "second" | "fallback";
  reason?: string;
  /** Asked for a local judge but none could be used. */
  noLocal?: string;
  worker: string;
  workerFamily: string;
  /** Agent id that rewrote the output, or "mechanical" (no model), or "none". */
  rewriter: string;
  rewriterNote?: string;
  judges: JuryJudgeRecord[];
  aggregate: { score: number; verdict: Judgment["verdict"]; criteria: Record<string, Verdict>; drift?: string };
  agreement: JuryAgreement;
  /** The judges didn't agree on accept or revise. */
  split: boolean;
  /** The owner's spot rating and how far the jury was from it (each judge's own distance is on `judges`). */
  owner?: { score: number; at: number; juryDistance: number };
}

/** What stays on the task's judgment so the apps can draw the chips without another fetch. */
export interface JuryInfo {
  id: string;
  kind: JuryRecord["kind"];
  reason?: string;
  judges: { agentId: string; family: string; local: boolean; verdict: Judgment["verdict"]; score: number }[];
  agreement: JuryAgreement;
  split: boolean;
}
export interface Judgment { jury?: JuryInfo }
/** The routing record's judgment, with a jury, names its judges comma-joined in judgeAgentId; this is the juries row (GET /juries?taskId=). */
export interface RoutingRecord { juryId?: string }

/** KV `jury_calibration`, GET /jury/stats: how far judges are from the owner's spot ratings. Running means of |judge score - owner score|. */
export interface JuryCalibration {
  /** Judgments the owner rated that had a jury record. */
  n: number;
  /** Juries (several judges): count and mean distance of the aggregate score. */
  juryN: number;
  juryAbsErr: number;
  /** Single judges used when no jury could be formed. */
  singleN: number;
  singleAbsErr: number;
  /** Judges that shared the worker's family (kill criterion: cross-vendor vs same-vendor). */
  sameFamilyN: number;
  sameFamilyAbsErr: number;
  /** Every judge's own distance, by model family. */
  byFamily: Record<string, { n: number; absErr: number }>;
}

/** Store event when the judges disagree on accept or revise (2.7 interrupts on it). Emitted with store.emit("event", ...). */
export interface JurySplitEvent {
  type: "jury_split";
  at: number;
  taskId: string;
  goalId: string;
  juryId: string;
  verdict: Judgment["verdict"];
  judges: { agentId: string; family: string; verdict: Judgment["verdict"]; score: number }[];
}

// ---- 2.6 slash commands from agent skills
export type CommandKind = "skill" | "prompt" | "command" | "plugin-skill";
/** How the command reaches the agent: its own `/name args` text, the prompt file's content inlined, or a plain instruction to use the skill. */
export type CommandMode = "slash" | "inline" | "instruction";
/** One command in the index. `name` is the namespaced form without the leading slash, e.g. "claude:board-deck". */
export interface CommandEntry {
  name: string;
  agentId: string;
  kind: CommandKind;
  title: string;
  description: string;
  argsHint?: string;
  /** The file it came from (kept on this Mac; GET /commands does not send it). */
  source: string;
  /** What the agent itself calls it, e.g. "board-deck", "my-plugin:review" or "prompts:review-pr". */
  native: string;
  mode: CommandMode;
}
export interface CommandIndex { at: number; agents: { id: string; label: string }[]; entries: CommandEntry[] }
/** One row in the palette. */
export interface CommandRow { name: string; title: string; description: string; argsHint?: string; kind: CommandKind | "room" }
/** A palette group: "room" first, then one per agent. */
export interface CommandGroup { id: string; label: string; commands: CommandRow[] }
/** GET /commands. */
export interface CommandsResponse { at: number; groups: CommandGroup[] }
/** What a task was started by: recorded on the task so the log shows the skill that ran. */
export interface TaskCommand { name: string; agentId: string; kind: CommandKind; mode: CommandMode; args: string }
export interface Task { command?: TaskCommand }
// ---- 2.1 Retros and playbooks
/** A lesson the orchestrator wrote after a goal (the `lessons` table; the same text is a bullet in agents/<id>/LESSONS.md). */
export interface Lesson {
  id: string;
  agentId: string;
  taskType: string;
  text: string;
  goalId: string;
  /** When it was written. */
  at: number;
  /** In use: shown to the agent on later tasks of this type. */
  active: boolean;
  /** Taken out by condensing (merged into another lesson, or too old). Owner deletions are inactive but not retired. */
  retired: boolean;
}

/** One calendar week (ISO, Monday to Sunday, UTC) of first-pass acceptance. */
export interface FirstPassWeek {
  /** ISO week, e.g. "2026-W43". */
  week: string;
  /** The Monday it starts on, YYYY-MM-DD. */
  start: string;
  /** Tasks whose first attempt finished this week. */
  tasks: number;
  /** Of those, how many were accepted on the first attempt. */
  accepted: number;
  /** accepted / tasks, or null when there were no tasks. */
  rate: number | null;
  /** Send-back revisions on those tasks, per task (null when there were no tasks). */
  revisionsPerTask: number | null;
  /** The week is the phase start week or later. */
  sincePhase: boolean;
}

/** GET /metrics/first-pass */
export interface FirstPassMetrics {
  weeks: number;
  /** KV `phase2_started_at`: the first time the hub ran with retros. The trend is measured from here. */
  phaseStartedAt: number;
  phaseStartWeek: string;
  overall: FirstPassWeek[];
  byAgent: Record<string, FirstPassWeek[]>;
  byTaskType: Record<string, FirstPassWeek[]>;
  /** Everything from the phase start on. */
  sincePhase: { tasks: number; accepted: number; rate: number | null; revisionsPerTask: number | null };
}

// ---- 2.5 memory with sources and expiry; export
export type MemorySourceKind = "goal" | "owner" | "agent";
/** Where a fact came from. `id` is the goal id for a goal, or the agent's own note about where it learned it. */
export interface MemorySource { kind: MemorySourceKind; id?: string; agentId?: string; at: number }
/** How long a kind of memory stays true: facts, preferences ("prefers short answers"), status ("currently on the Q4 deck"). */
export type MemoryKind = "fact" | "preference" | "status";
export interface MemoryTtlDays { fact: number; preference: number; status: number }
export const MEMORY_TTL_DEFAULTS: MemoryTtlDays = { fact: 90, preference: 365, status: 14 };
export const MEMORY_EXPORT_BYTES_DEFAULT = 4096;

export interface MemoryEntry {
  /** Every fact has one (2.5). Rows from before 2.5 are migrated to `{ kind: "agent" }`. */
  source: MemorySource;
  /** Epoch ms, the end of a UTC day. Past it the fact is expired: kept in the database for 30 days, never shown to agents. */
  expiresAt: number;
  /** The fact this one replaced (the owner answered a contradiction question with "take the new one"). */
  supersedes?: string;
  /** What the keeper classified it as; decides the default expiry. */
  memKind?: MemoryKind;
}

export interface MemoryProposal {
  source?: MemorySource;
  /** An expiry the proposing agent suggested. The keeper decides. */
  expiresInDays?: number;
  memKind?: MemoryKind;
  /** The approval card holding the owner's question while `status` is `asked`. */
  questionId?: string;
}

/** A question for the owner that needs one of several answers, not a yes or no. Today only memory contradictions. */
export interface MemoryQuestion {
  kind: "memory";
  /** The stored fact that is contradicted. */
  oldId: string;
  /** The proposal holding the new wording. */
  proposalId: string;
  choices: { id: "keep_old" | "take_new" | "drop_both"; label: string }[];
}
export interface Approval {
  /** Set on a question card (both apps show it in Approvals). Answer with POST /approvals/:id { choice }. */
  question?: MemoryQuestion;
  /** The answer the owner gave (one of question.choices). */
  choice?: string;
}

export interface OrchestratorSettings {
  /** Days a memory stays valid by kind. Default fact 90, preference 365, status 14. */
  memoryTtlDays?: MemoryTtlDays;
  /** Cap, in bytes, of the memory block written into an agent's own context file. Default 4096. */
  memoryExportBytes?: number;
}

/** GET /memory/export: what the export switch for each agent does (the apps show it next to the switch). */
export interface MemoryExportInfo {
  agentId: string;
  /** False for agents with no context file we know how to write (they get no switch). */
  supported: boolean;
  /** The one file that is written, with ~ for the home folder. */
  file?: string;
  /** Bytes the block may take in that file. */
  capBytes?: number;
  enabled: boolean;
  /** Why it can't write right now (folder missing, markers damaged), or a caution. */
  note?: string;
  lastWrittenAt?: number;
}

// ---- 3.2 Personas
/** An agent's persona: how it presents itself (SOUL.md). Not a résumé: it never says what the agent is good at. */
export interface Persona {
  name: string;
  /** Hex colour like #6B4FD8. */
  color: string;
  /** One letter or emoji shown on the avatar. Empty: the first letter of the name. */
  avatar?: string;
  /** What the agent does, in a few words. */
  role: string;
  /** How it sounds, in a few words. */
  tone: string;
  /** Bio and voice notes (the SOUL.md body). */
  body: string;
}
/** GET /agents/:id/persona */
export interface PersonaView extends Persona {
  agentId: string;
  /** control: it is agents/<id>/SOUL.md in the control folder. agent: it is kept in the agent's record (no control folder). */
  source: "control" | "agent";
  /** The starter template this persona still matches word for word, or null. */
  template: string | null;
  /** SOUL.md's `updated` date, when it comes from the file. */
  updated?: string;
}
/** PUT /agents/:id/persona. Fields left out keep their current value. `template` fills role, tone and body from a starter first. */
export interface PersonaInput extends Partial<Persona> { template?: string }
/** GET /personas/templates */
export interface PersonaTemplate {
  id: string;
  label: string;
  /** One line for the picker. */
  summary: string;
  role: string;
  tone: string;
  body: string;
}
export interface AgentConfig { avatar?: string }
// ---- 2.3 Résumés and probation
/** Graded runs a new agent needs before it does real work (OrchestratorSettings.probationRuns). Shadow runs count. */
export const PROBATION_RUNS_DEFAULT = 5;
export interface OrchestratorSettings {
  /** Graded runs (real or shadow) an agent needs to finish probation. Default 5. */
  probationRuns?: number;
}

/** An agent's track record on one task type, from its graded runs (routing log). */
export interface ResumeTypeRow {
  taskType: string;
  /** Graded runs the numbers below come from. */
  runs: number;
  /** Mean judged quality, 0..1. */
  quality: number;
  /** Tasks it worked on, and how many were sent back after its first attempt. */
  tasks: number;
  sentBack: number;
  /** Share of tasks accepted on the first attempt; null with no tasks. */
  firstPass: number | null;
  /** Send-back revisions it was given. */
  revisions: number;
  /** Runs that crashed, timed out or were never graded. */
  runFailures: number;
  /** How many of the graded runs were shadow runs. */
  shadowRuns: number;
  /** What sent its first attempts back most often. */
  topFailure?: FailureTag;
  /** True when the numbers are the current model version's alone (it has enough runs of its own). */
  currentVersionOnly: boolean;
}

/** Where an agent stands on probation. `graded` counts runs since `since`. */
export interface ProbationStatus {
  on: boolean;
  graded: number;
  needed: number;
  since?: number;
  /** How it started: a new agent, or the owner restarted it. */
  startedBy?: "new" | "owner";
  endedAt?: number;
  /** How it ended: reached the threshold, or the owner ended it. */
  endedBy?: "threshold" | "owner";
  /** Mean quality of the runs that counted (set once it ends). */
  mean?: number | null;
  /** Of the counted runs, how many were shadow runs. */
  shadowRuns: number;
}

/** GET /agents/:id/resume, GET /resumes. What RESUME.md says, as data. Never shown to an agent. */
export interface AgentResume {
  agentId: string;
  name: string;
  at: number;
  /** Graded runs in all (real and shadow). */
  runs: number;
  shadowRuns: number;
  strengths: string[];
  weaknesses: string[];
  byType: ResumeTypeRow[];
  /** All tasks: share accepted on the first attempt, and send-backs per task. */
  firstPass: number | null;
  revisionsPerTask: number | null;
  failureMix: Record<FailureTag, number>;
  /** Juries that judged its work, how much the judges agreed (majority share), how many split. */
  jury: { n: number; majority: number; splits: number } | null;
  /** The owner's spot ratings of its work, against what the judges said. */
  owner: { n: number; ownerMean: number; judgeMean: number; meanDistance: number } | null;
  /** Model versions it ran on, current first. */
  modelVersions: string[];
  currentVersion?: string;
  lessons: string[];
  probation: ProbationStatus;
  /** The RESUME.md text this would be written as (with the front matter). */
  markdown: string;
}

export interface RoutingRecord {
  /** 2.3: set on a probation agent's practice run. Such a run is never merged and never visible in the room. */
  shadow?: boolean;
  /** 2.3: the real task this practice run copied. */
  shadowOf?: string;
}
