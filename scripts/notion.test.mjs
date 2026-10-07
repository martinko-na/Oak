import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPropertyValue,
  formatZones,
  markdownToBlocks,
  optionNames,
  ouraWorkoutProperties,
  parseInline,
  planWorkoutSync,
  recoveryProperties,
  renderBodyStatsTile,
  renderGoalsTile,
  renderRecoveryTile,
  renderThisWeekTile,
  startOfWeekUTC,
  validateValue,
} from "./notion.mjs";

// ─── inline rich text ─────────────────────────────────────────────────────────

test("parseInline: plain text is a single node with no annotations", () => {
  const rt = parseInline("just words");
  assert.equal(rt.length, 1);
  assert.equal(rt[0].text.content, "just words");
  assert.equal(rt[0].annotations, undefined);
});

test("parseInline: empty string yields no nodes", () => {
  assert.deepEqual(parseInline(""), []);
});

test("parseInline: **bold** becomes a bold annotation without asterisks", () => {
  const rt = parseInline("lift **heavy** today");
  assert.deepEqual(
    rt.map((n) => n.text.content),
    ["lift ", "heavy", " today"],
  );
  assert.equal(rt[1].annotations.bold, true);
  // No literal asterisks leak into any node.
  assert.ok(rt.every((n) => !n.text.content.includes("*")));
});

test("parseInline: _italic_ becomes an italic annotation", () => {
  const rt = parseInline("be _consistent_");
  assert.equal(rt[1].text.content, "consistent");
  assert.equal(rt[1].annotations.italic, true);
});

test("parseInline: `code` becomes a code annotation", () => {
  const rt = parseInline("run `notion.mjs log`");
  assert.equal(rt[1].text.content, "notion.mjs log");
  assert.equal(rt[1].annotations.code, true);
});

test("parseInline: [label](url) becomes a link", () => {
  const rt = parseInline("see [the log](https://example.com/x)");
  assert.equal(rt[1].text.content, "the log");
  assert.equal(rt[1].text.link.url, "https://example.com/x");
});

test("parseInline: multiple spans on one line keep their order", () => {
  const rt = parseInline("**a** and _b_ and `c`");
  assert.deepEqual(
    rt.map((n) => n.text.content),
    ["a", " and ", "b", " and ", "c"],
  );
  assert.equal(rt[0].annotations.bold, true);
  assert.equal(rt[2].annotations.italic, true);
  assert.equal(rt[4].annotations.code, true);
});

// ─── block conversion ──────────────────────────────────────────────────────────

test("markdownToBlocks: headings map to heading_1..3", () => {
  const blocks = markdownToBlocks("# H1\n## H2\n### H3");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading_1", "heading_2", "heading_3"],
  );
  assert.equal(blocks[0].heading_1.rich_text[0].text.content, "H1");
});

test("markdownToBlocks: bullets carry inline formatting", () => {
  const blocks = markdownToBlocks("- do **squats**");
  assert.equal(blocks[0].type, "bulleted_list_item");
  const rt = blocks[0].bulleted_list_item.rich_text;
  assert.equal(rt[1].text.content, "squats");
  assert.equal(rt[1].annotations.bold, true);
});

test("markdownToBlocks: numbered lists are detected", () => {
  const blocks = markdownToBlocks("1. first\n2. second");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["numbered_list_item", "numbered_list_item"],
  );
});

test("markdownToBlocks: divider", () => {
  const blocks = markdownToBlocks("---");
  assert.equal(blocks[0].type, "divider");
});

test("markdownToBlocks: callout keeps its emoji icon", () => {
  const blocks = markdownToBlocks("> [🎯] Goals");
  assert.equal(blocks[0].type, "callout");
  assert.equal(blocks[0].callout.icon.emoji, "🎯");
  assert.equal(blocks[0].callout.rich_text[0].text.content, "Goals");
});

test("markdownToBlocks: callout parses an explicit background color", () => {
  const blocks = markdownToBlocks("> [📅|gray_background] **This Week**");
  assert.equal(blocks[0].callout.icon.emoji, "📅");
  assert.equal(blocks[0].callout.color, "gray_background");
});

test("markdownToBlocks: callout with an unknown color falls back to default", () => {
  const blocks = markdownToBlocks("> [📅|chartreuse] Hi");
  assert.equal(blocks[0].callout.color, "default");
});

