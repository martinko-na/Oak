import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Module constants (client id, token file) are read at import time, so point
// them at a throwaway token file before loading the helper.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oak-oura-"));
const TOKEN_FILE = path.join(TMP_DIR, "oura-token.json");
process.env.OURA_CLIENT_ID = "client-id";
process.env.OURA_CLIENT_SECRET = "client-secret";
process.env.OURA_TOKEN_FILE = TOKEN_FILE;

const {
  THRESHOLDS,
  accessToken,
  addDays,
  aggregateDay,
  baseline7d,
  computeFlags,
  fetchCollection,
  estimateMaxHr,
  hrStats,
  hrZones,
  parseArgs,
  pickMainSleep,
  recordSyncAttempt,
  summarizeWorkouts,
} = await import("./oura.mjs");

// ─── fixtures ─────────────────────────────────────────────────────────────────

const night = (day, over = {}) => ({
  day,
  type: "long_sleep",
  total_sleep_duration: 7.5 * 3600,
  efficiency: 90,
  average_hrv: 50,
  lowest_heart_rate: 50,
  average_heart_rate: 56,
  ...over,
});

/** Seven baseline nights before `day` at HRV 50, then the given last night. */
function week(day, last = {}) {
  const periods = [];
  for (let i = 7; i >= 1; i--) periods.push(night(addDays(day, -i)));
  periods.push(night(day, last));
  return periods;
}

const codes = (flags) => flags.map((f) => f.code).sort();

// ─── helpers ──────────────────────────────────────────────────────────────────

test("parseArgs: flags with values and boolean flags", () => {
  assert.deepEqual(parseArgs(["--date", "2026-10-07", "--track"]), {
    date: "2026-10-07",
    track: true,
  });
});

