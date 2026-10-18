# Autonomous workplace, first production slice

The character has one common virtual desk: a 4000-character notebook, a 2000-character
plan, and an optimistic revision, shared across Telegram and Minecraft. Each audience
also retains a separate compartment for confidential context. These are durable database records,
not paths on the host. The model receives the entire desk, its activity checkpoint,
and up to eight recent group messages (500 characters each) with timestamps,
direction and observation-gap status. Quoted messages and notes confer no authority.
Private activities and confidential compartments remain separate. The common desk is
injected into both ordinary social turns (agent_desk) and reviewed runtime work
(shared_desk). Ordinary social tools cannot mutate it: all shared writes must pass the
reviewed runtime activity protocol, from any server-authorized audience.

An owner opts in one existing enabled group. The server schedules one self-originated
activity every two hours, only 09:00–21:00 Europe/Berlin (including DST). Scheduling
requires a usable execution policy, connected Telegram account, and unpaused character.
A persisted next-wake time and character lock prevent duplicate wakes or catch-up bursts.
Only one open autonomous activity is allowed in a group; each wake gets one model turn.
The agent chooses local planning/notes, a useful message proposal, or silence. It must
complete that wake. An exhausted interrupted wake is retired at the next schedule.
A policy hold before dispatch stays visible and requires owner action; no provider fallback.
The existing character-wide dispatch, token and reviewer budgets still apply.

`activity_decide` may replace the whole desk using its expected revision and may propose
one short first message plus a reason. Full desk changes and proposal are reviewed
alongside checkpoint/lifecycle output. Current context is rechecked after input review.
A successful commit atomically writes notes, checkpoint, receipt and a durable outbox
record; receipt retry cannot duplicate either notes or messages. Failed review changes none
of these. The model cannot edit permissions, schedules, budgets, bindings or moderation.

Proactive delivery requires the same enabled group, autonomy revision, character epoch,
current unexpired policy, finished reviewed grant and exact message hash. It has no reply
target, expires after five minutes, is cancelled during quiet hours or after group input
in the last ten minutes, and allows at most two attempts per rolling 24 hours with a
minimum two-hour interval from any previous bot dispatch in that group. Ambiguous
network outcomes are never retried automatically. It is acceptable for a proposed
message to be cancelled. Policy expiry or budget exhaustion stops new autonomous work.

The verified private owner can use `/autonomy`, `/autonomy on`, `/autonomy off` and
`/desk` to inspect/control the group's autonomy and desk. Other senders and group messages
cannot operate these controls. The owner API is `POST /owner/telegram/autonomy` with
`binding_id` and `enabled`. No filesystem, shell, web browsing, arbitrary recipient,
account change, money transfer, gameplay or new-tool authority is added.

This slice uses the existing Codex account and content reviewer. Deployment needs a new
immutable policy version whose rules explicitly permit scoped desk updates and reviewed
first posts; the old private-planning policy deliberately does not authorize publication.
Content checks implement a conservative OpenAI/EU product baseline, not a guarantee of
legal compliance or immunity from provider enforcement. Legacy reactive social replies
are unchanged and do not pass through the new runtime review gate.

Rollback: disable autonomy for the group, stop the runtime engine, revoke outstanding
turns and cancel queued proactive jobs before restoring an older image. Keep migration
016 and desk data. Older consumers only understand owner-origin activities; do not let
an old engine claim self-origin work. Re-enable only with a compatible image/policy.

## Shared desk upgrade (migration 017)

Common notes are visible in every connected channel for this character and must be
safe for that disclosure. Full shared writes are reviewed as cross-channel publication;
private conversations, sensitive information and cross-channel identity guesses are
not eligible. The entire shared version is included in input/context hashes, and writes
use an atomic revision check. Receipt replay cannot duplicate an update. Another
character never receives this desk. Scoped notebooks are preserved without automatic
copying; the agent may distil non-sensitive general goals through review.

The owner `/desk` view shows common plans/notes plus a labelled group/private
compartment. Shared material does not confer tools or change recipient permissions,
scheduling, budgets or other policies. Migration 017 is additive. For rollback to 016,
stop the runtime consumer, retain common desk data and restore the prior policy/image;
legacy scoped desks remain intact. A v4 policy expressly authorizes shared safe notes.

## Ordinary private owner requests (migration 018)

The verified private owner may ask naturally to send a group message, without slash
commands. `telegram_send_group` is supplied only in that owner's active private turn
with runtime control, usable policy/reviewer and exactly one configured enabled group.
The server chooses the group. The exact proposed text, current owner request and bounded
recent private context are reviewed together for explicit delegation and permitted
cross-channel disclosure. Quoted/history instructions alone are not authority.

An atomic receipt and outbox permit at most one group post per source event. Repeated
calls return that same delivery; changed text is rejected. Before dispatch, both bindings,
owner delegation, revisions, policy and text hash are rechecked. An explicit owner request
is separate from unsolicited initiative and does not use its two-per-day/quiet-hour gates;
normal Telegram delivery rate limits and moderation/reviewer budgets still apply.
`telegram_group_delivery` can confirm `sent` only after a real worker acknowledgment.
Unknown outcomes never cause automatic resend. The private response must distinguish
queued, sent, failed and unknown. No other channel/tool authority is added.

Follow-up directives (for example, “поздравь его” after a named group message) may
continue the current exchange without repeating the person/group. Review receives the
last two confirmed sends from the same private owner binding and same target group
revision within 30 minutes, including original requests and actual sent text. A named
addressee inside that group is not a new chat recipient. Receipts are contextual evidence;
a current directive is still required, and unrelated greetings/questions are not sends.
Ambiguous-addressee errors are reported with a concrete clarification instead of claiming
that Telegram is unavailable. No stored failed message is automatically replayed.

## Group participant queries (on demand)

`telegram_group_participants` reads Telegram's current member count, administrators
and membership of up to 20 authors already observed in this group's recent journal.
The Bot API does not enumerate every member. The result always says complete=false,
includes partial API permission/errors and a timestamp, and strips numeric user IDs.
Names/usernames are untrusted display labels, not cross-channel identity mappings.

Within a group only that group can be queried. Within the verified private owner chat,
only the single configured group can be queried. Active turn, epoch, source and target
bindings are rechecked after the read. The worker keeps the Bot API token; an internal
read-only endpoint accepts only the worker credential and has no published host port.
There is no background roster collection, directory table or result cache. Ordinary
chat replies remain subject to the existing journal behavior. No permission changes,
member scraping/enumeration, additional recipients or outbound posts are introduced.

Reference: https://core.telegram.org/bots/api#getchatadministrators,
https://core.telegram.org/bots/api#getchatmembercount,
https://core.telegram.org/bots/api#getchatmember.
