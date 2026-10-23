import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFeedbackAgent, issueLabels, renderIssue } from "../brains/feedback.mjs";
import { createGithubIssues } from "../lib/github-issues.mjs";
import { createParityLlm, parseJsonAnswer } from "../lib/parity-llm.mjs";

const ticket = {
  title: "Reactions vanish after reload",
  summary: "Emoji reactions in group chats disappear once the app is reloaded.",
  steps: ["Open a group chat", "React to a message", "Reload"],
  expected: "The reaction stays.",
  actual: "The reaction is gone.",
  environment: "Desktop app, always, since last week",
  area: "messaging",
};
const report = {
  version: 1,
  collectedAt: 1,
  app: { version: "0.9.1", commit: "abc1234", network: "paseo-next-v2", userAgent: "Chrome" },
  capabilities: "host: desktop",
  appState: { session: { status: "ready" } },
  journeys: ["dm.send ok 120ms"],
  logs: ["INFO hello", "WARN something"],
  truncated: false,
};

function scripted(answers) {
  const calls = [];
  return {
    calls,
    async complete(input) {
      calls.push(input);
      const next = answers.shift();
      if (next == null) throw new Error("no scripted answer left");
      return typeof next === "string" ? next : JSON.stringify(next);
    },
  };
}

const fakeGithub = () => {
  const created = [];
  return { repo: "o/r", created, labels: async () => ["bug", "lives-in:t3ams", "area:messaging"], create: async (issue) => { created.push(issue); return { number: 7, url: "https://github.com/o/r/issues/7" }; } };
};

test("feedback agent: intake → client info → confirm → filed, with state on disk", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pca-feedback-"));
  const llm = scripted([
    { reply: "Sorry about that. Where does it happen, and on which device?", done: false, ticket: { title: "Reactions vanish", area: "messaging" } },
    { reply: "Thanks, that's everything I need.", done: true, ticket },
    { decision: "file", reply: "Filing.", ticket },
  ]);
  const github = fakeGithub();
  const agent = createFeedbackAgent({ llm, github, stateDir });

  let actions = await agent.onMessage("dm-1", { text: "my reactions keep disappearing", senderName: "Tommy", senderXid: "aa", source: "direct message" });
  assert.deepEqual(actions, [{ say: "Sorry about that. Where does it happen, and on which device?" }]);
  assert.equal(agent.stageOf("dm-1"), "intake");
  assert.match(llm.calls[0].messages[0].content, /^Tommy: my reactions/);

  actions = await agent.onMessage("dm-1", { text: "group chats on desktop, every time, since last week", senderName: "Tommy", senderXid: "aa", source: "direct message" });
  assert.equal(actions[0].say, "Thanks, that's everything I need.");
  assert.match(actions[1].requestDiagnostics, /client info/);
  assert.equal(agent.stageOf("dm-1"), "diagnostics");

  // A restart in the middle keeps the conversation.
  const again = createFeedbackAgent({ llm, github, stateDir });
  actions = await again.onDiagnostics("dm-1", report);
  assert.match(actions[0].say, /t3ams 0\.9\.1 on paseo-next-v2, 2 log lines/);
  assert.match(actions[0].say, /\*\*Reactions vanish after reload\*\*/);
  assert.equal(again.stageOf("dm-1"), "confirm");

  actions = await again.onMessage("dm-1", { text: "yes please", senderName: "Tommy", senderXid: "aa", source: "direct message" });
  assert.equal(actions[0].say, "Filed: https://github.com/o/r/issues/7\n\nThanks Tommy — the team will take it from here.");
  assert.equal(again.stageOf("dm-1"), "filed");
  assert.equal(github.created.length, 1);
  assert.equal(github.created[0].title, "Reactions vanish after reload");
  assert.deepEqual(github.created[0].labels, ["bug", "lives-in:t3ams", "area:messaging"]);
  assert.match(github.created[0].body, /### Steps to Reproduce\n\n1\. Open a group chat\n2\. React/);
  assert.match(github.created[0].body, /<details><summary>Client info shared by the reporter \(2 log lines\)/);
  assert.match(github.created[0].body, /Reported by Tommy via the T3ams feedback agent \(direct message\)/);
});

test("feedback agent: declining client info still drafts, revisions re-draft, cancel files nothing", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pca-feedback-"));
  const llm = scripted([
    { reply: "Got it.", done: true, ticket },
    { decision: "revise", reply: "Updated.", ticket: { ...ticket, title: "Reactions vanish after reload in group chats" } },
    { decision: "cancel", reply: "Okay, nothing filed.", ticket },
  ]);
  const github = fakeGithub();
  const agent = createFeedbackAgent({ llm, github, stateDir });
  await agent.onMessage("t-1", { text: "reactions vanish", senderName: "A", senderXid: "aa", source: "channel thread" });
  let actions = await agent.onMessage("t-1", { text: "I'd rather not share", senderName: "A", senderXid: "aa", source: "channel thread" });
  assert.match(actions[0].say, /^No problem, I'll file it without client info\./);
  assert.equal(agent.stageOf("t-1"), "confirm");
  actions = await agent.onMessage("t-1", { text: "mention group chats in the title", senderName: "A", senderXid: "aa", source: "channel thread" });
  assert.match(actions[0].say, /\*\*Reactions vanish after reload in group chats\*\*/);
  actions = await agent.onMessage("t-1", { text: "actually forget it", senderName: "A", senderXid: "aa", source: "channel thread" });
  assert.equal(actions[0].say, "Okay, nothing filed.");
  assert.equal(github.created.length, 0);
  assert.equal(agent.stageOf("t-1"), "filed");
});

