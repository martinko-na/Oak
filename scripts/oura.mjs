#!/usr/bin/env node
/**
 * oura.mjs: the coach's Oura REST helper.
 *
 * Same pattern as scripts/calendar.mjs: plain fetch against the Oura v2 API,
 * no SDK, no MCP server. It turns Oura's daily documents into one compact
 * aggregate per day, computes the red-flag rules in code (so the model never
 * has to judge a threshold), and prints JSON only. Raw payloads (sleep stage
 * strings, heart-rate samples) are never printed or stored: Oura stays the
 * system of record and history is re-fetched on demand.
 *
 * Auth: OAuth2, minted once by scripts/oura-auth.mjs.
 *   - OURA_CLIENT_ID / OURA_CLIENT_SECRET (env, from .env)
 *   - tokens in data/oura-token.json (override with OURA_TOKEN_FILE). Oura
 *     rotates the refresh token on every refresh, so each refresh writes the
 *     new one back atomically. OURA_REFRESH_TOKEN is only a bootstrap seed for
 *     an empty token file.
 * Access tokens are refreshed when within a minute of expiry, with one forced
 * refresh retry on a 401. Set OURA_SANDBOX=true to read Oura's sandbox
 * (synthetic data) instead of the real account.
 *
 * Usage:
 *   node scripts/oura.mjs status
 *   node scripts/oura.mjs day --date 2026-10-07 [--track]
 *   node scripts/oura.mjs workouts --date 2026-10-06 [--max-hr 188]
 *   node scripts/oura.mjs trend --end 2026-10-07 [--days 14]
 *
 * Day semantics follow Oura: the sleep and readiness for date D are for the
 * night that ended on the morning of D; the activity for D is the whole of
 * calendar day D (still in progress if D is today). Pass the date from the
 * Telegram header; the script never guesses "today".
 *
 * --track records the attempt in data/oura-sync-log.json (first attempt, number
 * of attempts, first time the data was ready) so the real phone-to-cloud sync
 * delay can be measured and the morning check moved if needed.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CLIENT_ID = process.env.OURA_CLIENT_ID;
const CLIENT_SECRET = process.env.OURA_CLIENT_SECRET;
const SANDBOX = /^(1|true|yes)$/i.test(process.env.OURA_SANDBOX ?? "");
const API = `https://api.ouraring.com/v2/${SANDBOX ? "sandbox/" : ""}usercollection`;
const TOKEN_URL = "https://api.ouraring.com/oauth/token";
const TOKEN_FILE = path.resolve(
  process.cwd(),
  process.env.OURA_TOKEN_FILE ?? path.join("data", "oura-token.json"),
);
const SYNC_LOG_FILE = path.resolve(process.cwd(), "data", "oura-sync-log.json");

const MAX_RETRIES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Red-flag thresholds, in one place so they are easy to tune. Each flag only
 * fires on data that is actually present: a missing document is "not synced
 * yet", never "bad recovery".
 */
const THRESHOLDS = {
  // Readiness temperature deviation (°C) at or above which training drops to
  // rest/mobility. Not a diagnosis; the coach says so.
  tempDeviationC: 0.5,
  // Readiness score below which the session is deloaded or swapped.
  readinessLow: 60,
  // Last night's average HRV more than this fraction below the 7-night mean.
  hrvDropFraction: 0.2,
  // Nights needed before the HRV baseline is trusted.
  hrvBaselineMinNights: 4,
  // Total sleep (hours) under which a night counts as short. Two short nights
  // in a row (last night and the one before) cap intensity.
  shortSleepHours: 6,
};

const FLAG_LABELS = {
  temp_elevated: "Temp elevated",
  low_readiness: "Low readiness",
  low_hrv: "Low HRV",
  short_sleep: "Short sleep x2",
};

// Sleep fields we actually use. Requesting only these keeps the large sample
// arrays (hrv, heart_rate, sleep_phase strings) off the wire entirely.
const SLEEP_FIELDS = [
  "day",
  "type",
  "total_sleep_duration",
  "efficiency",
  "average_hrv",
  "lowest_heart_rate",
  "average_heart_rate",
].join(",");

// ─── arg parsing (same shape as calendar.mjs) ────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    args[key] = next === undefined || next.startsWith("--") ? true : (i++, next);
  }
  return args;
}

