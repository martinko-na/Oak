import assert from "node:assert/strict";
import { test } from "node:test";
import { deliver } from "../dist/channel/notify.js";

// deliver is the single outbound path for replies and proactive messages. A fake
// api records every call; `fail` lists the methods that should reject, so each
// rung of the rich -> HTML -> plain-text fallback can be exercised.

function fakeApi(fail = []) {
  const calls = [];
  const record = (method, args) => {
    calls.push({ method, args });
    if (fail.includes(method)) throw new Error(`${method} rejected`);
  };
  return {
    calls,
    async sendRichMessage(chatId, richMessage) {
      record("sendRichMessage", { chatId, richMessage });
    },
    async sendMessage(chatId, text, other) {
      const method = other?.parse_mode ? "sendMessage:HTML" : "sendMessage:plain";
      record(method, { chatId, text, other });
    },
  };
}

const quiet = async (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
};

test("sends markdown as a rich message, tables untouched", async () => {
  const api = fakeApi();
  const table = "| Meal | kcal |\n|---|---|\n| Lunch | 740 |";
  await deliver(api, 42, `**Today**\n${table}`);
  assert.deepEqual(api.calls, [
    {
      method: "sendRichMessage",
      args: { chatId: 42, richMessage: { markdown: `**Today**\n${table}` } },
    },
  ]);
});

test("strips em dashes from rich prose but not code", async () => {
  const api = fakeApi();
  await deliver(api, 1, "rest — then push `a—b`");
  assert.equal(api.calls[0].args.richMessage.markdown, "rest, then push `a—b`");
});

test("redacts secrets before sending", async () => {
  const api = fakeApi();
  await deliver(api, 1, "key sk-ant-abc123DEF456ghi789 leaked");
  const sent = api.calls[0].args.richMessage.markdown;
  assert.ok(!sent.includes("sk-ant-abc123DEF456ghi789"));
});

test("falls back to HTML with <pre> tables when rich is rejected", async () => {
  const api = fakeApi(["sendRichMessage"]);
  await quiet(() => deliver(api, 1, "| a | b |\n|---|---|\n| x | 1 |"));
  assert.deepEqual(
    api.calls.map((c) => c.method),
    ["sendRichMessage", "sendMessage:HTML"],
  );
  assert.equal(api.calls[1].args.text, "<pre>a  b\n─  ─\nx  1</pre>");
  assert.deepEqual(api.calls[1].args.other, { parse_mode: "HTML" });
});

test("falls back to plain text when HTML is rejected too", async () => {
  const api = fakeApi(["sendRichMessage", "sendMessage:HTML"]);
  await quiet(() => deliver(api, 1, "lift **heavy**"));
  assert.deepEqual(
    api.calls.map((c) => c.method),
    ["sendRichMessage", "sendMessage:HTML", "sendMessage:plain"],
  );
  assert.equal(api.calls[2].args.text, "lift heavy");
});

test("re-chunks to the 4096 limit on the HTML fallback", async () => {
  const api = fakeApi(["sendRichMessage"]);
  const long = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
  await quiet(() => deliver(api, 1, long));
  assert.equal(api.calls.filter((c) => c.method === "sendRichMessage").length, 1);
  assert.equal(api.calls.filter((c) => c.method === "sendMessage:HTML").length, 2);
});