test("tile renderers carry their canonical, distinct colors", () => {
  const color = (md) => markdownToBlocks(md)[0].callout.color;
  assert.equal(color(renderThisWeekTile([])), "gray_background");
  assert.equal(color(renderGoalsTile([])), "brown_background");
  assert.equal(color(renderBodyStatsTile(null)), "red_background");
});

test("markdownToBlocks: table parses cells and skips the separator row", () => {
  const blocks = markdownToBlocks("| Day | Focus |\n| --- | --- |\n| Mon | Push |");
  assert.equal(blocks[0].type, "table");
  assert.equal(blocks[0].table.table_width, 2);
  // Header row + one data row (separator dropped).
  assert.equal(blocks[0].table.children.length, 2);
});

test("markdownToBlocks: column layout produces a column_list with two columns", () => {
  const md = "::: columns\n- left\n|||\n- right\n:::";
  const blocks = markdownToBlocks(md);
  assert.equal(blocks[0].type, "column_list");
  assert.equal(blocks[0].column_list.children.length, 2);
});

// ─── property coercion ──────────────────────────────────────────────────────────

test("buildPropertyValue: coerces by schema type", () => {
  assert.equal(buildPropertyValue("number", "60").number, 60);
  assert.equal(buildPropertyValue("select", "Active").select.name, "Active");
  assert.deepEqual(
    buildPropertyValue("multi_select", "Chest, Triceps").multi_select.map((s) => s.name),
    ["Chest", "Triceps"],
  );
  assert.equal(buildPropertyValue("date", "2026-06-23").date.start, "2026-06-23");
  assert.equal(buildPropertyValue("checkbox", "yes").checkbox, true);
});

// ─── value validation ───────────────────────────────────────────────────────────

const selectDef = { type: "select", select: { options: [{ name: "Active" }, { name: "Paused" }] } };
const multiDef = {
  type: "multi_select",
  multi_select: { options: [{ name: "Chest" }, { name: "Back" }, { name: "Legs" }] },
};

test("optionNames: reads allowed options for select/multi_select, null otherwise", () => {
  assert.deepEqual(optionNames(selectDef), ["Active", "Paused"]);
  assert.deepEqual(optionNames(multiDef), ["Chest", "Back", "Legs"]);
  assert.equal(optionNames({ type: "number" }), null);
});

test("validateValue: rejects an unknown select option and lists valid ones", () => {
  assert.throws(() => validateValue("Status", selectDef, "Sprinting"), /Allowed: Active, Paused/);
});

test("validateValue: accepts a valid select option", () => {
  assert.doesNotThrow(() => validateValue("Status", selectDef, "Active"));
});

test("validateValue: rejects an unknown member of a multi_select", () => {
  assert.throws(
    () => validateValue("Focus", multiDef, "Chest, Push"),
    /"Push" is not a valid option/,
  );
});

test("validateValue: rejects out-of-range RPE", () => {
  assert.throws(() => validateValue("RPE (1-10)", { type: "number" }, "12"), /between 1 and 10/);
  assert.doesNotThrow(() => validateValue("RPE (1-10)", { type: "number" }, "8"));
});

test("validateValue: rejects a non-numeric number value", () => {
  assert.throws(() => validateValue("Volume", { type: "number" }, "lots"), /expects a number/);
});

// ─── dashboard rendering (pure, no live Notion) ──────────────────────────────────

test("startOfWeekUTC: returns the Monday of the week (UTC)", () => {
  // 2026-06-30 is a Tuesday → Monday is 2026-06-29.
  assert.equal(
    startOfWeekUTC(new Date("2026-06-30T12:00:00Z")).toISOString().slice(0, 10),
    "2026-06-29",
  );
  // A Sunday maps back to the previous Monday.
  assert.equal(
    startOfWeekUTC(new Date("2026-07-05T00:00:00Z")).toISOString().slice(0, 10),
    "2026-06-29",
  );
});

test("renderThisWeekTile: counts sessions and shows the last one", () => {
  const md = renderThisWeekTile([
    { date: "2026-06-30", name: "Push A", focus: "Chest" },
    { date: "2026-06-29", name: "Legs", focus: "Legs" },
  ]);
  assert.match(md, /\*\*This Week\*\*/);
  assert.match(md, /2 sessions logged this week/);
  assert.match(md, /Last: 2026-06-30 Push A \(Chest\)/);
});