// ─── dates ───────────────────────────────────────────────────────────────────
function requireDate(value, flag = "--date") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${flag} is required as YYYY-MM-DD (use the date from the Telegram header).`);
  }
  return value;
}

/** Shift a YYYY-MM-DD date by n days (UTC arithmetic, so no DST surprises). */
function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─── auth: rotating refresh token ────────────────────────────────────────────
function readTokenFile() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeTokenFile(data) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  const tmp = `${TOKEN_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
}

// The file wins over the env seed: after the first refresh the env value is
// already spent (rotated), while the file always holds the newest token.
function refreshToken() {
  return readTokenFile().refresh_token || process.env.OURA_REFRESH_TOKEN || "";
}

function ouraConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && refreshToken());
}

async function postRefresh(rt) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: rt,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

/**
 * Return a valid access token, refreshing when the cached one is missing or
 * within a minute of expiry. force=true discards the cache (used once after a
 * 401). If the refresh is rejected, re-read the file once: another process
 * (say, the lunch job overlapping a chat reply) may have just rotated the
 * token, in which case the newer one is used instead of failing.
 */
async function accessToken(force = false) {
  const cached = readTokenFile();
  const skewMs = 60 * 1000;
  if (!force && cached.access_token && (cached.expires_at ?? 0) - skewMs > Date.now()) {
    return cached.access_token;
  }
  let rt = refreshToken();
  if (!rt) throw new Error("No Oura refresh token. Run `node scripts/oura-auth.mjs` first.");
  let { res, json } = await postRefresh(rt);
  if (!res.ok) {
    const latest = refreshToken();
    if (latest && latest !== rt) {
      rt = latest;
      ({ res, json } = await postRefresh(rt));
    }
  }
  if (!res.ok) {
    throw new Error(
      `Oura token refresh failed (${res.status}): ${json.error_description ?? json.error ?? ""}. If access was revoked, re-run \`node scripts/oura-auth.mjs\`.`,
    );
  }
  writeTokenFile({
    ...readTokenFile(),
    refresh_token: json.refresh_token ?? rt,
    access_token: json.access_token,
    expires_at: Date.now() + (json.expires_in ?? 86400) * 1000,
  });
  return json.access_token;
}

