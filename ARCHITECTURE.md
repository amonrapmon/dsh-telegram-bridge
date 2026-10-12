# Architecture

This package is a **Telegram transport adapter**, not an agent or an LLM.

## Message routing

```text
Telegram update
  -> user and group allowlist
  -> chat ID + topic ID
  -> persisted session ID
  -> Harness sessionController.resolveAgent(...)
  -> agent.followup(...)
  -> Harness session/event
  -> same chat and topic ID
```

- Plain private chat: `chat_id:0`.
- Bot private chat topic: `chat_id:message_thread_id`.
- Forum General topic: `chat_id:1`.
- Forum topic: `chat_id:message_thread_id`.
- Other supergroup: `chat_id:0`.

Never mix conversations by using only the chat ID. A `/new` in topic X changes only the binding for X.

## Persistence

`StateStore` saves a versioned JSON file under `$DSH_HOME` by default.
Writes use a temporary file and atomic rename. Corrupt state fails closed
instead of silently dropping history.

The state tracks a Telegram update offset and a dictionary of topic
keys mapped to Harness session IDs. The actual messages live in Harness,
not in this file.

Telegram long polling requires **one consumer per bot token**. The update
offset is checkpointed after the corresponding message is processed;
this does not guarantee exactly-once delivery if the process crashes
between the agent accepting a turn and saving the checkpoint.

## Incoming authorization

1. Valid chat type and numeric Telegram user ID.
2. User must be in the explicit allowlist.
3. If the chat is a group, it must also be in the explicit group allowlist.
4. Group mentions or replies to the bot are required by default.

Authentication is checked before creating sessions or downloading media.
No media download is implemented in the current preview.

## Session lifecycle

The bridge creates sessions using `sessionController.create({workspaceId})`.
On subsequent messages it resolves the persisted session using
`sessionController.resolveAgent(sessionId)`. Existing sessions remain
in Harness across process restarts and `/new` commands.

If a stored session cannot be resolved, the bridge does not silently
overwrite the mapping: the user can explicitly run `/new`.

## Outbound replies

Listen for `session/event`, collect **committed assistant text** and
send it when the turn ends. Ignore tool payloads, reasoning blocks and
non-appended presentation updates.

`sendMessage` uses the originating `chat_id` and
`message_thread_id` for non-General topics; it never changes the
language of the model response.

## Compatibility baseline

Host target: `@deepseek-ai/dsh@0.2.0-rc.2`.

Public interfaces studied:
- `@deepseek-ai/dsh-api-session-controller` create/resolveAgent
- `@deepseek-ai/dsh-agent` followup
- `@deepseek-ai/dsh-session` session event stream

We deliberately do **not** patch old peer dependency version
strings to bypass Harness's compatibility check.

## Acceptance tests

The core tests run without Telegram credentials. Before release,
a real DSH + Telegram E2E needs to verify:

1. Two topics in the same DM create independent sessions.
2. Restart DSH: both topics continue their respective histories.
3. `/new` in one topic does not affect another.
4. Multiple allowed group topics remain independent.
5. A stranger in an allowed group cannot operate the agent.
6. A response cannot be delivered into a different topic.
7. Voice and media messages are rejected gracefully.
8. Long texts do not exceed Telegram limits.
9. Failing Telegram API calls do not disclose the bot token.
10. Background-triggered Harness turns are delivered to the correct topic.

Automated tests exercise most of the pure routing and state logic but
**do not** replace the real-host E2E.
