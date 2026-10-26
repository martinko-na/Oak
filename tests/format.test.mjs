import assert from "node:assert/strict";
import { test } from "node:test";
import { toPlainText, toRichMarkdown, toTelegramHtml } from "../dist/channel/format.js";

// ─── toTelegramHtml ───────────────────────────────────────────────────────────

test("converts **bold** to <b>", () => {
  assert.equal(toTelegramHtml("lift **heavy** today"), "lift <b>heavy</b> today");
});

test("converts _italic_ to <i>", () => {
  assert.equal(toTelegramHtml("be _consistent_"), "be <i>consistent</i>");
});

test("headings become bold lines", () => {
  assert.equal(toTelegramHtml("# Session"), "<b>Session</b>");
});

test("bullets become bullet dots", () => {
  assert.equal(toTelegramHtml("- squats\n- bench"), "• squats\n• bench");
});

test("links become anchor tags", () => {
  assert.equal(
    toTelegramHtml("[docs](https://example.com)"),
    '<a href="https://example.com">docs</a>',
  );
});

test("escapes HTML-significant characters in prose", () => {
  assert.equal(toTelegramHtml("5 < 8 & rising"), "5 &lt; 8 &amp; rising");
});

test("leaves markdown inside code spans literal", () => {
  assert.equal(toTelegramHtml("use `**not bold**`"), "use <code>**not bold**</code>");
});

test("preserves fenced code blocks", () => {
  assert.equal(toTelegramHtml("```\nx = 1\n```"), "<pre>x = 1</pre>");
});

test("collapses em dashes to commas in prose", () => {
  assert.equal(toTelegramHtml("rest — then push"), "rest, then push");
});

test("keeps en-dash numeric ranges intact", () => {
  assert.equal(toTelegramHtml("do 8–12 reps"), "do 8–12 reps");
});

const MEALS = [
  "| Meal | kcal | P |",
  "|---|---|---|",
  "| Breakfast | 520 | 35g |",
  "| **Total** | 1260 | 87g |",
].join("\n");

const MEALS_RENDERED = [
  "Meal       kcal    P",
  "─────────  ────  ───",
  "Breakfast   520  35g",
  "Total      1260  87g",
].join("\n");

test("renders a markdown table as an aligned <pre> block", () => {
  assert.equal(toTelegramHtml(MEALS), `<pre>${MEALS_RENDERED}</pre>`);
});

test("keeps prose around a table formatted", () => {
  assert.equal(
    toTelegramHtml(`**Today**\n${MEALS}\n- eat more protein`),
    `<b>Today</b>\n<pre>${MEALS_RENDERED}</pre>\n• eat more protein`,
  );
});

test("escapes HTML inside table cells", () => {
  assert.equal(
    toTelegramHtml("| a | b |\n|---|---|\n| a<b | x&y |"),
    "<pre>a    b\n───  ───\na&lt;b  x&amp;y</pre>",
  );
});

test("honours explicit column alignment", () => {
  assert.equal(
    toTelegramHtml("| name | note |\n|:---|---:|\n| a | long |\n| bb | x |"),
    "<pre>name  note\n────  ────\na     long\nbb       x</pre>",
  );
});

test("leaves tables inside fenced code alone", () => {
  assert.equal(toTelegramHtml("```\n| a |\n|---|\n```"), "<pre>| a |\n|---|</pre>");
});

test("a horizontal rule under a pipe line is not a table", () => {
  assert.equal(toTelegramHtml("a | b\n---"), "a | b\n---");
});

// ─── toPlainText ──────────────────────────────────────────────────────────────

test("strips bold markers to plain text", () => {
  assert.equal(toPlainText("lift **heavy**"), "lift heavy");
});

test("renders links as text with url in parens", () => {
  assert.equal(toPlainText("[docs](https://example.com)"), "docs (https://example.com)");
});

test("strips em dashes in plain text too", () => {
  assert.equal(toPlainText("rest — then push"), "rest, then push");
});

test("renders tables as aligned columns in plain text", () => {
  assert.equal(toPlainText(MEALS), MEALS_RENDERED);
});

// ─── toRichMarkdown ───────────────────────────────────────────────────────────

test("rich markdown keeps tables and markup as written", () => {
  assert.equal(toRichMarkdown(MEALS), MEALS);
});

test("rich markdown strips em dashes outside code only", () => {
  assert.equal(
    toRichMarkdown("rest — then push\n```\na — b\n```"),
    "rest, then push\n```\na — b\n```",
  );
});