// ─── HTTP with retry (429/5xx backoff, one forced re-auth on 401) ───────────
async function oura(pathname) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("OURA_CLIENT_ID / OURA_CLIENT_SECRET are not set.");
  }
  let reauthed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(reauthed && attempt > 0);
    const res = await fetch(`${API}${pathname}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && !reauthed) {
      reauthed = true;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt, 8) * 1000;
      await sleep(waitMs);
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (res.status === 403) {
      throw new Error(
        "Oura returned 403: the token lacks a scope, or the account has no active Oura membership (required for API data).",
      );
    }
    if (!res.ok) {
      const msg = json.detail ?? json.message ?? "";
      throw new Error(`Oura GET ${pathname.split("?")[0]} -> ${res.status}: ${msg}`);
    }
    return json;
  }
}

/** Every document for a query, following next_token. */
async function fetchPaged(collection, query) {
  const out = [];
  let nextToken;
  do {
    const params = new URLSearchParams(query);
    if (nextToken) params.set("next_token", nextToken);
    const json = await oura(`/${collection}?${params}`);
    out.push(...(json.data ?? []));
    nextToken = json.next_token ?? undefined;
  } while (nextToken);
  return out;
}

/** All documents of a collection in [start, end] (dates). */
function fetchCollection(collection, start, end, fields) {
  return fetchPaged(collection, {
    start_date: start,
    end_date: end,
    ...(fields ? { fields } : {}),
  });
}

/** Heart-rate samples (bpm, timestamp, source) between two ISO datetimes. */
function fetchHeartRate(startIso, endIso) {
  return fetchPaged("heartrate", { start_datetime: startIso, end_datetime: endIso });
}

/**
 * Everything needed to aggregate the days from `start` to `end`, plus the 8
 * days before `start` for the HRV baseline and the previous-night sleep rule.
 * Sleep periods are fetched one day past `end` because Oura's sleep end_date
 * filter can exclude the final day; aggregation filters by `day` anyway.
 */
async function fetchRange(start, end) {
  const from = addDays(start, -8);
  const [readiness, dailySleep, sleepPeriods, activity] = await Promise.all([
    fetchCollection("daily_readiness", from, end),
    fetchCollection("daily_sleep", from, end),
    fetchCollection("sleep", from, addDays(end, 1), SLEEP_FIELDS),
    fetchCollection("daily_activity", from, addDays(end, 1)),
  ]);
  return { readiness, dailySleep, sleepPeriods, activity };
}

// ─── pure aggregation (exported for tests) ───────────────────────────────────
const round = (n, dp = 0) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// A "sleep"-type period (not long_sleep) only stands in for the night when it
// is at least this long. Live data showed 6-minute fragments on nights the ring
// barely recorded; treating one as "the night" would fake a short-sleep flag.
const MIN_MAIN_SLEEP_HOURS = 3;

/**
 * The main sleep period for a day: the long_sleep if Oura marked one, else the
 * longest "sleep" period of at least MIN_MAIN_SLEEP_HOURS. Naps, rest periods,
 * deleted periods and fragments never count as "the night".
 */
function pickMainSleep(periods, day) {
  const ofDay = (periods ?? []).filter((p) => p.day === day);
  const long = ofDay.filter((p) => p.type === "long_sleep");
  const pool = long.length
    ? long
    : ofDay.filter(
        (p) => p.type === "sleep" && (p.total_sleep_duration ?? 0) >= MIN_MAIN_SLEEP_HOURS * 3600,
      );
  if (!pool.length) return null;
  return pool.reduce((best, p) =>
    (p.total_sleep_duration ?? 0) > (best.total_sleep_duration ?? 0) ? p : best,
  );
}

const sleepHours = (period) =>
  period?.total_sleep_duration == null ? null : period.total_sleep_duration / 3600;

/** Rolling baseline from the 7 nights before `day` (not including it). */
function baseline7d(periods, day) {
  const nights = [];
  for (let i = 1; i <= 7; i++) {
    const p = pickMainSleep(periods, addDays(day, -i));
    if (p) nights.push(p);
  }
  const hrvs = nights.map((p) => p.average_hrv).filter((v) => v != null);
  const lows = nights.map((p) => p.lowest_heart_rate).filter((v) => v != null);
  const hours = nights.map(sleepHours).filter((v) => v != null);
  return {
    nights: nights.length,
    hrvNights: hrvs.length,
    avgHrv: round(mean(hrvs)),
    lowestHr: round(mean(lows)),
    sleepHours: round(mean(hours), 1),
  };
}

/**
 * Apply the red-flag rules to the data that exists. Returns
 * [{ code, label, detail }]. Pure: no I/O, no clock.
 */
function computeFlags({ readiness, mainSleep, prevSleep, baseline }, t = THRESHOLDS) {
  const flags = [];
  const add = (code, detail) => flags.push({ code, label: FLAG_LABELS[code], detail });

  const temp = readiness?.temperature_deviation;
  if (temp != null && temp >= t.tempDeviationC) {
    add("temp_elevated", `temperature +${round(temp, 2)}°C vs baseline`);
  }
  if (readiness?.score != null && readiness.score < t.readinessLow) {
    add("low_readiness", `readiness ${readiness.score} (< ${t.readinessLow})`);
  }
  const hrv = mainSleep?.average_hrv;
  if (
    hrv != null &&
    baseline?.avgHrv != null &&
    (baseline.hrvNights ?? 0) >= t.hrvBaselineMinNights &&
    hrv < baseline.avgHrv * (1 - t.hrvDropFraction)
  ) {
    const pct = Math.round((1 - hrv / baseline.avgHrv) * 100);
    add("low_hrv", `HRV ${hrv}ms, ${pct}% below 7-night avg ${baseline.avgHrv}ms`);
  }
  // Two consecutive short nights: last night and the night before.
  const h1 = sleepHours(mainSleep);
  const h0 = sleepHours(prevSleep);
  if (h1 != null && h0 != null && h1 < t.shortSleepHours && h0 < t.shortSleepHours) {
    add("short_sleep", `slept ${round(h1, 1)}h last night and ${round(h0, 1)}h the night before`);
  }
  return flags;
}

/**
 * One compact aggregate for `day` from the fetched collections. `ready` means
 * the night's data (readiness + sleep) has reached Oura's cloud; activity is
 * reported separately because it lands later and is partial for today.
 */
function aggregateDay(day, { readiness, dailySleep, sleepPeriods, activity }) {
  const r = (readiness ?? []).find((d) => d.day === day) ?? null;
  const ds = (dailySleep ?? []).find((d) => d.day === day) ?? null;
  const main = pickMainSleep(sleepPeriods, day);
  const prev = pickMainSleep(sleepPeriods, addDays(day, -1));
  const act = (activity ?? []).find((d) => d.day === day) ?? null;
  const baseline = baseline7d(sleepPeriods, day);

  const missing = [];
  if (!r) missing.push("readiness");
  if (!ds || !main) missing.push("sleep");
  if (!act) missing.push("activity");

  return {
    date: day,
    ready: Boolean(r && ds && main),
    missing,
    readiness: r
      ? {
          score: r.score ?? null,
          tempDeviation: round(r.temperature_deviation, 2),
          // Oura's 0-100 contributor scores, NOT measurements: restingHr 100
          // means "resting HR is great vs your baseline", not 100 bpm. The
          // measured values are sleep.lowestHr / sleep.avgHrv.
          contributorScores: {
            hrvBalance: r.contributors?.hrv_balance ?? null,
            restingHr: r.contributors?.resting_heart_rate ?? null,
            recoveryIndex: r.contributors?.recovery_index ?? null,
            sleepBalance: r.contributors?.sleep_balance ?? null,
          },
        }
      : null,
    sleep:
      ds || main
        ? {
            score: ds?.score ?? null,
            totalHours: round(sleepHours(main), 1),
            efficiency: main?.efficiency ?? null,
            avgHrv: main?.average_hrv ?? null,
            lowestHr: main?.lowest_heart_rate ?? null,
            avgHr: round(main?.average_heart_rate),
          }
        : null,
    activity: act
      ? {
          score: act.score ?? null,
          steps: act.steps ?? null,
          activeCalories: act.active_calories ?? null,
          highMinutes: round((act.high_activity_time ?? 0) / 60),
          mediumMinutes: round((act.medium_activity_time ?? 0) / 60),
        }
      : null,
    baseline7d: baseline,
    flags: computeFlags({ readiness: r, mainSleep: main, prevSleep: prev, baseline }),
  };
}

/** Compact workout list for a day; distance in km, duration from timestamps. */
function summarizeWorkouts(workouts, day) {
  return (workouts ?? [])
    .filter((w) => w.day === day)
    .map((w) => {
      const start = Date.parse(w.start_datetime);
      const end = Date.parse(w.end_datetime);
      return {
        id: w.id,
        day: w.day,
        activity: w.activity,
        label: w.label ?? null,
        start: w.start_datetime,
        end: w.end_datetime,
        durationMin:
          Number.isFinite(start) && Number.isFinite(end) ? round((end - start) / 60000) : null,
        calories: round(w.calories),
        distanceKm: w.distance == null ? null : round(w.distance / 1000, 2),
        intensity: w.intensity ?? null,
        source: w.source ?? null,
      };
    })
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

/**
 * Average and peak heart rate from the samples inside [start, end]. Pure; the
 * samples themselves are never printed or stored, only these two numbers.
 */
function hrStats(samples, start, end) {
  const from = Date.parse(start);
  const to = Date.parse(end);
  const bpms = (samples ?? [])
    .filter((s) => {
      const t = Date.parse(s.timestamp);
      return s.bpm != null && Number.isFinite(t) && t >= from && t <= to;
    })
    .map((s) => s.bpm);
  if (!bpms.length) return { avgHr: null, maxHr: null };
  return { avgHr: round(mean(bpms)), maxHr: Math.max(...bpms) };
}

/**
 * Heart-rate zones as a fraction of the user's max HR (the common 5-zone model).
 * Below zone 1 (under 50%) is not counted.
 */
const HR_ZONES = [
  { zone: "z1", from: 0.5, to: 0.6 },
  { zone: "z2", from: 0.6, to: 0.7 },
  { zone: "z3", from: 0.7, to: 0.8 },
  { zone: "z4", from: 0.8, to: 0.9 },
  { zone: "z5", from: 0.9, to: Number.POSITIVE_INFINITY },
];
// A sample stands for the time until the next one, capped so a gap in the data
// (ring off, lost contact) is not credited to whatever zone came before it.
const MAX_SAMPLE_GAP_MS = 60 * 1000;

/** Tanaka et al. (2001): 208 - 0.7 x age. Closer than 220 - age, still an estimate. */
function estimateMaxHr(age) {
  return age == null || !Number.isFinite(Number(age)) ? null : Math.round(208 - 0.7 * Number(age));
}

/**
 * Minutes in each zone for the samples inside [start, end]. Pure. Returns null
 * without a max HR or samples, so a missing zone is never shown as zero.
 */
function hrZones(samples, start, end, userMaxHr) {
  if (!userMaxHr) return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  const pts = (samples ?? [])
    .map((s) => ({ t: Date.parse(s.timestamp), bpm: s.bpm }))
    .filter((p) => p.bpm != null && Number.isFinite(p.t) && p.t >= from && p.t <= to)
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return null;
  const gaps = pts.slice(1).map((p, i) => p.t - pts[i].t);
  const typical = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 5000;
  const ms = Object.fromEntries(HR_ZONES.map((z) => [z.zone, 0]));
  pts.forEach((p, i) => {
    const span = Math.min(i < gaps.length ? gaps[i] : typical, MAX_SAMPLE_GAP_MS);
    const pct = p.bpm / userMaxHr;
    const z = HR_ZONES.find((zone) => pct >= zone.from && pct < zone.to);
    if (z) ms[z.zone] += span;
  });
  return Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, Math.round(v / 60000)]));
}

/**
 * Record a tracked attempt for `day`. Keeps the first attempt, the attempt
 * count, and the first time the data was seen ready; trimmed to 90 days.
 * Pure over (log, day, ready, nowIso) so it is testable; returns the new log.
 */
function recordSyncAttempt(log, day, ready, nowIso) {
  const next = { ...log };
  const entry = { firstAttemptAt: nowIso, attempts: 0, firstReadyAt: null, ...(next[day] ?? {}) };
  entry.attempts += 1;
  if (ready && !entry.firstReadyAt) entry.firstReadyAt = nowIso;
  next[day] = entry;
  const keep = Object.keys(next).sort().slice(-90);
  return Object.fromEntries(keep.map((k) => [k, next[k]]));
}

function trackSync(day, ready) {
  let log = {};
  try {
    log = JSON.parse(fs.readFileSync(SYNC_LOG_FILE, "utf8"));
  } catch {
    /* first run */
  }
  const next = recordSyncAttempt(log, day, ready, new Date().toISOString());
  fs.mkdirSync(path.dirname(SYNC_LOG_FILE), { recursive: true });
  const tmp = `${SYNC_LOG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, SYNC_LOG_FILE);
  return next[day];
}

