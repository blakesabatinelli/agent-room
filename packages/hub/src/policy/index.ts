// 4.2 Learned approval policy and permission leases: readable rules in POLICY.md learned from the owner's approvals, and access that expires.
export { PolicyEngine, GOAL_LEASE_CEILING_MS, MAX_LEASE_MINUTES, type Decision, type Effect, type Lease, type LeaseInput, type LeaseResult, type PolicyHost } from "./engine.js";
export { learn, learnedId, describeProposal, LEARN_DEFAULTS, FORGET_DAYS, type LearnConfig, type Proposal } from "./learn.js";
export { parseMatch, formatMatch, matches, matchFor, type Match, type ParsedMatch } from "./match.js";
export { shapeOf, verbOf, twoKeyClass, commandPrefix, type Shape } from "./shape.js";
export { registerPolicyRoutes, type PolicyRoutesHost } from "./routes.js";
