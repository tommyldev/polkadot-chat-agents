// SPDX-License-Identifier: GPL-3.0-or-later

// The feedback agent: a person tells it about a problem in T3ams, it asks
// what it needs to know, requests their client info (the app shows a consent
// card and shares a redacted report), drafts a bug report in the shape of
// the repository's issue template, and files it once the person says yes.
//
// One conversation per DM or channel thread, kept on disk so a restart does
// not lose an intake half-way. The model only ever writes replies and the
// ticket fields; every decision (when to ask for client info, when to file)
// is made here.

import fs from "node:fs";
import path from "node:path";
import { parseJsonAnswer } from "../lib/parity-llm.mjs";

export const FEEDBACK_STAGES = Object.freeze(["intake", "diagnostics", "confirm", "filed"]);

const TICKET_FIELDS = ["title", "summary", "steps", "expected", "actual", "environment", "area"];

const INTAKE_SYSTEM = `You are the T3ams feedback agent. T3ams is a private team chat app on Polkadot (workspaces, channels, direct messages, calls, files). A person is telling you about a problem. Your job is to collect what a developer needs to reproduce it, in a short, friendly conversation — one or two questions at a time, never a form.

You need, before you are done:
- what happened and where in the app (direct message, channel, call, settings, onboarding...);
- what they expected instead;
- the steps that lead to it, as far as they can tell;
- how often it happens (always / sometimes / once) and when it started;
- their platform (phone, desktop app, browser) if they haven't said.

Do not ask for logs, versions or technical details: the app collects those separately. Do not promise fixes. Keep replies under 60 words.

Answer ONLY with a JSON object: {"reply": "<what to say to the person>", "done": <true when you have everything above>, "ticket": {"title": "<imperative, under 80 chars, e.g. 'Reactions disappear after reload in group chats'>", "summary": "<2-3 sentences>", "steps": ["..."], "expected": "...", "actual": "...", "environment": "<platform, how often, since when>", "area": "<one of: messaging, calls, notifications, identity, accounts, signing, loading, mobile, other>"}}. Fill ticket fields with what you know so far; empty strings or arrays when unknown.`;

const MENTION_SYSTEM = `You are the T3ams feedback agent. T3ams is a private team chat app on Polkadot (workspaces, channels, direct messages, calls, files). Someone in a channel just mentioned you to report a problem — often about what was said just before ("this response sucks", "the call dropped again", "why did this message arrive twice?"). You get the recent chat transcript and the mention. Write a bug report a developer can act on from that alone; do not ask questions.

Answer ONLY with a JSON object: {"reply": "<one sentence to the reporter, under 25 words>", "ticket": {"title": "<imperative, under 80 chars>", "summary": "<2-4 sentences: what went wrong, quoting the relevant chat lines where useful>", "steps": ["..."], "expected": "...", "actual": "...", "environment": "<what the transcript tells you, else empty>", "area": "<one of: messaging, calls, notifications, identity, accounts, signing, loading, mobile, other>"}}. Use empty strings or arrays for what the transcript does not tell you.`;

const CONFIRM_SYSTEM = `You are the T3ams feedback agent. The person has reviewed a draft bug report. Decide what they want from their latest message. Answer ONLY with JSON: {"decision": "file" | "revise" | "cancel", "reply": "<one short sentence>", "ticket": <the ticket with their requested changes applied, same shape as given>}. "file" when they agree (yes, looks good, go ahead...), "revise" when they ask for changes, "cancel" when they do not want an issue after all.`;

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

const draftText = (ticket) =>
  [
    `Here's the issue I'd file:`,
    ``,
    `**${ticket.title}**`,
    ticket.summary,
    ``,
    `Steps: ${ticket.steps.length ? ticket.steps.join(" → ") : "not known yet"}`,
    `Expected: ${ticket.expected || "—"}`,
    `Actual: ${ticket.actual || "—"}`,
    `Environment: ${ticket.environment || "—"}`,
    ``,
    `Shall I file it? Say yes, or tell me what to change.`,
  ].join("\n");

/**
 * @param {{ llm: { complete(input: object): Promise<string> }, github: { create(issue: object): Promise<{number:number,url:string}>, labels(): Promise<string[]>, repo: string } | null,
 *           stateDir: string, log?: (event: string, fields?: object) => void }} deps
 */
