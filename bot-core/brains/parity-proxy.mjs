#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

// A bot brain on Parity's LLM proxy (https://ai.labs.paritytech.io): no agent
// CLI, one HTTPS call per turn to the proxy's OpenAI-format
// /v1/chat/completions, with the conversation kept on disk so a bot keeps
// its memory across turns like the CLI brains do with --resume.
//
// It is also the smallest example of bringing your own harness to pca: a
// brain is a process that takes the prompt as its last argument and writes
// claude-shaped stream-json to stdout, one JSON object per line —
//
//   {"type":"system","subtype":"init","session_id":"…"}   the session to resume next turn
//   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}}
//                                                       live chunks, optional
//   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
//   {"type":"result","result":"…","usage":{"input_tokens":n,"output_tokens":n}}
//
// — and understands `--resume <id>`, `--model <name>` and
// `--append-system-prompt <text>` (pca's operator context and persona).
//
// The proxy key is read from the file parity-ai-user-setup writes
// (~/.llm-proxy/env.sh) or from PARITY_PROXY_KEYFILE: pca strips every
// secret-looking variable from a brain's environment on purpose, so the key
// never travels through the environment, only its path does.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://ai.labs.paritytech.io/v1";
const DEFAULT_MODEL = "parity/deepseek-v4.1-flash";
const SESSIONS_DIR = path.join(process.cwd(), ".pca", "parity-sessions");
const MAX_TURNS = 40;

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const fail = (message) => {
  emit({ type: "result", is_error: true, result: message });
  process.exit(1);
};

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1] ?? null;
};
const separator = args.indexOf("--");
const prompt = separator === -1 ? args.at(-1) : args.slice(separator + 1).join(" ");
if (!prompt) fail("no prompt given");

function readKey() {
  const fromEnv = process.env.PARITY_PROXY_KEYFILE;
  const candidates = [fromEnv, path.join(os.homedir(), ".llm-proxy", "key"), path.join(os.homedir(), ".llm-proxy", "env.sh")].filter(Boolean);
  for (const file of candidates) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const exported = /LLM_PROXY_KEY=['"]?([^'"\n]+)/.exec(text);
    const key = (exported ? exported[1] : text).trim();
    if (key) return key;
  }
  return null;
}

const key = readKey();
if (!key) fail("No Parity proxy key: run the parity-ai-user-setup script (writes ~/.llm-proxy/env.sh) or set BOT_PARITY_PROXY_KEYFILE.");
const baseUrl = (process.env.PARITY_PROXY_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
const model = option("--model") || DEFAULT_MODEL;
const systemPrompt = option("--append-system-prompt");

const sessionId = option("--resume") || randomUUID();
const sessionFile = path.join(SESSIONS_DIR, `${sessionId.replace(/[^A-Za-z0-9-]/g, "")}.json`);
let messages = [];
try { messages = JSON.parse(fs.readFileSync(sessionFile, "utf8")).messages ?? []; } catch { /* new session */ }
emit({ type: "system", subtype: "init", session_id: sessionId, model });

messages.push({ role: "user", content: prompt });
const request = [
  ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
  ...messages.slice(-MAX_TURNS),
];

let response;
try {
  response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: request, stream: true }),
  });
} catch (error) {
  fail(`Parity proxy unreachable: ${error?.message ?? error}`);
}
if (!response.ok) fail(`Parity proxy answered ${response.status}: ${(await response.text()).slice(0, 300)}`);

// Server-sent events: `data: {chunk}` lines, `data: [DONE]` at the end.
let answer = "";
let usage = null;
let buffered = "";
const decoder = new TextDecoder();
for await (const bytes of response.body) {
  buffered += decoder.decode(bytes, { stream: true });
  let newline;
  while ((newline = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; }
    if (chunk.usage) usage = chunk.usage;
    const text = chunk.choices?.[0]?.delta?.content;
    if (typeof text === "string" && text) {
      answer += text;
      emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    }
  }
}
if (answer === "") fail("Parity proxy returned an empty answer");

messages.push({ role: "assistant", content: answer });
fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(sessionFile, JSON.stringify({ model, messages }), { mode: 0o600 });

emit({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
emit({
  type: "result",
  result: answer,
  session_id: sessionId,
  ...(usage ? { usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 } } : {}),
});
