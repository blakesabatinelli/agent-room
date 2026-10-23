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
  status: "pending" | "accepted" | "rejected" | "merged";
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
  | "only_candidate";  // one agent connected

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
  /** "task" = a planned task attempt; "direct" = a conversational answer with no plan. */
  kind: "task" | "direct";
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
  funnel: { on: boolean; url?: string; extraPaths: string[] };
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
    drift?: "on_in_tailscale" | "off_in_tailscale";
    /** Other paths or raw TCP that Funnel exposes on the same port. Anything here is a problem. */
    extraPaths: string[];
  };
}
