# DSH Telegram Bridge

[![Node tests and Harness install](https://github.com/amonrapmon/dsh-telegram-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/amonrapmon/dsh-telegram-bridge/actions/workflows/ci.yml)

**Topic-aware Telegram transport for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

One bot. Multiple chats and topics. A separate, persistent Harness conversation for each Telegram topic.

> **Status: developer preview.** Core routing, persistence, and mock-based tests are included. An end-to-end test with a real Telegram bot and Harness `0.2.0-rc.2` has **not yet been completed**. Do not use this build for critical notifications.

## What it does

- 🧵 Private chat topics and supergroup forum topics are routed independently.
- 💾 Topic → Harness session bindings survive process and Docker restarts.
- 🔁 `/new` starts a new conversation **only** in the current topic.
- 🔒 Denies access unless the Telegram user is explicitly allowed. Unknown groups require an in-Telegram superadmin approval.
- ✉️ Replies are returned to the originating chat and topic.
- 🌍 Does not change, summarize, or translate assistant responses. The agent controls its own language.
- 🧩 Uses the Harness `0.2.0-rc.2` session controller API rather than bypassing its sessions.

The bridge owns transport only. Agent prompts, language, Skills, memory and tools remain the responsibility of Harness.

## Quick start

Requirements: Node.js **22.19+**, DeepSeek Harness **0.2.0-rc.2**, and a Telegram bot created with [@BotFather](https://t.me/BotFather).

1. Install into your Harness web profile:

```sh
dsh plugin --profile web add github:amonrapmon/dsh-telegram-bridge
```

2. Supply the environment variables to the process **that runs Harness**:

```dotenv
DSH_TELEGRAM_TOKEN=YOUR_TOKEN_FROM_BOTFATHER
DSH_TELEGRAM_ALLOWED_USER_IDS=123456789
```

The ID is your **numeric Telegram user ID**, not `@username`. You can find it using a Telegram user-info bot.

3. Configure your model in Harness Web UI. Creating a named workspace is optional: without one, the bridge creates sessions in the Harness process working directory.
4. Restart Harness. Open your bot's private chat and send `/start` followed by a normal message.

If Harness has multiple workspaces, select a specific one using `DSH_TELEGRAM_WORKSPACE_ID`.

**Important:** exporting a variable in one terminal does not set it for an existing Docker container or background service. Add it to that service's private environment and restart.

## Working with topics

Enable **Topics** for your Telegram bot through BotFather, where the feature is available. The bridge does **not** automatically create topics or set your topic names.

```text
Private bot chat
  General            → Harness session A
  Shopping            → Harness session B
  Work                → Harness session C

Supergroup -1001234567890
  General            → Harness session D
  Project discussion → Harness session E
```

The mapping key is `chat_id:message_thread_id`. For a regular private chat it uses `:0`, and for the forum General topic it uses `:1`.

Each topic has its own session history, but **all topics within one Harness instance still share that instance's configured tools and access privileges**. Topic isolation is conversational isolation, not a security boundary for medical or other sensitive data.

### Group chats: request and approve in Telegram

Group access is **off by default**. No group ID or env-file editing is required:

1. Open the bot's private chat and send `/start` so the bot can send you administrative notifications.
2. Add the bot to a group or supergroup. Telegram sends a bot-membership update; an unknown group's first delivered message also acts as a fallback for pre-existing groups.
3. The **first** numeric user in `DSH_TELEGRAM_ALLOWED_USER_IDS` is the superadmin. This user receives one private card with the group name and two inline buttons: **✅ Разрешить** or **❌ Отклонить**.
4. Until approved, the group cannot submit prompts to Harness. The superadmin's choice is saved in `telegram-bridge-state.json`, alongside existing session mappings and the Telegram offset, and survives a restart.
5. An approved group can use topics as independent conversations. An explicitly declined group stays blocked; remove and re-add the bot to request again.

For security, the Telegram user allowlist is **still enforced in approved groups**. Only authorized users can prompt the agent; a group-level approval does not give everyone access to the owner's tools or data. In groups, messages must mention `@YourBot` or reply to the bot unless the existing `DSH_TELEGRAM_REQUIRE_MENTION=false` setting explicitly disables that safeguard.

`DSH_TELEGRAM_ALLOWED_GROUP_CHAT_IDS` remains available as a legacy static override for automation and old deployments; normal onboarding does not use it. A missing private chat with the superadmin prevents delivery of the approval card, so send `/start` in private first.

Bot privacy mode may limit which ordinary group messages Telegram delivers, but `my_chat_member` updates let the bot receive invitations without reading the group's conversation.

## Bot commands

| Command | Action |
| --- | --- |
| `/start` | Welcome and help |
| `/help` | Show commands |
| `/status` | Check the current topic's conversation |
| `/new` | Start a fresh Harness conversation **in this topic only** |

Unknown commands are currently forwarded as ordinary text if authorized.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `DSH_TELEGRAM_TOKEN` | Empty | Bot API token; empty disables polling |
| `DSH_TELEGRAM_ALLOWED_USER_IDS` | Empty | Allowed numeric user IDs; empty denies everyone |
| `DSH_TELEGRAM_ALLOWED_GROUP_CHAT_IDS` | Empty | Optional legacy static group IDs; interactive superadmin approval is the default |
| `DSH_TELEGRAM_WORKSPACE_ID` | Auto-select if exactly one | Target Harness workspace |
| `DSH_TELEGRAM_REQUIRE_MENTION` | `true` | Require mention/reply in groups |
| `DSH_TELEGRAM_STATE_FILE` | `$DSH_HOME/telegram-bridge-state.json` | Persistent topic bindings and update offset |
| `DSH_TELEGRAM_DIAGNOSTICS` | `0` | Set to `1` temporarily to trace receive/authorization/session/delivery without message content or IDs |

Don't commit your environment file. Never run two polling instances using the same Telegram bot token: Telegram rejects concurrent `getUpdates` consumers.

### Docker

Mount a persistent `DSH_HOME` volume and pass your own token and allowlists into the Harness container. The state file is stored inside `DSH_HOME` by default.

If you are using this plugin with [life-harness](https://github.com/amonrapmon/life-harness), enable it **only after** the containerized Harness itself runs correctly and this plugin passes the integration test. Do not install the old incompatible `dsh-telegram-channel@0.3.5` alongside it.

## Troubleshooting silent Telegram messages

The `/start` and `/status` responses come directly from this bridge, not
from the language model. If `/start` responds but `/status` later does not,
the issue is **upstream of Harness model execution**.

Temporarily set `DSH_TELEGRAM_DIAGNOSTICS=1` in the Harness process environment,
restart it, and inspect its logs. Trace markers include:

- `connected to Telegram; starting polling`
- `poll cycle completed: N updates`
- `message accepted` or `message ignored: ...`
- `handling status command`
- `submitting user text to Harness`
- `Harness turn finished`, `assistant response delivered to Telegram`

The diagnostics are deliberately metadata-only and do not log token, text,
Telegram IDs or session IDs. Disable after identifying the issue.
A bot whose token is polled by another process may encounter Telegram 409
conflicts. Keep exactly one polling process for each bot.

## Current limitations

- Text in/text out, no voice transcription or automatic STT.
- Photos, documents, rich previews and automatic topic creation are not included in the first preview. Inline buttons and callback queries are implemented for superadmin group approval only.
- Replies are sent after a Harness turn completes, not streamed token-by-token.
- An update is checkpointed after its processing. A crash at the exact processing/checkpoint boundary can replay a message. Exactly-once delivery is not claimed.
- Sessions remain in Harness if a topic is reset. `/new` changes its mapping, not historical records.
- A corrupted state file stops the bridge instead of destroying old mappings.
- A failed Telegram API delivery is logged; a durable outbound retry queue is a future improvement.

## Development

```sh
npm test
npm run check
```

Tests use simulated Telegram and Harness components, **not** your real bot token. The GitHub Actions workflow runs these checks automatically on each push.

See [ARCHITECTURE.md](ARCHITECTURE.md) for routing and persistence design.

## Acknowledgements

Inspired by [todayer/dsh-telegram-bridge](https://github.com/todayer/todayer-dsh-telegram-bridge), the [hi-wenw Telegram channel](https://github.com/hi-wenw/dsh-telegram-channel), and the [IgnatAi401 Harness adapter](https://github.com/IgnatAi401/dsh-telegram). See [NOTICE.md](NOTICE.md).

MIT licensed. Community contributions welcome.