test("feedback agent: a model or GitHub failure is reported, not fatal", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pca-feedback-"));
  const events = [];
  const agent = createFeedbackAgent({ llm: scripted(["not json at all"]), github: null, stateDir, log: (e, f) => events.push([e, f]) });
  const actions = await agent.onMessage("x", { text: "hi", senderName: "A", senderXid: "aa", source: "direct message" });
  assert.match(actions[0].say, /something went wrong/);
  assert.equal(events[0][0], "FEEDBACK_TURN_FAILED");
});

test("renderIssue without a report, and labels limited to what the repo has", () => {
  const body = renderIssue({ ...ticket, steps: [] }, { reporter: "A", source: "direct message" });
  assert.match(body, /### Steps to Reproduce\n\n_Not known yet\._/);
  assert.match(body, /_The reporter did not share client info\._/);
  assert.deepEqual(issueLabels({ ...ticket, area: "calls" }, ["bug", "area:calls"]), ["bug", "area:calls"]);
  assert.deepEqual(issueLabels({ ...ticket, area: "other" }, null), ["bug", "lives-in:t3ams"]);
});

test("parseJsonAnswer tolerates fences and prose; clients send what the APIs expect", async () => {
  assert.deepEqual(parseJsonAnswer('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonAnswer('{"a":{"b":2}} trailing'), { a: { b: 2 } });
  assert.throws(() => parseJsonAnswer("nope"), /did not answer with JSON/);

  const requests = [];
  const fetchFn = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200, json: async () => (url.endsWith("/issues") ? { number: 3, html_url: "u" } : { choices: [{ message: { content: "{\"x\":1}" } }] }), text: async () => "" };
  };
  const llm = createParityLlm({ key: "k", baseUrl: "http://p/v1/", fetch: fetchFn });
  assert.equal(await llm.complete({ system: "s", messages: [{ role: "user", content: "u" }], json: true }), "{\"x\":1}");
  assert.equal(requests[0].url, "http://p/v1/chat/completions");
  assert.equal(requests[0].init.headers.authorization, "Bearer k");
  assert.equal(JSON.parse(requests[0].init.body).response_format.type, "json_object");

  const gh = createGithubIssues({ token: "t", repo: "o/r", apiUrl: "http://g", fetch: fetchFn });
  assert.deepEqual(await gh.create({ title: "T", body: "B", labels: ["bug"] }), { number: 3, url: "u" });
  assert.equal(requests[1].url, "http://g/repos/o/r/issues");
  assert.equal(JSON.parse(requests[1].init.body).labels[0], "bug");
  assert.throws(() => createGithubIssues({ token: "t", repo: "bad" }), /owner\/name/);
});

test("feedback agent: a channel mention files from the transcript, then attaches shared client info as a comment", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pca-feedback-"));
  const llm = scripted([{ reply: "Sorry about that — filing it now.", ticket }]);
  const github = fakeGithub();
  const comments = [];
  github.comment = async (number, body) => { comments.push({ number, body }); return { url: "c" }; };
  const agent = createFeedbackAgent({ llm, github, stateDir });
  const history = [
    { senderName: "Alice", text: "did you see my reaction?", timestamp: 1_700_000_000_000, mine: false },
    { senderName: "Bob", text: "no, it's gone after reload", timestamp: 1_700_000_060_000, mine: false },
  ];
  let actions = await agent.onMention("t-9", { text: "@t3ams-admin this is broken", senderName: "Bob", senderXid: "bb", source: "#general", history });
  assert.match(llm.calls[0].messages[0].content, /Recent chat:\nAlice: did you see my reaction\?\nBob: no, it's gone after reload\n\nMention by Bob: @t3ams-admin this is broken/);
  assert.equal(actions[0].say, "Sorry about that — filing it now.\n\nIssue filed: https://github.com/o/r/issues/7");
  assert.match(actions[1].requestDiagnostics, /attach it to #7/);
  assert.match(github.created[0].body, /Chat before the report \(2 messages\)/);
  assert.match(github.created[0].body, /\*\*Bob:\*\* no, it's gone after reload/);
  assert.equal(agent.stageOf("t-9"), "filed");

  actions = await agent.onDiagnostics("t-9", report, "Bob");
  assert.equal(actions[0].say, "Attached your client info to https://github.com/o/r/issues/7. Thanks!");
  assert.equal(comments[0].number, 7);
  assert.match(comments[0].body, /Client info shared by Bob \(2 log lines\)/);

  // "thanks" in the thread is not a new report.
  assert.deepEqual(await agent.onMessage("t-9", { text: "thanks!", senderName: "Bob", senderXid: "bb", source: "#general" }), []);
});
