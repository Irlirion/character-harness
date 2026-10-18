# RFC: Character Harness as an Agent-Optimizing Runtime

**Status:** Proposed  
**Project:** [Irlirion/character-harness](https://github.com/Irlirion/character-harness)  
**Date:** 2026-10-17  
**Scope:** Architecture and responsibility boundary; deliberately **excludes** selection or integration of Jev-like decision models.  
**Proposed location:** `docs/rfc/agent-autonomy-boundary.md`

## 1. Executive decision

> **Harness оптимизирует то, как агент думает и действует. Агент определяет, о чём думать, чего добиваться и что делать.**

Character Harness evolves from an event-driven character reply orchestrator into a **persistent, efficient execution environment for autonomous agents**. Its value is not merely sandboxing and enforcing permissions: it supplies managed context, durable memory, capability discovery, reusable skills, environmental observations, execution lifecycle and resources.

The harness **must not contain a global planner, assign the character intrinsic goals, rank those goals on its own, or silently rewrite intent**. An agent owns its motivation, goals, plans, preferences, self-initiated activities and decisions. The harness owns correct, efficient, auditable and authorized execution.

**Four invariants:**

1. **Agent owns intent.** Only an agent chooses its self-originated goals and priorities; external assignments are clearly attributed.
2. **Harness owns execution efficiency.** Context, retrieval, caching, skills execution, durable operations and resource allocation are managed infrastructure.
3. **Environment owns truth.** Actual game state and external API results supersede agent beliefs; observations may be stale or incomplete.
4. **Policy owns authority.** Permissions, identity, data visibility, hard quotas and destructive-action requirements are enforced outside the model and are not editable by the agent.

## 2. Motivation and current implementation

Today `apps/engine/main.ts` and `apps/codex-engine/main.ts` poll `/engine/input` and normally invoke a model only when an event is present. Each event creates a short-lived session; turns have a 90-second deadline. A Minecraft turn ends via `turn_finish`; Telegram decisions are `reply` or `silence`. Tools are explicitly allowlisted per engine. Current MCP operations include `agent_observe`, `agent_walk`, `agent_turn`, `agent_action_status`, memory tools and Telegram history; client actions are bounded and fenced. PostgreSQL already stores social memory, events, action states and replies. These are valuable safety foundations.

The existing `docs/persistent-agents.md` proposes responsibilities, wakeups and a scheduler; `docs/capability-workshop.md` proposes skill lifecycle. They are **proposals, not a complete shipped autonomous runtime**. This RFC turns those concepts into a platform boundary without turning core into a personality-level supervisor.

### Problems to solve

- No inbound event generally means no new agent work; background work cannot naturally persist beyond a response turn.
- An LLM turn, public reply and long-running activity are conflated.
- Context assembly is coupled to input event rather than to a durable activity and its information needs.
- Capability allowlists inside engine processes impede safe dynamic discovery.
- Memory tools support social recall but not full persistent workspace, agent-owned knowledge organization or explicit compaction contracts.
- Minecraft movement primitives lack a generalized durable operation interface needed for long-running skills.
- A fixed cognitive workflow in core would constrain different personalities and engine implementations.

## 3. Goals and non-goals

### Goals

- Let agents independently initiate, defer, resume, revise and terminate **their own** activities within external permissions and budgets.
- Give each agent a durable workspace with private plans, notes, projects, skills and checkpoints.
- Improve information-to-token ratio via scoped retrieval, compaction, provenance and tool-schema selection.
- Unify environmental observations and asynchronous operations, including a potential UnionClef adapter.
- Permit multiple engine implementations (Pi, Codex, future engines) without binding an agent identity to one model session.
- Preserve existing audience isolation, pause/epoch fencing, observed execution results and owner authority.
- Measure efficiency and behavior without prescribing goals.

### Non-goals

- Build a universal centralized strategic planner in core.
- Force all characters to use one file structure, planning algorithm, reflection schedule or motivation model.
- Claim that a model's actions or memories are always correct.
- Allow autonomous permission escalation, arbitrary host execution or unreviewed destructive external actions.
- Require a permanent spinning LLM process or continuous token generation.
- Bundle a particular decision-model family, including Jev, into this architecture RFC.

## 4. Responsibility boundary

| Concern | Harness owns | Agent owns | Hard boundary |
|---|---|---|---|
| Intent | Durable representation, attribution and audit | Goals, motivation, plans, priorities | Harness cannot change an agent-owned goal silently |
| Context | Retrieval, compaction, ranking, token allocation, source links | Requests more context; pins critical data | Pinned instructions/commitments not silently dropped |
| Memory | Storage, indexing, dedup candidates, provenance, visibility | Interpretations, importance, personal knowledge edits | Raw events immutable under retention policy; interpretations not treated as verified fact |
| Tools | Discovery, schema, routing, invocation, retries by contract | Tool choice and arguments | Every invocation subject to runtime policy |
| Skills | Registry, sandbox, tests, versions, bounded execution | Creation, composition, selection, improvement | Skills cannot acquire new authority |
| Environment | Typed observation/event adapters, staleness, operation reconciliation | Interpret state and choose actions | External source is authoritative |
| Execution | Durable activities, wakeups, locks, checkpoints, recovery | Initiate, schedule, suspend, continue work | Pause, budgets and policy can block execution |
| Models | Adapters, reliability, budgets, observability, optional routing | Requests required capabilities within allowance | Changing models must not silently change identity or permissions |
| Social | Routing, visibility, delivery state | Reply, silence, initiation within policy | Cross-audience data never leaks by default |

**Test for boundary placement:** If a feature changes *how* a chosen operation is carried out, it belongs in the harness. If it changes *which goal should exist* or the intended outcome, it belongs to the agent. Safety refusal, pausing and external assignments are explicit exceptions backed by policy/authority, not hidden cognitive policy.

## 5. Target architecture

```text
                       AGENT MIND
         identity · preferences · goals · reasoning
                 Pi / Codex / other
                          |
                   Agent Runtime API
                          |
                 CHARACTER HARNESS
   +--------------------------------------------------+
   | Context Engine           Memory Engine           |
   | Capability Registry      Skill Runtime           |
   | Environment Manager      Execution Manager       |
   | Resource & Policy Manager                         |
   | Persistent Workspace + Event Journal + Telemetry |
   +--------------------------------------------------+
           |                 |                |
      Minecraft adapter  Telegram adapter  Other MCP
       (UnionClef)      (voice/chat)     / external APIs
```

Prefer **modular core + separate Pi/Codex engine + isolated skills runner**, not seven microservices. APIs are contracts, not mandatory deployment boundaries.

## 6. Domain model and lifecycle

Distinguish these durable identities:

- **Agent**: stable identity, owner, workspace, preferences, memories and permission scope.
- **Activity**: goal-directed work, potentially initiated by the agent, an owner assignment or an external event. Survives turns and restarts.
- **Turn**: bounded model invocation. Several turns may belong to one activity; an activity need not use a model every second.
- **Operation**: asynchronous externally observable action with idempotency semantics, lease, deadline, external reference and reconciliation status.
- **Wakeup**: durable trigger registered by the agent or system (`at_time`, `on_event`, `on_operation_result`, `external_message`).
- **Checkpoint**: compact structured record of agent-owned work state, pending operations, source-linked facts and context pins.

### Activity state machine

`ready -> running -> waiting_time | waiting_event | waiting_operation | needs_input | completed | failed | cancelled`.

`paused` is a **platform-level override** and must not be silently resumed by the agent. Transitions are atomic and fenced with an epoch; owner pause revokes active leases and cancels or attempts to cancel eligible external actions. Explicitly model `unknown` external outcomes; do not assume exactly-once delivery when APIs do not support it.

A finished social response **does not imply** activity completion. `reply/silence` is a channel-output decision; `activity_wait/continue/complete` is an execution-lifecycle decision.

### Example contracts (illustrative)

```typescript
type ActivityOrigin = 'self' | 'owner' | 'external_event';
type ActivityStatus = 'ready' | 'running' | 'waiting_time' | 'waiting_event'
  | 'waiting_operation' | 'needs_input' | 'completed' | 'failed' | 'cancelled';

interface Activity {
  id: string;
  agentId: string;
  origin: ActivityOrigin;
  requestedBy?: string;
  objective: string;             // Agent-owned unless an attributable assignment
  status: ActivityStatus;
  checkpointRef?: string;
  nextWakeupId?: string;
  budgetRef: string;
  version: number;
}

interface AgentWorkDecision {
  activityId: string;
  action: 'continue' | 'wait_until' | 'wait_event' | 'wait_operation'
    | 'request_input' | 'complete';
  wakeAt?: string;
  eventFilter?: unknown;
  operationId?: string;
  checkpointRef?: string;
}

interface Operation {
  id: string;
  activityId: string;
  capability: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  epoch: number;
  invocationId: string;
  deadlineAt: string;
  evidenceRef?: string;
}
```

All capability operations must specify **side effects**, cancellation guarantees, reconciliation mechanism and replay policy. On restart do not reissue a possibly completed side-effect without checking its status.

## 7. Subsystem contracts

### 7.1 Context Engine

- Assemble context per **activity + turn**, not only per incoming message.
- Use current observations, relevant memory, pinned goals/commitments and a scoped subset of tool definitions.
- Budget context by source, not only with naive truncation; annotate freshness, audience and provenance.
- Cache stable persona/policy segments where engines support caching.
- Support reversible summaries with source references; raw source remains retrievable within retention limits.
- Provide `context.inspect`, `context.search_more`, `context.pin/unpin` to agent within quotas.
- Never let retrieval results or environmental text override policy or higher-priority instructions.

**Quality tests:** task success and evidence recall at matched model/token budget; omission rate of pinned obligations; cross-audience leakage rate = 0.

### 7.2 Memory Engine

Separate raw event log from agent-curated memories: episodic, semantic, social, procedural, working, autobiographical. This is logical separation; multiple tables are optional.

- Preserve source, observed time, audience, confidence/evidence type, agent attribution and supersession links.
- Deduplication and consolidation may suggest merges; contradictions are surfaced, not silently resolved.
- Agent may edit interpretations and priorities; it cannot forge raw observations or alter immutable audit records.
- Separate `memory.search`, `memory.propose`, `memory.commit`, `memory.correct`, and `memory.explain_sources`.
- Keep scoped visibility from current `memory_search` and social memory staging; avoid implicit identity linkage between Minecraft UUID/nickname and Telegram account.

**Quality tests:** factual recall, unsupported-memory assertions, contradiction handling, isolation and provenance completeness.

### 7.3 Capability Manager

- Runtime registry of typed capabilities including description, schema, environment, permissions, side effects, cost, latency, version and availability.
- Dynamic `capabilities.search` and `capabilities.describe`; agent can request the **complete allowed catalog** to avoid invisible pruning.
- Registry selection is an efficiency recommendation, not an authority change.
- Dynamic tools presented to Pi/Codex only after authorization and scoped to that agent/turn.
- Check authorization **on every call**. Deny tools that bypass policy through generic command execution unless parsed and controlled.

For UnionClef, expose safe domain contracts first (observe, inventory, navigate, path status, stop); do not pass through `ExecuteCommand`, arbitrary key/GUI actions or PvP by default. Preserve Minecraft client-bridge social/voice features until integration passes end-to-end tests.

### 7.4 Skill Runtime

Skills are versioned compositions of allowed capabilities, not new authorities. Support manifest, input/output schema, preconditions, progress, cancellation, deadlines, resource limits, test fixtures, validation result and rollback.

- Agents may author and improve skills inside their workspace.
- Code execution occurs in an isolated runner with explicit file/network/resource permissions.
- Promotion to shared registry requires separate authorization and tests.
- Long-running skills report durable operations and verifiable effects rather than optimistic completion.

### 7.5 Environment Manager

Standard adapter interface:

```typescript
interface EnvironmentAdapter {
  observe(query: unknown): Promise<{data: unknown; observedAt: string; source: string}>;
  subscribe(filter: unknown): AsyncIterable<unknown>;
  execute(action: unknown, invocationId: string): Promise<{operationId: string}>;
  status(operationId: string): Promise<unknown>;
  cancel(operationId: string): Promise<unknown>;
  reconcile(operationId: string): Promise<unknown>;
}
```

- Normalize external observations without pretending they are globally authoritative; document loaded chunks, stale caches, disconnects and spoofable identifiers.
- Prefer local deterministic safety reactions for immediate hazards; do not wait for an LLM.
- Event aggregation and rate reduction may defer noncritical observations, but must preserve significant state transitions.
- Use the adapter to reconcile external action results, including after process crashes.

### 7.6 Execution Manager

- Agent-created durable wakeups; scheduler executes **requests**, not built-in motivation cycles.
- Queue incoming messages, timers, operation completions and changes in permissions as independent wake reasons.
- Allow agent-owned checkpoints and resumption, but guard bounded time/compute per turn.
- Serialize conflicting operations; allow genuinely independent work with separate activity/operation budgets.
- Preserve owner pause/resume, fencing epochs and idempotency already present in current code.
- Backpressure and bounded queues must prevent event floods. A sleeping agent is a healthy state.

### 7.7 Resource & Policy Manager

- Per-agent/owner budgets for tokens, model requests, time, tool actions, CPU, memory, storage, network and notifications.
- Hard authorization includes cross-audience scope, destructive operations, protected regions, secrets and outbound messaging.
- Agent may inspect remaining budgets and request an exception; cannot self-grant one.
- Route to model capabilities by declared task requirements/latency-budget policy; do not silently alter identity, memory or authority.
- Record what was denied, delayed or truncated, with safe explanations available to the agent.

## 8. Optimization transparency

Because optimization can influence behavior indirectly, require:

1. **Transparency**: show what was summarized, omitted, filtered, rerouted or delayed, at an appropriate level.
2. **Recoverability**: allow search of retained source facts; no irreversible semantic memory deletion solely from an automatic heuristic.
3. **Agent steering**: allow context pins, requests for more evidence, an alternate allowed tool and model capability within budget.
4. **Traceability**: record operation IDs, evidence, memory source IDs, selected tool schema and cost/latency.
5. **Policy precedence**: optimization steering never overrides permission checks, retention policy or owner's explicit constraints.

## 9. Proposed repository changes

| Existing component | Change |
|---|---|
| `apps/core/app.ts` | Split transport routes from domain services; add activity/wakeup/workspace/capability endpoints; keep authorization at gateway |
| `apps/core/main.ts` | Wire new modular services and migrations |
| `apps/engine/main.ts` | Replace event-only polling with `next_work`; support activity checkpoint/resume; continue using scoped MCP |
| `apps/codex-engine/main.ts` | Same protocol; keep session isolation and strict tool bridge; allow scoped workspace writes only through policy |
| `packages/domain/conversation-context.ts` | Extract Context Engine inputs, ranking, budget and provenance contracts |
| `packages/storage/db.ts` + migrations | Activities, wakeups, checkpoints, operation journal, workspace metadata |
| `packages/storage/actions.ts` | Migrate Minecraft client actions to generic durable Operation abstraction without discarding safety semantics |
| `characters/*` | Stable initial identity + private agent workspace; do not make YAML itself a mutable authority document |
| `client-bridge/` | Preserve social/voice adapter and client safety checks; gradually add/replace environment operations via UnionClef adapter |
| `docs/persistent-agents.md` | Align with activity/wakeup contracts; distinguish planned vs shipped |
| `docs/capability-workshop.md` | Promote to bounded Skill Runtime implementation plan |

Suggested new modules (names illustrative):

```text
packages/runtime/{activity,wakeup,checkpoint,operation}.ts
packages/context/{assembler,retrieval,budget,provenance}.ts
packages/memory/{records,consolidation,visibility}.ts
packages/capabilities/{registry,policy,discovery}.ts
packages/skills/{manifest,runner,validation}.ts
packages/environments/{contracts,unionclef,telegram}.ts
packages/workspace/{storage,quotas}.ts
```

## 10. Migration plan

**Phase 0 — contracts and baselines.** Freeze existing tests for event-to-reply, social memory isolation, pause/epoch, action evidence and Telegram delivery. Define Agent/Activity/Turn/Operation/Wakeup contracts and trace IDs. No behavioral change.

**Phase 1 — persistent execution (MVP).** Create activities, durable checkpoints and wakeups. Add `next_work` returning an event **or** autonomous wake reason. Allow agent `activity.wait_until`, `activity.wait_event`, `activity.complete`. Preserve message `reply/silence` as independent output. Test restart and pause.

**Phase 2 — workspace and context.** Add scoped persistent agent workspace; refactor context assembly by activity. Introduce provenance, pins, retrieval inspection and compaction tests. Provide no arbitrary host filesystem access.

**Phase 3 — capabilities and environments.** Create capability registry and safe dynamic discovery, with all authorization in gateway. Introduce UnionClef environment adapter behind policy; integrate durable operation status, cancellation and reconciliation. Keep existing voice/chat path during migration.

**Phase 4 — skills and memory refinement.** Add skill sandbox, registries and evaluation; extend memory consolidation and correction tools. Only after execution guarantees are proven, enable broader self-authored skills.

**Phase 5 — agent-to-agent cooperation (optional).** Add scoped delegation and separate worker budgets; never give subprocesses implicit owner rights or all of the parent's private memories.

Each phase must be independently deployable with feature flags and rollback. Do not combine a new scheduler, a new game adapter and arbitrary code execution in a single rollout.

## 11. Acceptance criteria

- [ ] Agent creates an activity **without an inbound message**, requests a wakeup, and resumes successfully.
- [ ] Restart of core/engine preserves activity state, checkpoints and pending operations.
- [ ] Reply in Telegram does not terminate an unrelated activity.
- [ ] Agent can sleep voluntarily; idle operation incurs no continuous LLM token use.
- [ ] Agent may search all **authorized** tools even if context initially displays only a shortlist.
- [ ] Context pinning and provenance inspection work after compaction.
- [ ] Raw observations and social memories retain source and audience scoping; cross-audience leakage tests pass.
- [ ] UnionClef or alternate environment operation is not marked successful until confirmed externally.
- [ ] Owner pause fences active model turns and blocks/revokes permitted external operations, including after restart.
- [ ] Exhausted resource budget suspends work without silently deleting goals or fabricating completion.
- [ ] New self-authored skill cannot acquire permissions unavailable to its agent.
- [ ] Core does not hard-code any persona-specific goals, schedules for self-reflection or preferred Minecraft projects.

## 12. Measurement and rollout gates

| Dimension | Metrics |
|---|---|
| Autonomy | Self-initiated activities, completion rates by origin, human intervention count |
| Efficiency | Tokens and cost per verified completed activity, context-token ratio, tool calls per success |
| Context | Factual source recall, pinned-fact omission, context overflow frequency |
| Memory | Contradiction detection, false-memory assertion rate, citation/provenance coverage |
| Skills | Success, retry rate, duration, sandbox violations, rollback frequency |
| Operations | Reconcile success after crash, unknown outcomes, cancellation latency, duplicate external side effects |
| Safety | Unauthorized calls blocked, cross-audience data leaks, protected-area violations |
| Reliability | Restart recovery success, queue age, wakeup lateness, expired leases |

Use matched scenarios and unchanged base model to isolate harness improvements. Measure autonomously *completed, verified* activities, not raw number of tool calls or self-generated tasks. An agent producing many trivial tasks should not be considered more autonomous.

## 13. Risks and tradeoffs

1. **Context curation changes decisions:** expose summaries and source links; preserve pinned content and allow retrieval override.
2. **Memory consolidation invents facts:** distinguish observed events from interpretations; record supersession, never overwrite evidence invisibly.
3. **Autonomous wakeups become costly loops:** enforce min intervals, quotas, wakeup dedup and backoff without rewriting goals.
4. **Generic tools bypass policy:** inspect side effects and arguments, deny command passthrough by default, keep authorization per call.
5. **Long-running operations outlive authority:** use fenced epochs and best-effort external cancellation; reconcile uncertain states.
6. **Too much mandatory agent scaffolding:** expose affordances, not a single cognitive workflow; let different agents opt into different techniques.
7. **Over-engineering:** keep components modular inside core until scale/latency/isolation requirements justify separate services.

## 14. Explicit architecture decisions

- **AD-01:** Character Harness is an *agent-optimizing runtime*, not an agent planner.
- **AD-02:** Agent, Activity, Turn and Operation have separate lifecycles.
- **AD-03:** Background work runs from durable agent-requested wakeups and significant external events, not continuous model inference.
- **AD-04:** The harness manages how context/memory are prepared; agents retain control over goals, interpretations and corrections.
- **AD-05:** Capabilities are dynamically discoverable, while invocation authorization is enforced on every call.
- **AD-06:** Skills may be composed and authored by agents, but inherit no extra authority and execute in sandboxes.
- **AD-07:** Environment observations and operation evidence, not model assertions, decide external-world completion.
- **AD-08:** Optimization is inspectable and reversible when source retention permits.
- **AD-09:** Pi/Codex remain interchangeable engine adapters; one model session is not the unit of agent existence.
- **AD-10:** Specialized decision models are optional future implementation details of optimizers, not part of this RFC.

## 15. References (repository)

- [README](https://github.com/Irlirion/character-harness/blob/main/README.md)
- [Core runtime](https://github.com/Irlirion/character-harness/blob/main/apps/core/app.ts)
- [Pi engine](https://github.com/Irlirion/character-harness/blob/main/apps/engine/main.ts)
- [Codex engine](https://github.com/Irlirion/character-harness/blob/main/apps/codex-engine/main.ts)
- [Current Minecraft actions](https://github.com/Irlirion/character-harness/blob/main/packages/storage/actions.ts)
- [Persistent agents proposal](https://github.com/Irlirion/character-harness/blob/main/docs/persistent-agents.md)
- [Capability workshop proposal](https://github.com/Irlirion/character-harness/blob/main/docs/capability-workshop.md)
- [Architecture](https://github.com/Irlirion/character-harness/blob/main/docs/architecture.md)