test("renderThisWeekTile: empty state", () => {
  assert.match(renderThisWeekTile([]), /No sessions logged yet this week/);
});

test("renderGoalsTile: shows active goals with progress, hides achieved", () => {
  const md = renderGoalsTile([
    { goal: "Squat 100kg", status: "On track", current: 90, target: 100 },
    { goal: "Old goal", status: "Achieved", current: 1, target: 1 },
  ]);
  assert.match(md, /- Squat 100kg: 90 \/ 100/);
  assert.doesNotMatch(md, /Old goal/);
});

test("renderBodyStatsTile: shows latest weight and waist, or empty state", () => {
  assert.match(
    renderBodyStatsTile({ date: "2026-06-20", bodyweight: 80, waist: 82 }),
    /2026-06-20: 80kg, waist 82cm/,
  );
  assert.match(renderBodyStatsTile(null), /No check-ins logged yet/);
});

// ─── Oura: Recovery rows ──────────────────────────────────────────────────────

const ouraDay = {
  date: "2026-10-06",
  ready: true,
  readiness: { score: 58, tempDeviation: 0.6 },
  sleep: { score: 71, totalHours: 5.8, avgHrv: 38, lowestHr: 54 },
  activity: { score: 80, steps: 9500 },
  flags: [
    { code: "temp_elevated", label: "Temp elevated" },
    { code: "low_readiness", label: "Low readiness" },
  ],
};

test("recoveryProperties maps oura.mjs day JSON onto the Recovery schema", () => {
  const p = recoveryProperties(ouraDay, "Rough night, easy day.");
  assert.equal(p.Day.title[0].text.content, "Tue 2026-10-06");
  assert.equal(p.Date.date.start, "2026-10-06");
  assert.equal(p.Readiness.number, 58);
  assert.equal(p["Total Sleep (h)"].number, 5.8);
  assert.equal(p["Avg HRV (ms)"].number, 38);
  assert.equal(p["Temp Dev (°C)"].number, 0.6);
  assert.equal(p.Steps.number, 9500);
  assert.deepEqual(
    p.Flags.multi_select.map((f) => f.name),
    ["Temp elevated", "Low readiness"],
  );
  assert.equal(p["Coach Takeaway"].rich_text[0].text.content, "Rough night, easy day.");
});

test("recoveryProperties keeps missing values as null and leaves the takeaway alone when absent", () => {
  const p = recoveryProperties({
    date: "2026-10-06",
    readiness: null,
    sleep: null,
    activity: null,
  });
  assert.equal(p.Readiness.number, null);
  assert.equal(p.Steps.number, null);
  assert.deepEqual(p.Flags.multi_select, []);
  assert.equal("Coach Takeaway" in p, false);
});

test("recoveryProperties rejects input that is not oura.mjs day JSON", () => {
  assert.throws(() => recoveryProperties({ workouts: [] }), /oura\.mjs day/);
});

test("renderRecoveryTile shows the latest day and its flags", () => {
  const md = renderRecoveryTile({
    date: "2026-10-06",
    readiness: 58,
    sleepHours: 5.8,
    hrv: 38,
    flags: "Low readiness",
  });
  assert.match(md, /Recovery/);
  assert.match(md, /2026-10-06: readiness 58, 5.8h sleep, HRV 38ms/);
  assert.match(md, /Flags: Low readiness/);
  assert.match(renderRecoveryTile(null), /No Oura days recorded yet/);
});

// ─── Oura: workout sync plan ──────────────────────────────────────────────────

const w = (over = {}) => ({
  id: "w1",
  day: "2026-10-06",
  activity: "running",
  durationMin: 40,
  intensity: "moderate",
  ...over,
});
const row = (over = {}) => ({
  id: "row1",
  date: "2026-10-06",
  source: "Manual",
  ouraId: "",
  focus: "Legs",
  ...over,
});
const actions = (plan) => plan.map((s) => `${s.action}${s.rowId ? `:${s.rowId}` : ""}`);

