# Brains & engines

A bot's **brain** is what produces its replies. Pick it with `--brain` at
`create`.

Direct engines run a headless AI-agent CLI with native session memory
(`--resume`). Every turn also receives a short, generated operator-context
block so the model knows the bot username and transport, its current model and
tool policy, the available chat commands, attachment behavior, and the mobile
reply format. Claude, Codex, OpenCode, and Kimi start with no tools; their
deployer may select the same portable policy for either public or allowlisted
bots. The CLI retains its OAuth home inside that bot's container so it can
authenticate; container-scoped native file tools and Bash can access it.

| `--brain` | Replies come from | Reaches | Authentication |
|---|---|---|---|
| `claude` | the `claude` CLI | Claude models | Claude Code login |
| `codex` | the `codex` CLI | OpenAI models | ChatGPT / Codex login |
| `opencode` | the `opencode` CLI | many providers via `--model provider/model` | `opencode auth login` |
| `kimi` | the `kimi` CLI | Kimi (Moonshot) models via `-m <alias>` | `kimi login` |
| `parity` | bot-core's own `brains/parity-proxy.mjs` | every model on Parity's LLM proxy (`parity/…` on Parity GPUs, `openrouter/…`) | a proxy key in `~/.llm-proxy/env.sh` ([parity-ai-user-setup](https://github.com/paritytech/parity-ai-user-setup)) |
| `echo` | bot-core itself (repeats the message) | — | none |
| `bridge` | an agent framework over the HTTP bridge | — | the framework's |

`opencode` is the many-models path — one engine reaches Anthropic, OpenAI,
Google, xAI, OpenRouter, local models, and more.

## The `parity` brain

`--brain parity` talks to Parity's LLM proxy directly: one HTTPS call per turn
to `/v1/chat/completions`, the conversation kept on disk under the workspace
(`.pca/parity-sessions/`), so the bot remembers a chat the way the CLI brains
do with `--resume`. It needs no agent CLI and has no tools: it is a chat
brain. `--model` picks any id the proxy serves; the default is
`parity/deepseek-v4.1-flash`, which runs on Parity's own GPU and costs nothing.

The key comes from the file the parity-ai-user-setup script writes
(`~/.llm-proxy/env.sh`), or from `BOT_PARITY_PROXY_KEYFILE`; the proxy URL
from `BOT_PARITY_PROXY_URL` (default `https://ai.labs.paritytech.io/v1`).
pca deliberately strips secret-looking variables from a brain's environment,
so the key is read from a file, never passed through it.

`brains/parity-proxy.mjs` is also the smallest example of **bringing your own
harness**: a brain is a process that gets the prompt as its last argument,
plus `--resume <id>`, `--model <name>` and `--append-system-prompt <text>`
(pca's operator context and persona), and prints claude-shaped stream-json —
an `init` line with the session id, optional `stream_event` text deltas, an
`assistant` message and a `result`. Point `BOT_AI_CMD` at any program that
speaks that and pca runs it as the brain, with the same session resume,
placeholders, live replies and in-chat commands.

## The `feedback` brain (T3ams only)

`--brain feedback` turns a T3ams agent into a bug-report intake. A person
describes a problem in a DM or by mentioning the agent in a channel; the agent
asks what a developer needs (where, expected vs actual, steps, how often,
platform), one or two questions at a time, then asks for their **client info**.
T3ams shows that request as a consent card: the person can preview the report
(app and SDK versions, network, host capabilities, app state, recent journeys
and log lines — redacted on their device, never key material, message text or
other people's names) and share it or decline. The agent then shows the issue
it would file and files it when they say yes, replying with the link.

Mentioned in a channel (`@t3ams-admin this response is wrong`), the agent
skips the interview: it files right away from the complaint and the chat
before it (the thread, or the channel's last 30 messages, quoted in a
collapsed block), replies with the link in the mention's thread, and offers
the client-info card; a shared report is attached to the issue as a comment.
Follow-ups in that thread reach the agent without another @mention.

Issues follow `.github/ISSUE_TEMPLATE/bug_report.yml` of the target repo
(Summary, Steps to Reproduce, Expected, Actual, Environment, Logs in a
collapsed block, Additional Context) and carry `bug`, `lives-in:t3ams` and an
`area:*` label when the repo defines them.

Configuration, all read from files or plain settings:

| Variable | Meaning |
| --- | --- |
| `BOT_FEEDBACK_REPO` | `owner/name` to file into. Unset: the agent drafts but cannot file. |
| `BOT_GITHUB_TOKEN_FILE` | File holding a token with `issues: write` on that repo (default `~/.config/pca/github-token`). |
| `BOT_PARITY_PROXY_KEYFILE`, `BOT_PARITY_PROXY_URL`, `BOT_AI_MODEL` | As for the `parity` brain; intake runs on the proxy. |

Each conversation's state (stage, transcript, draft ticket, shared report)
lives under `<state dir>/feedback/`, so a restart resumes where it was. The
model only writes replies and ticket fields; when to ask for client info and
when to file are decided by `brains/feedback.mjs`. Other transports do not
carry the client-info cards, so this brain only runs on the T3ams transport.

## Operator context and persona

The generated facts describe the running configuration; they are not a
personality prompt. `pca create` gives each direct bot an operator-owned
`workspace/PERSONA.md` with a commented template for its name or role,
audience, tone, and boundaries. Edit that file to add a persona. PCA reads it
at turn time and never overwrites it. Bridge bots use their framework's own
persona mechanism, such as `SOUL.md`, and do not get a PCA `PERSONA.md`.

Claude receives the facts and persona through its system-prompt option. Codex,
OpenCode, and Kimi read a generated `AGENTS.md` in the active workspace. PCA
will create or replace that file only when it is absent or starts with
`<!-- generated by pca: operator context -->`. If an operator already owns
`AGENTS.md`, PCA preserves it, writes the derived copy to
`.pca/OPERATOR-CONTEXT.md`, logs `BOT_AI_CONTEXT_FILE_SKIPPED`, and prefixes
the first prompt of each fresh native session instead.

Set `BOT_AI_CONTEXT=0` only when debugging to suppress the generated facts.
It does not suppress an operator's `PERSONA.md`.

## Tool policy

Use `pca deploy --allowed-tools read,write,bash,web` to select exact lowercase
outcome capabilities. `write` includes `read`, and `bash` includes both.
`--tool-scope workspace|container` scopes native file tools. The default is no
capabilities and workspace scope.
A read-capable turn can inspect its staged attachment, and a write-capable turn
can produce returnable files.

Workspace scopes native file tools to the normal project working area; container
scope deliberately exposes all files visible to the non-root agent account,
including its OAuth home. Bash uses the agent process boundary in either scope:
the dedicated bot container for a deployment, or the local process account for
`pca run`. Treat local Bash bots as trusted-machine tools. Do not mount unrelated
host repositories, credentials, Docker sockets, or home directories into a
deployed bot container. See [Private & public bots](/guide/access) for the boundary.

The `kimi` brain is the exception on file scoping: its CLI has no per-path tool
rules, so PCA compiles the capability policy into static `[[permission.rules]]`
deny entries (one per ungranted builtin tool) in an overlay `KIMI_CODE_HOME`
generated per bot process — sessions and login state are symlinked through, MCP
servers and skills are not. (The CLI's `[tools]` config switch is not honored
in its prompt mode; the deny rules are.) Kimi file tools therefore reach the
whole agent-visible filesystem whenever `read`/`write` is granted, and a Kimi
`config.toml` that already sets `[tools]` or `[[permission.rules]]` is refused
(PCA owns the tool policy).

## Pinning a model

`--model` pins the model (`BOT_AI_MODEL`; a `provider/model` slug for opencode,
a `config.toml` model alias for kimi).
Set it at `create` (saved to the bot) or override per run. `BOT_AI_CMD` /
`BOT_AI_ARGS` wire in a custom CLI that speaks claude-shaped stream-json.

## Model switching in chat

`/model` always shows the active model. Whether a chat user can *switch* it is a
policy decision, because switching to an expensive model spends the owner's
quota:

- **Locked by default.** An unconfigured bot only shows the model.
- **Approved set.** `pca model <bot> allow model-a,model-b` lets chat users pick
  from that list (this is the only option for a public bot — unrestricted
  switching is never allowed publicly).
- **Open.** `pca model <bot> open` allows free switching, but only for a bot
  with an explicit allowlist (trusted peers).

## Reasoning effort

`/reasoning <level>` dials thinking depth per conversation on engines that
support it (claude, codex). `BOT_AI_REASONING` sets the default.
