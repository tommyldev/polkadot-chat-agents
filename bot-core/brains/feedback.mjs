// SPDX-License-Identifier: GPL-3.0-or-later

import fs from "node:fs";
import path from "node:path";
import { parseJsonAnswer } from "../lib/parity-llm.mjs";

export const FEEDBACK_STAGES = Object.freeze(["intake", "filed"]);

const MAX_FOLLOW_UPS = 1;

const TICKET_FIELDS = ["title", "summary", "steps", "expected", "actual", "environment", "area"];

const INTAKE_SYSTEM = `You are the T3ams feedback agent. T3ams is a private team chat app on Polkadot (workspaces, channels, direct messages, calls, files). A person is telling you about a problem and you turn it into a bug report. They want it filed, not an interview.

Set "done" to true as soon as you can tell what went wrong: one sentence from them is usually enough. Work out the steps and the expected behaviour from what they said, and leave what you cannot know empty. Also set it when they tell you to file it or have nothing to add.

Ask a question only when you cannot tell what the problem is (a greeting, "it's broken"). Ask one thing, in one short sentence. Never ask how often it happens, when it started, which platform or device they use, or for steps, logs or versions: the app collects technical details separately.

If they are not reporting a problem with T3ams (a greeting, small talk, a question about you), leave the ticket empty, set "done" to false and answer in one short sentence. Never say an issue was filed or will be filed, and do not promise fixes: the app reports the filing itself. Keep replies under 30 words.

Answer ONLY with a JSON object: {"reply": "<what to say to the person>", "done": <true or false>, "ticket": {"title": "<imperative, under 80 chars, e.g. 'Reactions disappear after reload in group chats'>", "summary": "<2-3 sentences>", "steps": ["..."], "expected": "...", "actual": "...", "environment": "<platform, how often, since when, if they said>", "area": "<one of: messaging, calls, notifications, identity, accounts, signing, loading, mobile, other>"}}. Fill ticket fields with what you know so far; empty strings or arrays when unknown.`;

const MENTION_SYSTEM = `You are the T3ams feedback agent. T3ams is a private team chat app on Polkadot (workspaces, channels, direct messages, calls, files). Someone in a channel just mentioned you. You get the recent chat transcript and the mention.

First decide whether they are reporting a problem with T3ams, often about what was said just before ("this response sucks", "the call dropped again", "why did this message arrive twice?"). A greeting, small talk, a check that you are there ("you alive?", "what's up") or a question about you is NOT a report: set "report" to false, leave the ticket empty and answer in one short, friendly sentence. Never invent a problem and never report on yourself.

For a report, set "report" to true and write a bug report a developer can act on from the transcript and the mention alone; do not ask questions. Never say an issue was filed: the app reports that itself.

Answer ONLY with a JSON object: {"report": <true or false>, "reply": "<one sentence to the person, under 25 words>", "ticket": {"title": "<imperative, under 80 chars>", "summary": "<2-4 sentences: what went wrong, quoting the relevant chat lines where useful>", "steps": ["..."], "expected": "...", "actual": "...", "environment": "<what the transcript tells you, else empty>", "area": "<one of: messaging, calls, notifications, identity, accounts, signing, loading, mobile, other>"}}. Use empty strings or arrays for what the transcript does not tell you.`;

const FOLLOW_UP_SYSTEM = `You are the T3ams feedback agent. You already filed the bug report below, and the person wrote again in the same conversation. Answer ONLY with a JSON object: {"reply": "<one short sentence; empty when no answer is needed (thanks, ok, declining to share client info)>", "addition": "<new detail about the same problem worth adding to the issue; empty when there is none>"}. Answer when they talk to you ("still there?"). Do not ask questions, do not promise fixes, and never say anything was filed or added: the app reports that itself. For a different problem, tell them to mention you in a new message.`;

const AREA_LABEL = Object.freeze({
  messaging: "area:messaging",
  calls: "area:calls",
  notifications: "area:notifications",
  identity: "area:identity",
  accounts: "area:accounts",
  signing: "area:signing",
  loading: "area:loading",
  mobile: "area:mobile",
});

const normalizeTicket = (raw = {}) => {
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const steps = Array.isArray(raw.steps) ? raw.steps.map(text).filter(Boolean) : [];
  const ticket = Object.fromEntries(TICKET_FIELDS.map((field) => [field, field === "steps" ? steps : text(raw[field])]));
  ticket.area = Object.hasOwn(AREA_LABEL, ticket.area) ? ticket.area : "other";
  return ticket;
};

