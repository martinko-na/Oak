import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

// The scheduler is the only place the agent talks to the user unprompted, so the
// two side effects it owns (runAgent, sendMessage) are mocked and recorded.
// Requires --experimental-test-module-mocks (set on the npm test script).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oak-scheduler-"));

let scheduleFile = path.join(TMP_DIR, "schedule.json");
let mode = "webhook";
let ownerChatId = "";
let ouraClientId = "";

mock.module("../dist/config.js", {
  namedExports: {
    config: {
      timezone: "Europe/London",
      get scheduleFile() {
        return scheduleFile;
      },
      get mode() {
        return mode;
      },
      get ownerChatId() {
        return ownerChatId;
      },
      get ouraClientId() {
        return ouraClientId;
      },
    },
  },
});

const agentCalls = [];
const sent = [];
let agentBehaviour = () => ({ text: "session ready" });

mock.module("../dist/agent/runner.js", {
  namedExports: {
    runAgent: async (opts) => {
      agentCalls.push(opts);
      return agentBehaviour(opts);
    },
  },
});

mock.module("../dist/channel/notify.js", {
  namedExports: {
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
    },
  },
});

let instance = 0;
async function loadScheduler(opts = {}) {
  scheduleFile = path.join(TMP_DIR, `schedule-${++instance}.json`);
  mode = opts.mode ?? "webhook";
  ownerChatId = opts.ownerChatId ?? "";
  ouraClientId = opts.ouraClientId ?? "";
  if (opts.seed) fs.writeFileSync(scheduleFile, JSON.stringify(opts.seed));
  agentCalls.length = 0;
  sent.length = 0;
  agentBehaviour = opts.agent ?? (() => ({ text: "session ready" }));
  return import(`../dist/scheduler/scheduler.js?instance=${instance}`);
}

const task = (over = {}) => ({
  id: "morning",
  name: "Morning session nudge",
  cron: "0 8 * * *",
  prompt: "What is today's session?",
  chatId: "42",
  enabled: true,
  ...over,
});

test("executeTask sends the agent response to the task's chat", async () => {
  const scheduler = await loadScheduler({ agent: () => ({ text: "Legs today." }) });

  await scheduler.executeTask(task());

  assert.equal(agentCalls.length, 1);
  assert.equal(agentCalls[0].chatId, "42");
  assert.equal(agentCalls[0].userMessage, "What is today's session?");
  assert.deepEqual(sent, [{ chatId: "42", text: "Legs today." }]);
});

test("an empty agent response still sends something rather than a blank message", async () => {
  const scheduler = await loadScheduler({ agent: () => ({ text: "" }) });

  await scheduler.executeTask(task());

  assert.equal(sent[0].text, "(no output)");
});