test("addDays crosses month and year boundaries", () => {
  assert.equal(addDays("2026-10-01", -1), "2026-09-30");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("pickMainSleep prefers the long sleep over a longer-looking nap, ignores deleted", () => {
  const periods = [
    night("2026-10-07", { type: "late_nap", total_sleep_duration: 9 * 3600 }),
    night("2026-10-07", { type: "long_sleep", total_sleep_duration: 6 * 3600 }),
    night("2026-10-07", { type: "deleted", total_sleep_duration: 10 * 3600 }),
  ];
  assert.equal(pickMainSleep(periods, "2026-10-07").type, "long_sleep");
  assert.equal(pickMainSleep(periods, "2026-10-06"), null);
});

test("pickMainSleep ignores short 'sleep' fragments, naps and rest periods", () => {
  const periods = [
    night("2026-10-05", { type: "sleep", total_sleep_duration: 360 }), // 6 min fragment
    night("2026-10-05", { type: "rest", total_sleep_duration: 5 * 3600 }),
    night("2026-10-05", { type: "late_nap", total_sleep_duration: 4 * 3600 }),
  ];
  assert.equal(pickMainSleep(periods, "2026-10-05"), null);
  const real = night("2026-10-05", { type: "sleep", total_sleep_duration: 4 * 3600 });
  assert.equal(pickMainSleep([...periods, real], "2026-10-05"), real);
});

test("an unrecorded night is not ready and cannot fake a short-sleep flag", () => {
  const out = aggregateDay("2026-10-05", {
    readiness: [],
    dailySleep: [{ day: "2026-10-05", score: null }],
    sleepPeriods: [
      night("2026-10-04", { total_sleep_duration: 5 * 3600 }),
      night("2026-10-05", { type: "sleep", total_sleep_duration: 360 }),
    ],
    activity: [],
  });
  assert.equal(out.ready, false);
  assert.deepEqual(out.flags, []);
});

test("baseline7d averages the 7 nights before the day, excluding the day itself", () => {
  const b = baseline7d(week("2026-10-07", { average_hrv: 10 }), "2026-10-07");
  assert.equal(b.nights, 7);
  assert.equal(b.avgHrv, 50);
  assert.equal(b.sleepHours, 7.5);
});

// ─── red flags ────────────────────────────────────────────────────────────────

const baseline = { avgHrv: 50, hrvNights: 7 };

test("no flags on a normal night", () => {
  const flags = computeFlags({
    readiness: { score: 80, temperature_deviation: 0.1 },
    mainSleep: night("d"),
    prevSleep: night("p"),
    baseline,
  });
  assert.deepEqual(flags, []);
});

test("temperature flag fires at the threshold, not below", () => {
  const at = { score: 80, temperature_deviation: THRESHOLDS.tempDeviationC };
  const below = { score: 80, temperature_deviation: THRESHOLDS.tempDeviationC - 0.01 };
  assert.deepEqual(codes(computeFlags({ readiness: at })), ["temp_elevated"]);
  assert.deepEqual(computeFlags({ readiness: below }), []);
});

test("readiness flag fires below the threshold only", () => {
  assert.deepEqual(codes(computeFlags({ readiness: { score: 59 } })), ["low_readiness"]);
  assert.deepEqual(computeFlags({ readiness: { score: 60 } }), []);
});

test("HRV flag needs a >20% drop and a trusted baseline", () => {
  const low = night("d", { average_hrv: 39 }); // 22% below 50
  const edge = night("d", { average_hrv: 40 }); // exactly 20% below: not flagged
  assert.deepEqual(codes(computeFlags({ mainSleep: low, baseline })), ["low_hrv"]);
  assert.deepEqual(computeFlags({ mainSleep: edge, baseline }), []);
  assert.deepEqual(computeFlags({ mainSleep: low, baseline: { avgHrv: 50, hrvNights: 3 } }), []);
});

test("short-sleep flag needs two consecutive short nights", () => {
  const short = night("d", { total_sleep_duration: 5.5 * 3600 });
  const ok = night("p", { total_sleep_duration: 7 * 3600 });
  assert.deepEqual(codes(computeFlags({ mainSleep: short, prevSleep: short })), ["short_sleep"]);
  assert.deepEqual(computeFlags({ mainSleep: short, prevSleep: ok }), []);
  // The previous night missing is unknown, not short.
  assert.deepEqual(computeFlags({ mainSleep: short, prevSleep: null }), []);
});

test("missing data never produces a flag", () => {
  assert.deepEqual(computeFlags({}), []);
  assert.deepEqual(computeFlags({ readiness: { score: null, temperature_deviation: null } }), []);
});

// ─── aggregation ──────────────────────────────────────────────────────────────

const DAY = "2026-10-07";

test("aggregateDay: ready day with all documents and a flagged night", () => {
  const out = aggregateDay(DAY, {
    readiness: [
      { day: DAY, score: 55, temperature_deviation: 0.12, contributors: { hrv_balance: 40 } },
    ],
    dailySleep: [{ day: DAY, score: 70 }],
    sleepPeriods: week(DAY, { average_hrv: 35, total_sleep_duration: 6.25 * 3600 }),
    activity: [
      { day: DAY, score: 77, steps: 4200, high_activity_time: 600, medium_activity_time: 1800 },
    ],
  });
  assert.equal(out.ready, true);
  assert.deepEqual(out.missing, []);
  assert.equal(out.readiness.score, 55);
  assert.equal(out.readiness.contributorScores.hrvBalance, 40);
  assert.equal(out.sleep.score, 70);
  assert.equal(out.sleep.totalHours, 6.3);
  assert.equal(out.activity.highMinutes, 10);
  assert.equal(out.baseline7d.avgHrv, 50);
  assert.deepEqual(codes(out.flags), ["low_hrv", "low_readiness"]);
});

test("aggregateDay: unsynced night is not ready, lists what is missing, raises no flags", () => {
  const out = aggregateDay(DAY, {
    readiness: [],
    dailySleep: [],
    sleepPeriods: week(addDays(DAY, -1)), // nothing for DAY itself
    activity: [],
  });
  assert.equal(out.ready, false);
  assert.deepEqual(out.missing, ["readiness", "sleep", "activity"]);
  assert.equal(out.readiness, null);
  assert.equal(out.sleep, null);
  assert.deepEqual(out.flags, []);
});

test("aggregateDay: missing activity alone does not block readiness", () => {
  const out = aggregateDay(DAY, {
    readiness: [{ day: DAY, score: 80 }],
    dailySleep: [{ day: DAY, score: 80 }],
    sleepPeriods: week(DAY),
    activity: [],
  });
  assert.equal(out.ready, true);
  assert.deepEqual(out.missing, ["activity"]);
});

// ─── workouts ─────────────────────────────────────────────────────────────────

test("summarizeWorkouts: filters the day, computes duration, km, sorts by start", () => {
  const out = summarizeWorkouts(
    [
      {
        id: "b",
        day: DAY,
        activity: "running",
        start_datetime: "2026-10-07T18:00:00+01:00",
        end_datetime: "2026-10-07T18:42:00+01:00",
        calories: 412.6,
        distance: 7340,
        intensity: "moderate",
        source: "autodetected",
      },
      {
        id: "a",
        day: DAY,
        activity: "strengthTraining",
        start_datetime: "2026-10-07T07:00:00+01:00",
        end_datetime: "2026-10-07T08:00:00+01:00",
        intensity: "hard",
      },
      { id: "z", day: "2026-10-06", activity: "walking" },
    ],
    DAY,
  );
  assert.deepEqual(
    out.map((w) => w.id),
    ["a", "b"],
  );
  assert.equal(out[1].durationMin, 42);
  assert.equal(out[1].distanceKm, 7.34);
  assert.equal(out[1].calories, 413);
  assert.equal(out[0].distanceKm, null);
});

// ─── sync log ─────────────────────────────────────────────────────────────────

test("recordSyncAttempt keeps the first attempt and first-ready time, counts attempts", () => {
  let log = recordSyncAttempt({}, DAY, false, "T08:00");
  log = recordSyncAttempt(log, DAY, false, "T08:10");
  log = recordSyncAttempt(log, DAY, true, "T08:12");
  log = recordSyncAttempt(log, DAY, true, "T09:10");
  assert.deepEqual(log[DAY], { firstAttemptAt: "T08:00", attempts: 4, firstReadyAt: "T08:12" });
});

test("recordSyncAttempt trims to the most recent 90 days", () => {
  let log = {};
  for (let i = 0; i < 95; i++) log = recordSyncAttempt(log, addDays("2026-01-01", i), true, "t");
  const keys = Object.keys(log);
  assert.equal(keys.length, 90);
  assert.equal(keys[0], addDays("2026-01-01", 5));
});

// ─── auth: rotating refresh token ─────────────────────────────────────────────

function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ url: String(url), body });
    const { status = 200, json = {} } = handler(String(url), body, calls.length);
    return new Response(JSON.stringify(json), { status });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const writeToken = (data) => fs.writeFileSync(TOKEN_FILE, JSON.stringify(data));