const transcriptMarkdown = (history) =>
  history.map((h) => `${new Date(h.timestamp).toISOString().slice(11, 16)} **${h.senderName}:** ${h.text.replace(/\s+/g, " ").trim()}`).join("\n");

/** The client info a reporter shared, as an issue comment. */
export function renderReportComment(report, reporter) {
  return (
    `Client info shared by ${reporter} (${report.logs.length} log lines${report.truncated ? ", truncated" : ""}):\n\n` +
    `**App**\n\n${Object.entries(report.app).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n\n` +
    (report.capabilities ? `**Capabilities**\n\n\`\`\`\n${report.capabilities}\n\`\`\`\n\n` : "") +
    `<details><summary>App state, journeys and logs</summary>\n\n` +
    `**App state**\n\n\`\`\`json\n${JSON.stringify(report.appState, null, 2)}\n\`\`\`\n\n` +
    `**Journeys**\n\n${report.journeys.map((j) => `- ${j}`).join("\n") || "_none_"}\n\n` +
    `**Logs**\n\n\`\`\`\n${report.logs.join("\n")}\n\`\`\`\n\n</details>`
  );
}

/** Markdown in the order of .github/ISSUE_TEMPLATE/bug_report.yml. */
export function renderIssue(ticket, { reporter, report = null, source, history = [] }) {
  const steps = ticket.steps.length ? ticket.steps.map((step, i) => `${i + 1}. ${step}`).join("\n") : "_Not known yet._";
  const sections = [
    `### Summary\n\n${ticket.summary || ticket.title}`,
    `### Steps to Reproduce\n\n${steps}`,
    `### Expected Behavior\n\n${ticket.expected || "_Not stated._"}`,
    `### Actual Behavior\n\n${ticket.actual || "_Not stated._"}`,
    `### Environment / Context\n\n${[ticket.environment, report ? `t3ams ${report.app.version} (${report.app.commit}) · ${report.app.network} · ${report.app.userAgent}` : null].filter(Boolean).join("\n") || "_Not stated._"}`,
  ];
  if (report) {
    const logs = report.logs.join("\n");
    sections.push(
      `### Logs or Screenshots\n\n<details><summary>Client info shared by the reporter (${report.logs.length} log lines${report.truncated ? ", truncated" : ""})</summary>\n\n` +
        `**App**\n\n${Object.entries(report.app).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n\n` +
        (report.capabilities ? `**Capabilities**\n\n\`\`\`\n${report.capabilities}\n\`\`\`\n\n` : "") +
        `**App state**\n\n\`\`\`json\n${JSON.stringify(report.appState, null, 2)}\n\`\`\`\n\n` +
        `**Journeys**\n\n${report.journeys.map((j) => `- ${j}`).join("\n") || "_none_"}\n\n` +
        `**Logs**\n\n\`\`\`\n${logs}\n\`\`\`\n\n</details>`,
    );
  } else {
    sections.push("### Logs or Screenshots\n\n_The reporter did not share client info._");
  }
  const context = [`Reported by ${reporter} via the T3ams feedback agent (${source}).`];
  if (history.length) context.push(`<details><summary>Chat before the report (${history.length} messages)</summary>\n\n${transcriptMarkdown(history)}\n\n</details>`);
  sections.push(`### Additional Context\n\n${context.join("\n\n")}`);
  return sections.join("\n\n");
}

export function issueLabels(ticket, available) {
  const wanted = ["bug", "lives-in:t3ams", AREA_LABEL[ticket.area]].filter(Boolean);
  return available ? wanted.filter((label) => available.includes(label)) : wanted;
}

const draftWithoutRepository = (ticket) =>
  [
    `I can't file issues from here (no repository is configured), but this is the report:`,
    ``,
    `**${ticket.title}**`,
    ticket.summary,
    ``,
    `Steps: ${ticket.steps.length ? ticket.steps.join(" → ") : "not known yet"}`,
    `Expected: ${ticket.expected || "—"}`,
    `Actual: ${ticket.actual || "—"}`,
    `Environment: ${ticket.environment || "—"}`,
  ].join("\n");