test("a failing task is reported to the chat instead of crashing the scheduler", async () => {
  const scheduler = await loadScheduler({
    agent: () => {
      throw new Error("connect ETIMEDOUT");
    },
  });

  await scheduler.executeTask(task({ name: "Sunday weekly plan" }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "42");
  assert.match(sent[0].text, /Sunday weekly plan.*failed.*ETIMEDOUT/);
});

test("seeds the default reminders when no schedule file exists and an owner is set", async () => {
  const scheduler = await loadScheduler({ ownerChatId: "99" });

  await scheduler.initScheduler();

  const ids = scheduler.listTasks().map((t) => t.id);
  assert.deepEqual(ids, ["morning-nudge", "weekly-plan"]);
  assert.ok(scheduler.listTasks().every((t) => t.chatId === "99"));
  assert.equal(JSON.parse(fs.readFileSync(scheduleFile, "utf-8")).length, 2);
});

test("seeds nothing when there is no owner chat to send reminders to", async () => {
  const scheduler = await loadScheduler();

  await scheduler.initScheduler();

  assert.deepEqual(scheduler.listTasks(), []);
});

test("webhook mode loads task definitions without starting in-process cron jobs", async () => {
  const scheduler = await loadScheduler({ seed: [task()] });

  await scheduler.initScheduler();

  assert.equal(scheduler.getTask("morning")?.name, "Morning session nudge");
  // No croner job was created, so nothing needs stopping; the external scheduler
  // drives reminders via /cron/run in this mode.
});

test("addTask persists the task and replaces one with the same id", async () => {
  const scheduler = await loadScheduler();
  await scheduler.initScheduler();

  scheduler.addTask(task());
  scheduler.addTask(task({ prompt: "Changed prompt" }));

  assert.equal(scheduler.listTasks().length, 1);
  assert.equal(scheduler.getTask("morning").prompt, "Changed prompt");
  assert.equal(JSON.parse(fs.readFileSync(scheduleFile, "utf-8"))[0].prompt, "Changed prompt");
});

test("removeTask stops a live cron job and reports whether the task existed", async () => {
  const scheduler = await loadScheduler({ mode: "polling" });
  await scheduler.initScheduler();
  // A daily 4am job: it will not fire during the test, and removeTask stops it.
  scheduler.addTask(task({ cron: "0 4 * * *" }));

  assert.equal(scheduler.removeTask("morning"), true);
  assert.equal(scheduler.removeTask("morning"), false);
  assert.deepEqual(scheduler.listTasks(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(scheduleFile, "utf-8")), []);
});

test("a corrupt schedule file falls back to the defaults instead of throwing", async () => {
  scheduleFile = path.join(TMP_DIR, `schedule-corrupt-${++instance}.json`);
  fs.writeFileSync(scheduleFile, "[not json");
  ownerChatId = "99";
  mode = "webhook";

  const scheduler = await import(`../dist/scheduler/scheduler.js?instance=corrupt-${instance}`);
  await scheduler.initScheduler();

  assert.equal(scheduler.listTasks().length, 2);
});

// ─── Oura defaults and one-shot tasks ─────────────────────────────────────────

const waitFor = async (pred, ms = 3000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const oneShot = (over = {}) =>
  task({ id: "oura-retry", name: "Oura sync retry", cron: "", prompt: "Retry Oura.", ...over });

test("seeds the lunch recovery recap only when Oura is configured", async () => {
  const scheduler = await loadScheduler({ ownerChatId: "99", ouraClientId: "oura" });

  await scheduler.initScheduler();

  const ids = scheduler.listTasks().map((t) => t.id);
  assert.deepEqual(ids, ["morning-nudge", "lunch-recovery", "weekly-plan"]);
  assert.equal(scheduler.getTask("lunch-recovery").cron, "30 12 * * *");
});

test("oneShotDisposition: future schedules, recent past fires, stale or invalid drops", async () => {
  const scheduler = await loadScheduler();
  const now = Date.parse("2026-10-07T08:00:00Z");
  const at = (iso) => oneShot({ runAt: iso });

  assert.equal(scheduler.oneShotDisposition(task(), now), null);
  assert.equal(scheduler.oneShotDisposition(at("2026-10-07T08:10:00Z"), now), "schedule");
  assert.equal(scheduler.oneShotDisposition(at("2026-10-07T07:30:00Z"), now), "fire");
  assert.equal(scheduler.oneShotDisposition(at("2026-10-07T05:30:00Z"), now), "drop");
  assert.equal(scheduler.oneShotDisposition(at("not a date"), now), "drop");
});

test("a one-shot fires once in polling mode and removes itself", async () => {
  const scheduler = await loadScheduler({ mode: "polling" });
  await scheduler.initScheduler();

  scheduler.addTask(oneShot({ runAt: new Date(Date.now() + 1100).toISOString() }));
  assert.equal(scheduler.listTasks().length, 1);

  await waitFor(() => sent.length === 1);
  assert.equal(agentCalls[0].userMessage, "Retry Oura.");
  assert.deepEqual(scheduler.listTasks(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(scheduleFile, "utf-8")), []);
});

test("a cancelled one-shot never fires", async () => {
  const scheduler = await loadScheduler({ mode: "polling" });
  await scheduler.initScheduler();

  scheduler.addTask(oneShot({ runAt: new Date(Date.now() + 1100).toISOString() }));
  assert.equal(scheduler.removeTask("oura-retry"), true);

  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(agentCalls.length, 0);
});

test("after a restart, a recently missed one-shot fires and a stale one is dropped", async () => {
  const recent = oneShot({ id: "recent", runAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  const stale = oneShot({
    id: "stale",
    prompt: "Too late.",
    runAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  });
  const scheduler = await loadScheduler({
    mode: "polling",
    seed: [task({ cron: "0 4 * * *" }), recent, stale],
  });

  await scheduler.initScheduler();
  await waitFor(() => sent.length === 1);

  assert.deepEqual(
    agentCalls.map((c) => c.userMessage),
    ["Retry Oura."],
  );
  assert.deepEqual(
    scheduler.listTasks().map((t) => t.id),
    ["morning"],
  );
  scheduler.removeTask("morning"); // stop the live cron job so the test exits
});

test("re-adding an id reschedules the task instead of running both schedules", async () => {
  const scheduler = await loadScheduler({ mode: "polling" });
  await scheduler.initScheduler();

  // A seconds-level cron, so the job really fires inside the test. The two
  // versions carry different prompts: that is what makes this deterministic
  // regardless of how many ticks elapse. Replacing an id used to leave the
  // first croner job running, so every tick fired both prompts.
  scheduler.addTask(task({ cron: "* * * * * *", prompt: "Stale." }));
  scheduler.addTask(task({ cron: "* * * * * *", prompt: "Current." }));

  await waitFor(() => agentCalls.length >= 1);
  await new Promise((r) => setTimeout(r, 1200)); // let another tick or two land
  const firedPrompts = [...new Set(agentCalls.map((c) => c.userMessage))];
  const callsBeforeRemoval = agentCalls.length;

  assert.equal(scheduler.removeTask("morning"), true); // also stops the live job
  assert.deepEqual(firedPrompts, ["Current."]);
  assert.equal(scheduler.listTasks().length, 0);

  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(agentCalls.length, callsBeforeRemoval);
});

test("a disabled task is not scheduled, and disabling a live one stops it", async () => {
  const scheduler = await loadScheduler({ mode: "polling" });
  await scheduler.initScheduler();

  // addTask used to start a job whatever `enabled` said, so a task added
  // disabled still fired until the next restart.
  scheduler.addTask(task({ id: "off", cron: "* * * * * *", enabled: false }));
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(agentCalls.length, 0);
  assert.equal(scheduler.getTask("off").enabled, false); // persisted, just not running

  // Disabling a task that is already live has to stop its job too.
  scheduler.addTask(task({ id: "on", cron: "* * * * * *" }));
  await waitFor(() => agentCalls.length >= 1);
  scheduler.addTask(task({ id: "on", cron: "* * * * * *", enabled: false }));
  const callsWhenDisabled = agentCalls.length;

  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(agentCalls.length, callsWhenDisabled);
});