const readToken = () => JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));

test("accessToken reuses a cached, unexpired access token without refreshing", async () => {
  writeToken({ refresh_token: "r1", access_token: "a1", expires_at: Date.now() + 3600_000 });
  const f = mockFetch(() => ({ status: 500 }));
  try {
    assert.equal(await accessToken(), "a1");
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test("accessToken refreshes an expired token and persists the rotated refresh token", async () => {
  writeToken({ refresh_token: "r1", access_token: "old", expires_at: Date.now() - 1 });
  const f = mockFetch(() => ({
    json: { access_token: "a2", refresh_token: "r2", expires_in: 86400 },
  }));
  try {
    assert.equal(await accessToken(), "a2");
    assert.equal(f.calls[0].body.refresh_token, "r1");
    assert.equal(f.calls[0].body.grant_type, "refresh_token");
    const saved = readToken();
    assert.equal(saved.refresh_token, "r2");
    assert.equal(saved.access_token, "a2");
    assert.ok(saved.expires_at > Date.now());
  } finally {
    f.restore();
  }
});

test("accessToken retries with a token rotated by another process after a rejection", async () => {
  writeToken({ refresh_token: "r1", access_token: "old", expires_at: Date.now() - 1 });
  const f = mockFetch((_url, body, n) => {
    if (n === 1) {
      // Simulate another process rotating r1 -> r9 while this refresh was in flight.
      writeToken({ refresh_token: "r9", access_token: "x", expires_at: Date.now() - 1 });
      return { status: 400, json: { error: "invalid_grant" } };
    }
    assert.equal(body.refresh_token, "r9");
    return { json: { access_token: "a10", refresh_token: "r10", expires_in: 86400 } };
  });
  try {
    assert.equal(await accessToken(), "a10");
    assert.equal(readToken().refresh_token, "r10");
  } finally {
    f.restore();
  }
});

test("accessToken surfaces a clear error when the grant is revoked", async () => {
  writeToken({ refresh_token: "r1", access_token: "old", expires_at: Date.now() - 1 });
  const f = mockFetch(() => ({ status: 400, json: { error: "invalid_grant" } }));
  try {
    await assert.rejects(accessToken(), /refresh failed \(400\).*oura-auth\.mjs/);
    // The file is untouched, so a later re-auth starts from a clean state.
    assert.equal(readToken().refresh_token, "r1");
  } finally {
    f.restore();
  }
});

test("a 401 from the API forces one token refresh and retries the request", async () => {
  writeToken({ refresh_token: "r1", access_token: "revoked", expires_at: Date.now() + 3600_000 });
  let apiCalls = 0;
  const f = mockFetch((url) => {
    if (url.includes("/oauth/token")) {
      return { json: { access_token: "fresh", refresh_token: "r2", expires_in: 86400 } };
    }
    apiCalls++;
    return apiCalls === 1 ? { status: 401 } : { json: { data: [{ day: DAY }], next_token: null } };
  });
  try {
    const docs = await fetchCollection("daily_readiness", DAY, DAY);
    assert.deepEqual(docs, [{ day: DAY }]);
    assert.equal(apiCalls, 2);
    assert.equal(readToken().refresh_token, "r2");
  } finally {
    f.restore();
  }
});

test("fetchCollection follows next_token pagination", async () => {
  writeToken({ refresh_token: "r1", access_token: "a", expires_at: Date.now() + 3600_000 });
  const f = mockFetch((url) =>
    url.includes("next_token=p2")
      ? { json: { data: [{ day: "b" }], next_token: null } }
      : { json: { data: [{ day: "a" }], next_token: "p2" } },
  );
  try {
    const docs = await fetchCollection("daily_sleep", DAY, DAY);
    assert.deepEqual(
      docs.map((d) => d.day),
      ["a", "b"],
    );
  } finally {
    f.restore();
  }
});

// ─── heart rate ───────────────────────────────────────────────────────────────

test("hrStats averages and peaks only the samples inside the workout window", () => {
  const samples = [
    { timestamp: "2026-10-07T05:59:00+00:00", bpm: 190 }, // before: ignored
    { timestamp: "2026-10-07T06:00:00+00:00", bpm: 120 },
    { timestamp: "2026-10-07T06:20:00+00:00", bpm: 160 },
    { timestamp: "2026-10-07T06:40:00+00:00", bpm: 141 },
    { timestamp: "2026-10-07T06:41:00+00:00", bpm: 200 }, // after: ignored
  ];
  // Window given in local time (+01:00) like Oura workout timestamps.
  assert.deepEqual(hrStats(samples, "2026-10-07T07:00:00+01:00", "2026-10-07T07:40:00+01:00"), {
    avgHr: 140,
    maxHr: 160,
  });
});

test("hrStats returns nulls when there are no samples in the window", () => {
  assert.deepEqual(hrStats([], "2026-10-07T07:00:00Z", "2026-10-07T08:00:00Z"), {
    avgHr: null,
    maxHr: null,
  });
});

test("estimateMaxHr uses Tanaka (208 - 0.7 x age)", () => {
  assert.equal(estimateMaxHr(40), 180);
  assert.equal(estimateMaxHr(null), null);
});

test("hrZones credits each sample until the next one, by % of max HR", () => {
  const t = (min) => new Date(Date.parse("2026-10-07T06:00:00Z") + min * 60000).toISOString();
  // Max 200: 110 = 55% (z1), 130 = 65% (z2), 170 = 85% (z4), 185 = 92.5% (z5).
  const dense = [];
  for (let m = 0; m < 10; m++) dense.push({ timestamp: t(m), bpm: 110 });
  for (let m = 10; m < 30; m++) dense.push({ timestamp: t(m), bpm: 130 });
  for (let m = 30; m < 35; m++) dense.push({ timestamp: t(m), bpm: 170 });
  dense.push({ timestamp: t(35), bpm: 185 }); // last sample gets the typical 1 min gap
  assert.deepEqual(hrZones(dense, t(0), t(40), 200), { z1: 10, z2: 20, z3: 0, z4: 5, z5: 1 });
});

test("hrZones caps each sample at a minute so data gaps are not credited", () => {
  const t = (min) => new Date(Date.parse("2026-10-07T06:00:00Z") + min * 60000).toISOString();
  const sparse = [
    { timestamp: t(0), bpm: 110 },
    { timestamp: t(10), bpm: 130 },
    { timestamp: t(30), bpm: 170 },
    { timestamp: t(35), bpm: 185 },
  ];
  assert.deepEqual(hrZones(sparse, t(0), t(40), 200), { z1: 1, z2: 1, z3: 0, z4: 1, z5: 1 });
});

test("hrZones is null without a max HR or samples (never zeros)", () => {
  const s = [{ timestamp: "2026-10-07T06:00:00Z", bpm: 150 }];
  assert.equal(hrZones(s, "2026-10-07T05:00:00Z", "2026-10-07T07:00:00Z", null), null);
  assert.equal(hrZones([], "2026-10-07T05:00:00Z", "2026-10-07T07:00:00Z", 190), null);
});
