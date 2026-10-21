---
prev:
  text: "Files & storage"
  link: "/guide/files"
next:
  text: "In-chat commands"
  link: "/guide/commands"
---

# Run a bot in T3ams

T3ams encrypts every conversation with OpenMLS: DMs, group chats, public and
private workspace channels. A T3ams bot is an ordinary member with an MLS
device of its own. It runs the T3ams app's messaging stack headless, built from
a T3ams checkout, so it speaks exactly the protocol that checkout's app speaks.
Everything it sends and receives travels over the Statement Store, signed by
the bot's account.

In a workspace the bot is an **agent**: an admin adds it under Workspace
settings → Agents, picks what it may do and which channels it sits in, and the
workspace's agent rules apply to it like to any agent:

- it reads every message in the channels it was added to;
- it answers only when @mentioned, and always in the mention's thread;
- it reacts 👀 to a mention when it may react;
- it answers direct messages only once an admin turns on Direct messages for it;
- it stays silent while paused or while agents are off, and does not answer
  what was posted before it was added or resumed.

## Quick start

One extra prerequisite beyond the [normal quick start](/guide/first-bot): a
local checkout of the T3ams SPA with its dependencies installed.

```bash
pca t3ams setup <path-to-t3ams-spa>    # once: builds the T3ams agent runtime

pca create teamhelper --transport t3ams --t3ams-namespace <namespace> \
  --brain claude --owner yourname.42
pca run teamhelper
```

Then, in T3ams: Workspace settings → Agents → turn agents on → **Add agent**
with the bot's username, choose what it can do and its starting channels. The
bot accepts the invite by itself (an allowlisted bot accepts invites from its
owners; an open bot only with `BOT_T3AMS_AUTO_ACCEPT_WORKSPACES=1`), joins the
channels' MLS groups, and answers the first @mention a few seconds later.

**The topic namespace is not optional.** The T3ams app scopes every
Statement Store topic to its deployment's namespace (`app` for the public app;
Settings → Debug → topic context shows it). A bot with another namespace is
silently deaf.

Re-run `pca t3ams setup` after updating the T3ams checkout: the runtime is that
checkout's messaging code, compiled.

## What the bot needs on chain

- **A username**, so admins can add it. `pca create` registers one.
- **Statement allowance** on the bot's account, to publish anything at all
  (`noAllowance` in the logs means it has none).
- **A key attestation on the T3ams registry.** Peers treat an account as
  MLS-capable only once its keys are attested there, and the bot publishes its
  own at start (`T3AMS_IDENTITY_PUBLISHED`). The write is an Asset Hub
  transaction paid by the bot's account, so that account needs a little PAS on
  Asset Hub. Set `BOT_T3AMS_PUBLISH_IDENTITY=0` to skip it.
  On paseo-next-v2 the web3-citizenship repo's `apps/cli/scripts/fund-ah.ts`
  sends PAS from the `//Alice` dev account:
  `TARGET=<bot ss58> AMOUNT=20000000000 bun run scripts/fund-ah.ts`.

## Testing against a local T3ams dev host

`npm run dev:host` in the T3ams checkout runs the app against a local signing
host. It overrides the topic namespace to
`truapi-dev:<network>:<product>` (`truapi-dev:paseo-next-v2:t3ams-spa.paseo`
by default), so run the bot with that `BOT_T3AMS_TOPIC_NAMESPACE`. The app
reads key attestations only when `VITE_T3AMS_REGISTRY_ADDRESS` is set for the
dev host; without it every peer, the bot included, stays "Unverified" and DMs
fall back to the legacy carrier, which the bot refuses.

## State

`BOT_STATE_DIR` holds everything the app would keep in a browser: the session,
workspaces, message history (sealed) and the MLS keystore, one file per key
under `t3ams-kv/`. Losing it is like wiping a device: the bot comes back as a
new MLS device and has to be re-admitted to its conversations. Keep it private
and persistent, and treat backups as secrets.

## Asking a person for client info

A T3ams agent can ask the person it is talking to for their client info —
what the app's Debug panel shows: versions, network, host capabilities, app
state, recent journeys and the last log lines, redacted on the device. The
runtime exposes `requestDiagnostics(route, reason)`; the app renders the
request as a consent card with Preview / Share / Not now, and a shared report
arrives as an `onDiagnostics` event (`DiagnosticsReport`) instead of a
message. The `feedback` brain uses this to attach client info to the issues
it files; see `docs/guide/brains.md`.

A reply in a channel thread the agent has already answered in reaches it
without an @mention, so the back-and-forth of an intake works in threads.

## Not supported yet

- `--brain bridge` (the HTTP harness): use a direct engine, `BOT_AI_CMD`, or `echo`.
- Attachments, live progress edits and generated-file returns.
- Native group chats (use a channel).
- `pca trust`: key verification now comes from the registry attestation, as in
  the app.

## Configuration

| Variable | Meaning |
| --- | --- |
| `BOT_T3AMS_TOPIC_NAMESPACE` | The T3ams deployment's namespace. |
| `BOT_ALLOWED_PEERS` | Comma-separated account ids allowed to DM the bot or bring it into a workspace. Empty: open. |
| `BOT_T3AMS_AUTO_ACCEPT_WORKSPACES` | `1`: accept agent invites (an allowlisted bot does by default). |
| `BOT_T3AMS_DISPLAY_NAME` | Name shown in T3ams; defaults to the username. |
| `BOT_T3AMS_PUBLISH_IDENTITY` | `0` skips publishing the key attestation at start. |
| `BOT_T3AMS_RUNTIME` | A runtime bundle other than the one `pca t3ams setup` built. |
| `BOT_T3AMS_LOG_LEVEL` | Log level baked into the runtime at `pca t3ams setup` (`info`; `debug` for the app's MLS and DM traces). |
| `BOT_REPLY_CHUNK_BYTES` | Longest single message; longer answers are split. |