export function createFeedbackAgent({ llm, github, stateDir, log = () => {} }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const fileOf = (key) => path.join(stateDir, `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  const load = (key) => {
    try { return JSON.parse(fs.readFileSync(fileOf(key), "utf8")); } catch { return { stage: "intake", history: [], ticket: normalizeTicket(), report: null }; }
  };
  const save = (key, state) => fs.writeFileSync(fileOf(key), JSON.stringify(state), { mode: 0o600 });
  let labelsAvailable = null;

  const intakeTurn = async (state, text, senderName) => {
    state.history.push({ role: "user", content: `${senderName}: ${text}` });
    const answer = parseJsonAnswer(await llm.complete({ system: INTAKE_SYSTEM, messages: state.history.slice(-24), json: true }));
    const reply = typeof answer.reply === "string" && answer.reply.trim() ? answer.reply.trim() : "Could you tell me a bit more?";
    state.history.push({ role: "assistant", content: reply });
    state.ticket = normalizeTicket(answer.ticket);
    return { reply, done: answer.done === true };
  };

  return {
    /**
     * A message from the person. Returns the actions to take, in order:
     * {say: text} | {requestDiagnostics: reason}.
     * @param {string} key conversation key  @param {{text: string, senderName: string, senderXid: string, source: string}} message
     */
    async onMessage(key, message) {
      const state = load(key);
      const actions = [];
      try {
        if (state.stage === "filed") {
          // In a channel thread the issue is filed; "thanks" needs no answer. A DM starts a new report.
          if (message.source !== "direct message") { save(key, state); return actions; }
          state.stage = "intake"; state.history = []; state.ticket = normalizeTicket(); state.report = null; state.filed = null;
        }
        if (state.stage === "intake") {
          const { reply, done } = await intakeTurn(state, message.text, message.senderName);
          actions.push({ say: reply });
          if (done) {
            state.stage = "diagnostics";
            actions.push({ requestDiagnostics: "To look into this I'd like your client info: app version, settings and recent logs. You'll see exactly what is shared before you decide." });
          }
        } else if (state.stage === "diagnostics") {
          // They answered with words instead of sharing (declined, or more detail).
          if (/rather not|not now|no thanks|don't want|dont want|skip/i.test(message.text)) {
            state.stage = "confirm";
            actions.push({ say: `No problem, I'll file it without client info.\n\n${draftText(state.ticket)}` });
          } else {
            const { reply } = await intakeTurn(state, message.text, message.senderName);
            actions.push({ say: `${reply}\n\n(Whenever you're ready, share your client info with the card above, or say "skip".)` });
          }
        } else if (state.stage === "confirm") {
          const answer = parseJsonAnswer(await llm.complete({
            system: CONFIRM_SYSTEM,
            messages: [{ role: "user", content: `Draft ticket: ${JSON.stringify(state.ticket)}\n\nTheir message: ${message.text}` }],
            json: true,
          }));
          if (answer.decision === "file") {
            if (github == null) throw new Error("no GitHub repository is configured (BOT_FEEDBACK_REPO)");
            labelsAvailable ??= await github.labels();
            const filed = await github.create({
              title: state.ticket.title || "Problem reported in T3ams",
              body: renderIssue(state.ticket, { reporter: message.senderName, report: state.report, source: message.source }),
              labels: issueLabels(state.ticket, labelsAvailable),
            });
            state.stage = "filed"; state.filed = filed;
            log("FEEDBACK_ISSUE_FILED", { key, number: filed.number, url: filed.url });
            actions.push({ say: `Filed: ${filed.url}\n\nThanks ${message.senderName} — the team will take it from here.` });
          } else if (answer.decision === "cancel") {
            state.stage = "filed"; state.filed = null;
            actions.push({ say: typeof answer.reply === "string" && answer.reply ? answer.reply : "Okay, I won't file anything. Message me again any time." });
          } else {
            state.ticket = normalizeTicket(answer.ticket ?? state.ticket);
            actions.push({ say: draftText(state.ticket) });
          }
        }
      } catch (error) {
        log("FEEDBACK_TURN_FAILED", { key, stage: state.stage, error: String(error?.message ?? error) });
        actions.push({ say: "Sorry, something went wrong on my side. Could you say that again?" });
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
      const actions = [];
      try {
        const transcript = mention.history.length
          ? `Recent chat:\n${mention.history.map((h) => `${h.senderName}: ${h.text}`).join("\n")}\n\n`
          : "";
        const answer = parseJsonAnswer(await llm.complete({
          system: MENTION_SYSTEM,
          messages: [{ role: "user", content: `${transcript}Mention by ${mention.senderName}: ${mention.text}` }],
          json: true,
        }));
        state.ticket = normalizeTicket(answer.ticket);
        state.history = [];
        state.report = null;
        const reply = typeof answer.reply === "string" && answer.reply.trim() ? answer.reply.trim() : "Thanks, noted.";
        if (github == null) {
          state.stage = "confirm";
          actions.push({ say: `${reply}\n\n${draftText(state.ticket)}` });
        } else {
          labelsAvailable ??= await github.labels();
          const filed = await github.create({
            title: state.ticket.title || "Problem reported in T3ams",
            body: renderIssue(state.ticket, { reporter: mention.senderName, source: mention.source, history: mention.history }),
            labels: issueLabels(state.ticket, labelsAvailable),
          });
          state.stage = "filed"; state.filed = filed;
          log("FEEDBACK_ISSUE_FILED", { key, number: filed.number, url: filed.url });
          actions.push({ say: `${reply}\n\nIssue filed: ${filed.url}` });
          actions.push({ requestDiagnostics: `If you can, share your client info and I'll attach it to #${filed.number} — it helps the team reproduce this.` });
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
      if (state.stage === "intake" || state.stage === "diagnostics") state.stage = "confirm";
      save(key, state);
      return [{ say: `Got it — t3ams ${report.app.version} on ${report.app.network}, ${report.logs.length} log lines.\n\n${draftText(state.ticket)}` }];
    },

    stageOf: (key) => load(key).stage,
  };
}