// ─── commands ────────────────────────────────────────────────────────────────
const print = (obj) => console.log(JSON.stringify(obj));

async function cmdStatus() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    print({ configured: false, reason: "OURA_CLIENT_ID / OURA_CLIENT_SECRET missing" });
    return;
  }
  if (!refreshToken()) {
    print({ configured: false, reason: "no token; run `node scripts/oura-auth.mjs`" });
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const docs = await fetchCollection("daily_readiness", addDays(today, -7), addDays(today, 1));
  const latest =
    docs
      .map((d) => d.day)
      .sort()
      .at(-1) ?? null;
  print({ configured: true, sandbox: SANDBOX, latestReadinessDay: latest });
}

async function cmdDay(args) {
  const day = requireDate(args.date);
  const result = aggregateDay(day, await fetchRange(day, day));
  if (args.track) result.sync = trackSync(day, result.ready);
  print(result);
}

/**
 * The user's max HR for zones: a measured value passed as --max-hr (from
 * PERSONAL.md) wins; otherwise estimate it from the age in Oura's personal info.
 * Only `age` is read from that response; weight, height, sex and email are
 * never printed or stored.
 */
async function resolveUserMaxHr(args) {
  const given = Number(args["max-hr"]);
  if (args["max-hr"] !== undefined) {
    if (!Number.isFinite(given) || given < 100 || given > 230) {
      throw new Error(
        `--max-hr must be a measured max heart rate in bpm (100-230), got "${args["max-hr"]}".`,
      );
    }
    return { bpm: Math.round(given), basis: "measured (PERSONAL.md)" };
  }
  try {
    const { age } = await oura("/personal_info");
    const bpm = estimateMaxHr(age);
    return bpm
      ? { bpm, basis: `estimated from age ${age} (208 - 0.7 x age)` }
      : { bpm: null, basis: "unknown: no age in the Oura profile; pass --max-hr" };
  } catch (err) {
    return {
      bpm: null,
      basis: /403/.test(err.message)
        ? "unknown: no personal-info access; re-run `node scripts/oura-auth.mjs` or pass --max-hr"
        : `unknown: ${err.message}`,
    };
  }
}

