# Run a T3ams feedback bot

A step-by-step setup for an agent that takes bug reports in T3ams and files
them as GitHub issues. For what the brain does, see
[The `feedback` brain](/guide/brains#the-feedback-brain-t3ams-only).

## 1. Prerequisites

- Node 22+ and this repo with `npm install` done. From the repo root, use
  `npm run pca -- <command>` wherever this page says `pca <command>`.
- A local checkout of the T3ams SPA (`paritytech/t3ams-spa`) with
  dependencies installed.
- A GitHub token with **Issues: write** on the repo you file into (a
  fine-grained PAT is enough).
- An OpenAI-compatible model endpoint and its API key (the Parity proxy, or
  OpenRouter).

## 2. Store the secrets in files

The bot reads secrets from files, never from its environment:

```bash
mkdir -p ~/.config/pca && chmod 700 ~/.config/pca
printf '%s' 'PASTE_GITHUB_TOKEN_HERE' > ~/.config/pca/github-token
printf '%s' 'PASTE_MODEL_KEY_HERE'    > ~/.config/pca/model-key
chmod 600 ~/.config/pca/github-token ~/.config/pca/model-key
```

## 3. Build the T3ams runtime (once)

```bash
pca t3ams setup /path/to/t3ams-spa
```

## 4. Create the bot

```bash
pca create feedbackbot --transport t3ams --t3ams-namespace app \
  --network paseo --brain feedback --owner yourname.42
```

This registers a username (e.g. `feedbackbot.95`). Settings land in
`~/.pca/bots/feedbackbot/config.json`. Values there (`brain`,
`t3amsNamespace`, ...) **override** the matching `BOT_*` env vars, so change
them in that file, not in your shell.

## 5. Run it

```bash
BOT_FEEDBACK_REPO=paritytech/t3ams-spa \
BOT_PARITY_PROXY_URL=https://openrouter.ai/api/v1 \
BOT_PARITY_PROXY_KEYFILE=~/.config/pca/model-key \
BOT_AI_MODEL=deepseek/deepseek-v4.1-flash \
pca run feedbackbot
```

Optional: `BOT_T3AMS_DISPLAY_NAME=t3ams-admin` changes the name people see.
Without `BOT_FEEDBACK_REPO` the bot drafts issues but cannot file them. The bot
is only alive while `pca run` is; see [Deploy to a server](/guide/deploy) to
keep it up.

## 6. Add it to a workspace

In T3ams: Workspace settings → Agents → turn agents on → **Add agent** with the
bot's username, then pick its channels. The bot accepts the invite by itself.

## 7. Try it

- DM the bot: "the send button does nothing in #general". It asks at most one
  question, files, and replies with the issue link plus a client-info card.
- In a channel: `@feedbackbot this response is wrong`. It files from the
  message and the chat before it, and replies in the thread.
- "hi" or "you alive?" gets a one-line reply and no issue.

## Testing against a local T3ams (`npm run dev:host`)

The dev host uses a different topic namespace and needs a registry address:

```bash
# in t3ams-spa
VITE_T3AMS_REGISTRY_ADDRESS=0xa2098781edc0916546128d020affc438317edc2c npm run dev:host
```

Set `"t3amsNamespace": "truapi-dev:paseo-next-v2:t3ams-spa.paseo"` in the
bot's `config.json` and restart it. Without the registry address, peers show as
Unverified and DMs use the legacy carrier, which the bot refuses.

## Troubleshooting

- **Nothing arrives**: check the `pca run` log after the message had time to
  land, and that `t3amsNamespace` matches the app you are using.
- **"cannot file"**: `BOT_FEEDBACK_REPO` is unset, or the token lacks Issues
  write on that repo.
- **Stuck conversation**: state lives under `<state dir>/feedback/`; deleting
  that conversation's file resets it.
