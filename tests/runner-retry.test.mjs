import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, mock, test } from "node:test";

// The runner drives the Agent SDK, so the SDK specifier is mocked before the
// compiled runner is imported. Requires --experimental-test-module-mocks (set on
// the npm test script). Config is read at import time, hence the dummy env and
// the temp session file: nothing here should touch the real data/ directory.
process.env.TELEGRAM_BOT_TOKEN ??= "0:test";
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oak-runner-"));
process.env.SESSION_FILE = path.join(TMP_DIR, "sessions.json");
process.env.RUN_LOG_FILE = path.join(TMP_DIR, "agent-runs.jsonl");

/**
 * Each test installs a script: one entry per expected query() call, describing
 * the messages that call yields and whether it then throws. calls records the
 * options the runner passed, so retry counts and resume are assertable.
 */
let script = [];
const calls = [];

mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: (args) => {
      const step = script[calls.length] ?? script[script.length - 1];
      calls.push(args);
      // The real CLI writes to stderr on its own schedule; a step can replay that
      // so the runner's capture of it is assertable.
      if (step.stderr) args.options.stderr?.(step.stderr);
      return (async function* () {
        for (const message of step.messages ?? []) yield message;
        if (step.throws) throw step.throws;
      })();
    },
  },
});

const { runAgent } = await import("../dist/agent/runner.js");

const initMessage = (sessionId) => ({ type: "system", subtype: "init", session_id: sessionId });
const resultMessage = (text) => ({ type: "result", subtype: "success", result: text });

beforeEach(() => {
  script = [];
  calls.length = 0;
});

test("returns the text carried by the result message", async () => {
  script = [{ messages: [initMessage("sess-1"), resultMessage("Squats today. Go.")] }];

  const response = await runAgent({ userMessage: "what today?", chatId: "chat-result" });

  assert.equal(response.text, "Squats today. Go.");
  assert.equal(response.sessionId, "sess-1");
  assert.equal(calls.length, 1);
});

test("resumes the stored session on the next message from the same chat", async () => {
  script = [{ messages: [initMessage("sess-resume"), resultMessage("ok")] }];

  await runAgent({ userMessage: "first", chatId: "chat-resume" });
  await runAgent({ userMessage: "second", chatId: "chat-resume" });

  assert.equal(calls[0].options.resume, undefined);
  assert.equal(calls[1].options.resume, "sess-resume");
});

test("retries a transient failure that happens before the session starts", async () => {
  const transient = new Error("connect ETIMEDOUT 160.79.104.10:443");
  script = [
    { throws: transient },
    { throws: transient },
    { messages: [initMessage("sess-late"), resultMessage("recovered")] },
  ];

  const response = await runAgent({ userMessage: "hi", chatId: "chat-transient" });

  assert.equal(response.text, "recovered");
  // MAX_QUERY_ATTEMPTS is 3: two retries after the initial attempt.
  assert.equal(calls.length, 3);
});

test("gives up after the third attempt and rethrows", async () => {
  script = [{ throws: new Error("fetch failed") }];

  await assert.rejects(runAgent({ userMessage: "hi", chatId: "chat-exhausted" }), /fetch failed/);
  assert.equal(calls.length, 3);
});

test("does not retry once a session exists (avoids duplicate Notion writes)", async () => {
  // The init message means the agent started and may already have run tools that
  // wrote to Notion. Retrying the whole query would replay those writes.
  script = [{ messages: [initMessage("sess-started")], throws: new Error("socket hang up") }];

  await assert.rejects(
    runAgent({ userMessage: "log 5x5 squats at 80kg", chatId: "chat-midflight" }),
    /socket hang up/,
  );
  assert.equal(calls.length, 1);
});

test("does not retry a non-transient failure", async () => {
  script = [{ throws: new Error("spawn claude ENOENT") }];

  await assert.rejects(runAgent({ userMessage: "hi", chatId: "chat-fatal" }), /ENOENT/);
  assert.equal(calls.length, 1);
});

test("reports a usage limit to the user instead of throwing", async () => {
  script = [{ throws: new Error("Claude AI usage limit reached") }];

  const response = await runAgent({ userMessage: "hi", chatId: "chat-limit" });

  assert.match(response.text, /usage limit/i);
  assert.equal(response.sessionId, undefined);
  assert.equal(calls.length, 1);
});

test("clears the session when the usage limit is hit, so the next turn starts fresh", async () => {
  script = [{ messages: [initMessage("sess-doomed"), resultMessage("ok")] }];
  await runAgent({ userMessage: "hi", chatId: "chat-limit-clear" });

  script = [{ throws: new Error("quota exceeded") }];
  calls.length = 0;
  await runAgent({ userMessage: "hi again", chatId: "chat-limit-clear" });

  script = [{ messages: [initMessage("sess-new"), resultMessage("ok")] }];
  calls.length = 0;
  await runAgent({ userMessage: "third", chatId: "chat-limit-clear" });

  assert.equal(calls[0].options.resume, undefined);
});