async function cmdWorkouts(args) {
  const day = requireDate(args.date);
  const docs = await fetchCollection("workout", day, addDays(day, 1));
  const workouts = summarizeWorkouts(docs, day);
  // Average/peak HR and zone minutes per workout from the heartrate scope. A
  // token minted before that scope was granted gets a 403: report it once and
  // keep the workouts.
  let hrNote;
  const userMaxHr = workouts.length ? await resolveUserMaxHr(args) : null;
  for (const w of workouts) {
    Object.assign(w, { avgHr: null, maxHr: null, zonesMin: null });
    if (hrNote || !w.start || !w.end) continue;
    try {
      const samples = await fetchHeartRate(w.start, w.end);
      Object.assign(w, hrStats(samples, w.start, w.end));
      w.zonesMin = hrZones(samples, w.start, w.end, userMaxHr?.bpm);
    } catch (err) {
      hrNote = /403/.test(err.message)
        ? "No heart-rate access: re-run `node scripts/oura-auth.mjs` to grant the heartrate scope."
        : `Heart rate unavailable: ${err.message}`;
    }
  }
  print({
    date: day,
    ...(userMaxHr ? { userMaxHr } : {}),
    workouts,
    ...(hrNote ? { hrNote } : {}),
  });
}

async function cmdTrend(args) {
  const end = requireDate(args.end, "--end");
  const days = Math.min(Math.max(Number.parseInt(args.days ?? "14", 10) || 14, 1), 90);
  const start = addDays(end, -(days - 1));
  const data = await fetchRange(start, end);
  const rows = [];
  for (let i = 0; i < days; i++) {
    const a = aggregateDay(addDays(start, i), data);
    rows.push({
      date: a.date,
      readiness: a.readiness?.score ?? null,
      sleepScore: a.sleep?.score ?? null,
      sleepHours: a.sleep?.totalHours ?? null,
      avgHrv: a.sleep?.avgHrv ?? null,
      lowestHr: a.sleep?.lowestHr ?? null,
      tempDeviation: a.readiness?.tempDeviation ?? null,
      activityScore: a.activity?.score ?? null,
      steps: a.activity?.steps ?? null,
      flags: a.flags.map((f) => f.code),
    });
  }
  print({ start, end, days: rows });
}

const COMMANDS = {
  status: cmdStatus,
  day: cmdDay,
  workouts: cmdWorkouts,
  trend: cmdTrend,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(`Unknown command "${command}". Use one of: ${Object.keys(COMMANDS).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (command !== "status" && !ouraConfigured()) {
    console.error(
      "Oura is not configured. Set OURA_CLIENT_ID / OURA_CLIENT_SECRET and run " +
        "`node scripts/oura-auth.mjs` once (see docs/configuration.md).",
    );
    process.exitCode = 1;
    return;
  }
  await fn(parseArgs(rest));
}

// Run only when invoked directly, so the pure helpers can be unit-tested.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

export {
  THRESHOLDS,
  FLAG_LABELS,
  parseArgs,
  addDays,
  pickMainSleep,
  baseline7d,
  computeFlags,
  aggregateDay,
  summarizeWorkouts,
  recordSyncAttempt,
  accessToken,
  fetchCollection,
  hrStats,
  hrZones,
  estimateMaxHr,
};