test("planWorkoutSync: a workout already carrying its Oura id is skipped", () => {
  const plan = planWorkoutSync([w()], [row({ ouraId: "w1", focus: "Cardio" })]);
  assert.deepEqual(actions(plan), ["skip"]);
});

test("planWorkoutSync: strength enriches the single logged session that day", () => {
  const plan = planWorkoutSync([w({ activity: "strengthTraining" })], [row()]);
  assert.deepEqual(actions(plan), ["enrich:row1"]);
});

test("planWorkoutSync: strength is never created; ambiguous or absent sessions are unmatched", () => {
  const strength = w({ activity: "strengthTraining" });
  assert.deepEqual(actions(planWorkoutSync([strength], [])), ["unmatched"]);
  assert.deepEqual(actions(planWorkoutSync([strength], [row(), row({ id: "row2" })])), [
    "unmatched",
  ]);
});

test("planWorkoutSync: cardio enriches a logged Cardio row, else creates one", () => {
  assert.deepEqual(actions(planWorkoutSync([w()], [row({ focus: "Cardio" })])), ["enrich:row1"]);
  // A logged Legs session is not a match for a run.
  assert.deepEqual(actions(planWorkoutSync([w()], [row()])), ["create"]);
});

test("planWorkoutSync: commute-length walks and short cardio are skipped as minor", () => {
  const plan = planWorkoutSync(
    [
      // The real case from live data: a 17 min "moderate" confirmed walk.
      w({ id: "a", activity: "walking", intensity: "moderate", durationMin: 17 }),
      w({ id: "b", durationMin: 10 }),
      w({ id: "c", activity: "walking", intensity: "moderate", durationMin: 45 }),
    ],
    [],
  );
  assert.deepEqual(actions(plan), ["skip", "skip", "create"]);
  assert.equal(plan[0].reason, "minor activity");
});

test("planWorkoutSync: one row is never enriched by two workouts", () => {
  const plan = planWorkoutSync(
    [w({ id: "a", activity: "strengthTraining" }), w({ id: "b", activity: "strengthTraining" })],
    [row()],
  );
  assert.deepEqual(actions(plan), ["enrich:row1", "unmatched"]);
});

test("ouraWorkoutProperties: enrich touches only Oura fields; create builds a full Cardio row", () => {
  const enrich = ouraWorkoutProperties(
    w({ calories: 400, distanceKm: 7.3, avgHr: 148, maxHr: 171 }),
  );
  assert.deepEqual(Object.keys(enrich).sort(), [
    "Avg HR (bpm)",
    "Calories",
    "Distance (km)",
    "HR Zones",
    "Max HR (bpm)",
    "Oura ID",
    "Z2 (min)",
    "Z4-5 (min)",
  ]);
  assert.equal(enrich["Avg HR (bpm)"].number, 148);
  assert.equal(enrich["Max HR (bpm)"].number, 171);
  const create = ouraWorkoutProperties(w({ activity: "indoorCycling" }), { create: true });
  assert.equal(create.Session.title[0].text.content, "Indoor Cycling (Oura)");
  assert.equal(create.Day.select.name, "Tuesday");
  assert.equal(create.Source.select.name, "Oura");
  assert.equal(create.Focus.multi_select[0].name, "Cardio");
  assert.equal(create["Duration (min)"].number, 40);
});

test("zone minutes become a readable summary plus Z2 and Z4-5 numbers", () => {
  const zonesMin = { z1: 5, z2: 22, z3: 10, z4: 3, z5: 1 };
  assert.equal(formatZones(zonesMin), "Z1 5 · Z2 22 · Z3 10 · Z4 3 · Z5 1");
  const p = ouraWorkoutProperties(w({ zonesMin }));
  assert.equal(p["HR Zones"].rich_text[0].text.content, "Z1 5 · Z2 22 · Z3 10 · Z4 3 · Z5 1");
  assert.equal(p["Z2 (min)"].number, 22);
  assert.equal(p["Z4-5 (min)"].number, 4);
  // Unknown zones stay empty rather than reading as zero minutes.
  const none = ouraWorkoutProperties(w());
  assert.deepEqual(none["HR Zones"].rich_text, []);
  assert.equal(none["Z2 (min)"].number, null);
  assert.equal(none["Z4-5 (min)"].number, null);
});
