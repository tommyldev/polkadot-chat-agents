// SPDX-License-Identifier: GPL-3.0-or-later

// One chat completion on Parity's LLM proxy (OpenAI format), for brains that
// need an answer as a value rather than a stream: the feedback agent asks for
// JSON and parses it. The key is read from a file, never from the environment
// (see brains/parity-proxy.mjs for why).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PARITY_PROXY_URL = "https://ai.labs.paritytech.io/v1";
export const PARITY_DEFAULT_MODEL = "parity/deepseek-v4.1-flash";

export function readParityProxyKey(keyFile = null) {
  const candidates = [keyFile, path.join(os.homedir(), ".llm-proxy", "key"), path.join(os.homedir(), ".llm-proxy", "env.sh")].filter(Boolean);
  for (const file of candidates) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const exported = /LLM_PROXY_KEY=['"]?([^'"\n]+)/.exec(text);
    const key = (exported ? exported[1] : text).trim();
    if (key) return key;
  }
  return null;
}

/**
 * @param {{ key: string, baseUrl?: string, model?: string, fetch?: typeof fetch }} options
 */
export function createParityLlm({ key, baseUrl = PARITY_PROXY_URL, model = PARITY_DEFAULT_MODEL, fetch: fetchFn = fetch }) {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  return {
    model,
    /** @param {{ system: string, messages: {role: string, content: string}[], json?: boolean }} input */
    async complete({ system, messages, json = false }) {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: system }, ...messages],
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
      });
      if (!response.ok) throw new Error(`Parity proxy answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const data = await response.json();
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text === "") throw new Error("Parity proxy returned an empty answer");
      return text;
    },
  };
}

/** The first JSON object in a model answer, with or without a code fence. */
export function parseJsonAnswer(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("the model did not answer with JSON");
  return JSON.parse(candidate.slice(start, end + 1));
}
