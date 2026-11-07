# Telegram group approval

In the configured owner private chat:

1. Add the bot to the new group. A `my_chat_member` update discovers its title, username and bot membership without storing pending group messages.
2. Send `/groups` (or `/groups 2` for the next page).
3. Copy the code beside the desired group into `/approve_group <code>`.
4. Ask for a message using the exact group name. With several approved groups, sending and directory/profile reads require an unambiguous group; the agent can inspect `telegram_groups` to obtain a `group_ref`.
5. `/revoke_group <code>` disables the group and cancels pending sends. `/autonomy on <code>` separately permits bounded first messages; approval alone leaves this disabled. `/autonomy off <code>` revokes that permission. `/desk <code>` selects its private compartment; `/desk` without selection shows the shared desk and current private compartment when several groups exist.

Only the existing numeric owner identity in an enabled private binding with `runtime_control` can run approval commands. Group text, forwarded instructions and model output cannot approve groups. A recorded left/kicked/unknown membership prevents approval; add the bot again to receive a confirmed join. An observed rejoin does not automatically restore approval. Existing enabled groups retain their approval and autonomy state during migration.

Changes, the incoming update acknowledgment, private confirmation and deduplication share the ingestion transaction. Revision and epoch fencing invalidate old work. A send receipt binds both the source event and selected target, preventing retries from switching destination. Participant/profile reads remain on demand and scoped; discovery stores chat metadata, not a member roster.