// ─── Diagnosing a subprocess that dies before it starts ───────────────────────
//
// Observed in production on 2026-10-07: two photo messages failed with nothing but
// "process exited with code 1", logged 275ms after the start, and both worked on
// the user's own immediate retry. The run record held no stderr and no record that
// the message carried an image, so the cause was unrecoverable after the fact.

/** Every run record the runner appended, newest last. */
function runRecords() {
  if (!fs.existsSync(process.env.RUN_LOG_FILE)) return [];
  return fs
    .readFileSync(process.env.RUN_LOG_FILE, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/**
 * The newest record for a chat. appendRunRecord is deliberately fire-and-forget
 * (the coaching path never awaits instrumentation), so the write lands a tick or
 * two after runAgent resolves: poll rather than assume it is already on disk.
 */
async function waitForRecord(chatId) {
  for (let i = 0; i < 50; i++) {
    const record = runRecords()
      .filter((r) => r.chatId === chatId)
      .pop();
    if (record) return record;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no run record appeared for ${chatId}`);
}

test("retries a bare subprocess exit that happens before the session starts", async () => {
  const exited = new Error("Claude Code process exited with code 1");
  script = [
    { throws: exited },
    { messages: [initMessage("sess-after-exit"), resultMessage("got it")] },
  ];

  const response = await runAgent({ userMessage: "lunch", chatId: "chat-exit" });

  assert.equal(response.text, "got it");
  assert.equal(calls.length, 2);
});

test("does not retry a subprocess exit once a session exists", async () => {
  // Same error, but the agent already started and may have written to Notion.
  script = [
    {
      messages: [initMessage("sess-exit-late")],
      throws: new Error("Claude Code process exited with code 1"),
    },
  ];

  await assert.rejects(
    runAgent({ userMessage: "log it", chatId: "chat-exit-late" }),
    /exited with code 1/,
  );
  assert.equal(calls.length, 1);
});

test("a failed run records the CLI stderr that explains it", async () => {
  script = [
    {
      stderr: "Error: could not decode image payload\n  at parse()\n",
      throws: new Error("Claude Code process exited with code 1"),
    },
  ];

  await assert.rejects(
    runAgent({ userMessage: "hi", chatId: "chat-stderr" }),
    /exited with code 1/,
  );

  const record = await waitForRecord("chat-stderr");
  assert.ok(record, "a run record was written");
  assert.match(record.stderr, /could not decode image payload/);
});

test("a successful run does not carry stderr into the log", async () => {
  script = [
    {
      stderr: "warning: noisy but harmless\n",
      messages: [initMessage("sess-quiet"), resultMessage("ok")],
    },
  ];

  await runAgent({ userMessage: "hi", chatId: "chat-stderr-ok" });

  const record = await waitForRecord("chat-stderr-ok");
  assert.equal(record.stderr, undefined);
});

test("stderr is redacted before it reaches the run log", async () => {
  script = [
    {
      stderr: "auth failed with token sk-ant-abcdefghijklmnop\n",
      throws: new Error("Claude Code process exited with code 1"),
    },
  ];

  await assert.rejects(runAgent({ userMessage: "hi", chatId: "chat-stderr-secret" }), /code 1/);

  const record = await waitForRecord("chat-stderr-secret");
  assert.doesNotMatch(record.stderr, /sk-ant-abcdefghijklmnop/);
  assert.match(record.stderr, /redacted/);
});

test("the run record says what the message carried, without the bytes", async () => {
  // 9 bytes of payload, base64-encoded with one pad char.
  const data = Buffer.from("not an image!").toString("base64");
  script = [{ messages: [initMessage("sess-img"), resultMessage("chicken masala, nice")] }];

  await runAgent({
    userMessage: "Lunch plus 0.5 liter of kofola",
    chatId: "chat-attach",
    attachments: [{ mediaType: "image/jpeg", data }],
  });

  const record = await waitForRecord("chat-attach");
  assert.deepEqual(record.attachments, [{ mediaType: "image/jpeg", bytes: 13 }]);
  // The payload itself must never reach the log.
  assert.doesNotMatch(JSON.stringify(record), /not an image/);
});

test("a text-only run records no attachments at all", async () => {
  script = [{ messages: [initMessage("sess-text"), resultMessage("ok")] }];

  await runAgent({ userMessage: "did 5x5 squats", chatId: "chat-no-attach" });

  const record = await waitForRecord("chat-no-attach");
  assert.equal(record.attachments, undefined);
});
