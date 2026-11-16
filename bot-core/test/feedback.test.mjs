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
  const comments = [];
  return {
    repo: "o/r", created, comments,
    labels: async () => ["bug", "lives-in:t3ams", "area:messaging"],
    create: async (issue) => { created.push(issue); return { number: 7, url: "https://github.com/o/r/issues/7" }; },
    comment: async (number, body) => { comments.push({ number, body }); return { url: "c" }; },
  };
};
const dm = (text, senderName = "Tommy") => ({ text, senderName, senderXid: "aa", source: "direct message" });

test("feedback agent: a DM asks at most one question, files, then attaches shared client info", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pca-feedback-"));
  const secondQuestionNeverAsked = { reply: "Does it fail every time, and on which device?", done: false, ticket };
  const llm = scripted([
    { reply: "Where does it happen?", done: false, ticket: { title: "Reactions vanish", area: "messaging" } },
    secondQuestionNeverAsked,
  ]);
  const github = fakeGithub();
  const agent = createFeedbackAgent({ llm, github, stateDir });

  let actions = await agent.onMessage("dm-1", dm("my reactions keep disappearing"));
  assert.deepEqual(actions, [{ say: "Where does it happen?" }]);
  assert.equal(agent.stageOf("dm-1"), "intake");
  assert.match(llm.calls[0].messages[0].content, /^Tommy: my reactions/);

  // A restart in the middle keeps the conversation.
  const again = createFeedbackAgent({ llm, github, stateDir });
  actions = await again.onMessage("dm-1", dm("in group chats"));
  assert.equal(actions[0].say, "Filed: https://github.com/o/r/issues/7\n\nThanks Tommy — the team will take it from here.");
  assert.match(actions[1].requestDiagnostics, /attach it to #7/);
  assert.equal(actions.length, 2);
  assert.equal(again.stageOf("dm-1"), "filed");
  assert.equal(github.created.length, 1);
  assert.equal(github.created[0].title, "Reactions vanish after reload");
  assert.deepEqual(github.created[0].labels, ["bug", "lives-in:t3ams", "area:messaging"]);
  assert.match(github.created[0].body, /### Steps to Reproduce\n\n1\. Open a group chat\n2\. React/);
  assert.match(github.created[0].body, /_The reporter did not share client info\._/);
  assert.match(github.created[0].body, /Reported by Tommy via the T3ams feedback agent \(direct message\)/);

  actions = await again.onDiagnostics("dm-1", report, "Tommy");
  assert.equal(actions[0].say, "Attached your client info to https://github.com/o/r/issues/7. Thanks!");
  assert.match(github.comments[0].body, /Client info shared by Tommy \(2 log lines\)/);
});

test("feedback agent: a greeting is not a report, one clear sentence files, a nameless sender still gets a reporter", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pca-feedback-"));
  const llm = scripted([
    { reply: "Hi! What went wrong?", done: true, ticket: {} },
    { reply: "Filed it!", done: true, ticket },
  ]);
  const github = fakeGithub();
  const agent = createFeedbackAgent({ llm, github, stateDir });
  assert.deepEqual(await agent.onMessage("dm-2", dm("hi", "")), [{ say: "Hi! What went wrong?" }]);
  assert.equal(github.created.length, 0);
  const actions = await agent.onMessage("dm-2", dm("reactions vanish after reload in group chats", ""));
  assert.match(actions[0].say, /^Filed: https:\/\/github\.com\/o\/r\/issues\/7\n\nThanks A T3ams user/);
  assert.match(github.created[0].body, /Reported by A T3ams user via/);
  assert.equal(github.created.length, 1);
});

test("feedback agent: a GitHub failure keeps the report and the next message files it; an old draft on disk files with its client info", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pca-feedback-"));
  const github = fakeGithub();
  const create = github.create;
  github.create = async () => { throw new Error("GitHub answered 404"); };
  const events = [];
  const llm = scripted([{ reply: "ok", done: true, ticket }, { reply: "Anything else?", done: false, ticket }, { reply: "ok", done: false, ticket }]);
  const agent = createFeedbackAgent({ llm, github, stateDir, log: (e, f) => events.push([e, f]) });
  let actions = await agent.onMessage("dm-3", dm("reactions vanish"));
  assert.match(actions[0].say, /couldn't file that on GitHub/);
  assert.deepEqual(events[0], ["FEEDBACK_TURN_FAILED", { key: "dm-3", stage: "file", error: "GitHub answered 404" }]);
  assert.equal(agent.stageOf("dm-3"), "intake");
  github.create = create;
  actions = await agent.onMessage("dm-3", dm("try again"));
  assert.match(actions[0].say, /^Filed: /);

  fs.writeFileSync(path.join(stateDir, "dm-4.json"), JSON.stringify({ stage: "confirm", history: [], ticket, report }));
  actions = await agent.onMessage("dm-4", dm("yes"));
  assert.match(actions[0].say, /^Filed: /);
  assert.equal(actions.length, 1);
  assert.match(github.created[1].body, /Client info shared by the reporter \(2 log lines\)/);
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
  const llm = scripted([
    { report: true, reply: "Sorry about that — filing it now.", ticket },
    { reply: "", addition: "" },
    { reply: "Yes, I'm here.", addition: "" },
    { reply: "Noted.", addition: "Also happens in DMs." },
  ]);
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

  const inThread = (text) => ({ text, senderName: "Bob", senderXid: "bb", source: "channel thread" });
  assert.deepEqual(await agent.onMessage("t-9", inThread("thanks!")), []);
  assert.deepEqual(await agent.onMessage("t-9", inThread("you still listening?")), [{ say: "Yes, I'm here." }]);
  assert.deepEqual(await agent.onMention("t-9", { ...inThread("@t3ams-admin it also happens in DMs"), history }), [{ say: "Added that to https://github.com/o/r/issues/7." }]);
  assert.equal(comments[1].body, "Bob added:\n\nAlso happens in DMs.");
  assert.equal(github.created.length, 1);
});

test("feedback agent: a mention that is not a report gets an answer and no issue; a problem later in that thread is filed", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pca-feedback-"));
  const inventedTicket = { title: "Bot does not reply to mentions", summary: "The bot was silent." };
  const llm = scripted([
    { report: false, reply: "Alive and well!", ticket: inventedTicket },
    { reply: "ok", done: true, ticket },
  ]);
  const github = fakeGithub();
  const agent = createFeedbackAgent({ llm, github, stateDir });
  let actions = await agent.onMention("t-10", { text: "@t3ams-admin you alive or dead?", senderName: "Bob", senderXid: "bb", source: "#general", history: [] });
  assert.deepEqual(actions, [{ say: "Alive and well!" }]);
  assert.equal(github.created.length, 0);
  assert.equal(agent.stageOf("t-10"), "intake");

  actions = await agent.onMessage("t-10", { text: "ok, my reactions vanish after reload", senderName: "Bob", senderXid: "bb", source: "channel thread" });
  assert.match(actions[0].say, /^Filed: https:\/\/github\.com\/o\/r\/issues\/7/);
  assert.match(llm.calls[1].messages[0].content, /^Bob: @t3ams-admin you alive or dead\?/);
  assert.equal(github.created.length, 1);
});
