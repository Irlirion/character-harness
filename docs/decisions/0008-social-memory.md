# ADR 0008: scoped, sourced social memory

Date: 2026-10-10. Status: accepted.

## Decision

Social memory is stored as structured rows scoped to both character and audience. A person is identified by a channel plus its external identifier; a display name is descriptive and never an identity key. Identity provenance and verification status remain explicit. Facts, relationship notes, and commitments refer to a source event in the same scope. Relationship notes are the character's interpretation, not asserted facts about a person. Legacy free-text notes remain in `memories` and are not promoted automatically.

Engines may include an optional versioned `memory_delta` in `/engine/complete`. The core validates its schema, scope, epoch, source event, and working-state base version. The accepted delta, reply, optional speech job, event completion, and lease release commit in one PostgreSQL transaction. A malformed or stale delta is reported separately while a valid reply still commits. A state-version conflict rejects the complete delta without replacing newer state. Completion replay is idempotent.

## Consequences

- No cross-channel identity linking is inferred.
- State summaries are replaceable projections with a monotonically increasing version; sourced records remain separately addressable.
- The core accepts proposals from engines but checks scope and allowed transitions. It does not run another model call.
- This slice does not schedule wakeups, build model context from the new tables, or expose a memory-inspection endpoint.