const clientInfoOffer = (issueNumber) => `If you can, share your client info and I'll attach it to #${issueNumber} — it helps the team reproduce this.`;
const nameOf = (senderName) => (typeof senderName === "string" && senderName.trim()) || "A T3ams user";
const isLegacyDraftStage = (stage) => !FEEDBACK_STAGES.includes(stage);
const trimmed = (value) => (typeof value === "string" ? value.trim() : "");
const describesProblem = (ticket) => ticket.title !== "" || ticket.summary !== "";

/**
 * @param {{ llm: { complete(input: object): Promise<string> }, github: { create(issue: object): Promise<{number:number,url:string}>, labels(): Promise<string[]>, repo: string } | null,
 *           stateDir: string, log?: (event: string, fields?: object) => void }} deps
 */
export function createFeedbackAgent({ llm, github, stateDir, log = () => {} }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const fileOf = (key) => path.join(stateDir, `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  const fresh = () => ({ stage: "intake", history: [], ticket: normalizeTicket(), report: null, asked: 0, filed: null });
  const load = (key) => {
    let state;
    try { state = JSON.parse(fs.readFileSync(fileOf(key), "utf8")); } catch { return fresh(); }
    if (isLegacyDraftStage(state.stage)) { state.stage = "intake"; state.asked = MAX_FOLLOW_UPS; }
    return state;
  };
  const save = (key, state) => fs.writeFileSync(fileOf(key), JSON.stringify(state), { mode: 0o600 });
  let labelsAvailable = null;

  const intakeTurn = async (state, text, senderName) => {
    state.history.push({ role: "user", content: `${senderName}: ${text}` });
    const answer = parseJsonAnswer(await llm.complete({ system: INTAKE_SYSTEM, messages: state.history.slice(-24), json: true }));
    state.ticket = normalizeTicket(answer.ticket);
    const described = describesProblem(state.ticket);
    const asked = state.asked ?? 0;
    const done = described && (answer.done === true || asked >= MAX_FOLLOW_UPS);
    const reply = typeof answer.reply === "string" && answer.reply.trim() ? answer.reply.trim() : "What went wrong?";
    if (!done) {
      state.history.push({ role: "assistant", content: reply });
      if (described) state.asked = asked + 1;
    }
    return { reply, done };
  };

  const fileTicket = async (key, state, { reporter, source, history = [] }) => {
    if (github == null) { state.stage = "filed"; state.filed = null; return null; }
    labelsAvailable ??= await github.labels();
    const filed = await github.create({
      title: state.ticket.title || "Problem reported in T3ams",
      body: renderIssue(state.ticket, { reporter, report: state.report, source, history }),
      labels: issueLabels(state.ticket, labelsAvailable),
    });
    state.stage = "filed"; state.filed = filed;
    log("FEEDBACK_ISSUE_FILED", { key, number: filed.number, url: filed.url });
    return filed;
  };

  const followUp = async (key, state, message) => {
    const reporter = nameOf(message.senderName);
    try {
      const answer = parseJsonAnswer(await llm.complete({
        system: FOLLOW_UP_SYSTEM,
        messages: [{ role: "user", content: `Report: ${JSON.stringify(state.ticket)}\n\n${reporter}: ${message.text}` }],
        json: true,
      }));
      const reply = trimmed(answer.reply);
      const addition = trimmed(answer.addition);
      if (addition === "" || state.filed == null || github == null) return reply ? [{ say: reply }] : [];
      await github.comment(state.filed.number, `${reporter} added:\n\n${addition}`);
      log("FEEDBACK_COMMENT_ADDED", { key, number: state.filed.number });
      return [{ say: `Added that to ${state.filed.url}.` }];
    } catch (error) {
      log("FEEDBACK_TURN_FAILED", { key, stage: "follow-up", error: String(error?.message ?? error) });
      return [{ say: "Sorry, something went wrong on my side. Could you say that again?" }];
    }
  };

  return {
    /**
     * A message from the person. Returns the actions to take, in order:
     * {say: text} | {requestDiagnostics: reason}.
     * @param {string} key conversation key  @param {{text: string, senderName: string, senderXid: string, source: string}} message
     */
    async onMessage(key, message) {
      let state = load(key);
      const actions = [];
      const reporter = nameOf(message.senderName);
      if (state.stage === "filed") {
        if (message.source !== "direct message") return followUp(key, state, message);
        state = fresh();
      }
      let turn;
      try {
        turn = await intakeTurn(state, message.text, reporter);
      } catch (error) {
        log("FEEDBACK_TURN_FAILED", { key, stage: "intake", error: String(error?.message ?? error) });
        save(key, state);
        return [{ say: "Sorry, something went wrong on my side. Could you say that again?" }];
      }
      if (!turn.done) {
        actions.push({ say: turn.reply });
      } else {
        try {
          const filed = await fileTicket(key, state, { reporter, source: message.source });
          if (filed == null) {
            actions.push({ say: draftWithoutRepository(state.ticket) });
          } else {
            actions.push({ say: `Filed: ${filed.url}\n\nThanks ${reporter} — the team will take it from here.` });
            if (state.report == null) actions.push({ requestDiagnostics: clientInfoOffer(filed.number) });
          }
        } catch (error) {
          state.asked = MAX_FOLLOW_UPS;
          log("FEEDBACK_TURN_FAILED", { key, stage: "file", error: String(error?.message ?? error) });
          actions.push({ say: "I couldn't file that on GitHub just now. I've kept your report — send me a message in a bit and I'll try again." });
        }
      }
      save(key, state);
      return actions;
    },

    /**
     * Mentioned in a channel: file right away from the transcript and the
     * complaint, then invite the reporter to attach their client info.
     * @param {{text: string, senderName: string, senderXid: string, source: string, history: readonly {senderName:string,text:string,timestamp:number,mine:boolean}[]}} mention
     */
    async onMention(key, mention) {
      const state = load(key);
      if (state.stage === "filed") return followUp(key, state, mention);
      const actions = [];
      const reporter = nameOf(mention.senderName);
      try {
        const transcript = mention.history.length
          ? `Recent chat:\n${mention.history.map((h) => `${h.senderName}: ${h.text}`).join("\n")}\n\n`
          : "";
        const answer = parseJsonAnswer(await llm.complete({
          system: MENTION_SYSTEM,
          messages: [{ role: "user", content: `${transcript}Mention by ${reporter}: ${mention.text}` }],
          json: true,
        }));
        const ticket = normalizeTicket(answer.ticket);
        if (answer.report !== true || !describesProblem(ticket)) {
          const reply = trimmed(answer.reply) || "I'm here. Tell me what went wrong in T3ams and I'll file it.";
          state.history.push({ role: "user", content: `${reporter}: ${mention.text}` }, { role: "assistant", content: reply });
          save(key, state);
          return [{ say: reply }];
        }
        state.ticket = ticket;
        state.history = [];
        state.report = null;
        const reply = trimmed(answer.reply) || "Thanks, noted.";
        const filed = await fileTicket(key, state, { reporter, source: mention.source, history: mention.history });
        if (filed == null) {
          actions.push({ say: `${reply}\n\n${draftWithoutRepository(state.ticket)}` });
        } else {
          actions.push({ say: `${reply}\n\nIssue filed: ${filed.url}` });
          actions.push({ requestDiagnostics: clientInfoOffer(filed.number) });
        }
      } catch (error) {
        log("FEEDBACK_TURN_FAILED", { key, stage: "mention", error: String(error?.message ?? error) });
        actions.push({ say: "Sorry, I couldn't file that right now. Could you try again in a moment?" });
      }
      save(key, state);
      return actions;
    },

    /** The person shared their client info. */
    async onDiagnostics(key, report, senderName = "the reporter") {
      const state = load(key);
      // After a quick filing from a channel mention: attach it to that issue.
      if (state.stage === "filed" && state.filed != null && github != null) {
        try {
          await github.comment(state.filed.number, renderReportComment(report, senderName));
          log("FEEDBACK_REPORT_ATTACHED", { key, number: state.filed.number });
          return [{ say: `Attached your client info to ${state.filed.url}. Thanks!` }];
        } catch (error) {
          log("FEEDBACK_TURN_FAILED", { key, stage: "attach", error: String(error?.message ?? error) });
          return [{ say: "Thanks — I couldn't attach that to the issue right now, but the report itself is filed." }];
        }
      }
      state.report = report;
      save(key, state);
      return [{ say: `Got it — t3ams ${report.app.version} on ${report.app.network}, ${report.logs.length} log lines. I'll include it in the issue.` }];
    },

    stageOf: (key) => load(key).stage,
  };
}
