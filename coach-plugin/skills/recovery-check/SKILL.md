---
name: recovery-check
description: Read the user's Oura data (last night's readiness and sleep, yesterday's activity and workouts) and turn it into coaching. Use for the morning readiness check before today's session, the lunch recovery recap, when the user says they synced their Oura ring, or asks how they slept or recovered. Also handles Oura data that has not synced yet (nudge plus retries).
---

# Recovery check (Oura)

Oura tells you how recovered the user is. Use it to shape today's training, not to lecture. All access goes through `scripts/oura.mjs` (run via Bash), which prints compact JSON. Every number you quote comes from that JSON or from Notion. Never estimate or fill in an Oura value.

If `node scripts/oura.mjs status` reports `configured: false`, say once that Oura isn't set up (`node scripts/oura-auth.mjs`) and coach without it. Never fake recovery data.

## Reading the data

```bash
# Night ending on the morning of D (readiness + sleep) and the activity of day D.
# Dates always come from the Telegram header, never computed internally.
node scripts/oura.mjs day --date 2026-10-07 --track   # --track only for the morning check and its retries
node scripts/oura.mjs workouts --date 2026-10-06 [--max-hr 188]   # pass --max-hr only if PERSONAL.md has a measured max HR
node scripts/oura.mjs trend --end 2026-10-07 --days 14
```

Key fields of `day`:

- `ready`: true once last night's readiness and sleep are in Oura's cloud. `missing` lists what isn't there yet (`readiness`, `sleep`, `activity`). Missing means **not synced yet**, never "bad recovery".
- `readiness.contributorScores` are Oura's 0-100 scores, not measurements: `restingHr: 100` means resting HR is excellent vs baseline, never "100 bpm". Quote measured values only from `sleep.lowestHr` / `sleep.avgHrv`.
- `readiness.score`, `readiness.tempDeviation` (°C vs the user's baseline), `sleep.totalHours`, `sleep.avgHrv`, `sleep.lowestHr`, `activity.*` (partial if D is today).
- `baseline7d`: the 7 nights before D. Compare last night against it ("HRV 38, your week's been around 52"), which means more than raw numbers.
- `flags`: red flags computed in code. You do not decide thresholds; you act on these.

## Red flags override the plan

When `flags` is non-empty, adjust today's session before giving it, explain why in one line, and tell the user they can consciously overrule you:

| Flag | What to do |
|---|---|
| `temp_elevated` | Rest or easy mobility only. Say their temperature is up and that it can be an early sign their body is fighting something. Do not diagnose. If they also feel unwell, suggest rest and, if it persists, seeing a professional (see Safety in CLAUDE.md). |
| `low_readiness` / `low_hrv` | Deload: same movements at ~60-70% load and fewer sets, or swap to Zone 2 cardio or mobility. |
| `short_sleep` | Cap intensity (RPE 7 max, no max attempts or PR tests) and name the sleep pattern once, kindly. |

Several flags: take the most conservative action. No flags: train as planned. If readiness is high (85+) and the plan allows it, it's a good day to push.

## Morning mode (08:00 task)

1. `node scripts/oura.mjs day --date <today> --track`.
2. **Ready:** apply the flags above, then give today's session (recommend-workout skill), shaped by readiness. Lead with one line on recovery ("Readiness 82, HRV right on your baseline. Good to go.").
3. **Not ready:** do not hold the session hostage. Give the planned session as written, then add the nudge: "Oura hasn't synced last night yet. Open the Oura app to sync, then reply **synced** and I'll adjust today's session." Then schedule the two retries (below), unless they already exist for today (`curl -s http://localhost:9130/tasks`).

### Retry ladder (one-shot tasks)

```bash
curl -s -X POST http://localhost:9130/tasks -d '{
  "id": "oura-retry-<today>-10m",
  "name": "Oura sync retry (10 min)",
  "inMinutes": 10,
  "chatId": "<chat id from the header>",
  "prompt": "Oura sync retry 1 of 2 for <today>. Run the recovery-check skill retry step with --track. If the data is ready, cancel oura-retry-<today>-1h and send the readiness-adjusted session. If not, reply with one short line that you will check again in an hour."
}'
curl -s -X POST http://localhost:9130/tasks -d '{
  "id": "oura-retry-<today>-1h",
  "name": "Oura sync retry (1 h)",
  "inMinutes": 60,
  "chatId": "<chat id from the header>",
  "prompt": "Oura sync retry 2 of 2 (final) for <today>. Run the recovery-check skill retry step with --track. If the data is ready, send the readiness-adjusted session. If not, say in one line that there is no readiness data today and to go by the plan. No more nudges today."
}'
```

`inMinutes` is turned into an absolute time by the host, so never compute timestamps yourself. One-shots fire once and delete themselves. They only fire in polling mode; if `localhost:9130` is unreachable, skip the retries and tell the user to reply **synced** when they have synced.

### Retry step (from a retry task)

Run `day --date <today> --track`. If ready, cancel any remaining retry (`curl -s -X DELETE http://localhost:9130/tasks/oura-retry-<today>-1h`) and send the adjustment: compare readiness with the session already given this morning and say only what changes ("Readiness 58, drop the top set and keep it to 3 working sets"), or "readiness 80, the plan stands". If the session is already done, give the recap instead. Keep it to a few lines.

### The user replies "synced" (or "done", "synced it", etc.)

1. Run `day --date <today> --track`.
2. Ready: delete both retries (`DELETE .../tasks/oura-retry-<today>-10m` and `-1h`; a 404 is fine), then send the adjustment as in the retry step.
3. Not ready yet: say Oura's cloud can lag a few minutes behind the app and the scheduled checks will pick it up. Leave the retries in place.

## Lunch mode (12:30 task)

1. `day --date <yesterday>` (complete: yesterday morning's readiness and sleep plus yesterday's full activity) and `day --date <today>` (this morning's readiness).
2. Save yesterday to Notion. Pipe the JSON straight in so the numbers never pass through you, and add a one-line takeaway in your own words:
   ```bash
   node scripts/oura.mjs day --date <yesterday> | node scripts/notion.mjs upsert-recovery --takeaway "<one line>"
   ```
3. Sync workouts for yesterday and today (this morning's session):
   ```bash
   node scripts/oura.mjs workouts --date <yesterday> [--max-hr N] | node scripts/notion.mjs sync-oura-workouts
   node scripts/oura.mjs workouts --date <today> [--max-hr N] | node scripts/notion.mjs sync-oura-workouts
   ```
   Each workout carries `avgHr` / `maxHr` (peak in that workout) and `zonesMin` (minutes in zones 1-5 by % of max HR: 50-60, 60-70, 70-80, 80-90, 90+) when available. `userMaxHr.basis` says whether max HR was measured or estimated from age; if estimated, treat zones as approximate and say so once if it matters. Use zones to judge effort against intent: an "easy" run mostly in Z3-4 was not easy; aerobic-base goals want Z2 minutes; HIIT should show real Z4-5 time. If PERSONAL.md has a measured max HR, pass `--max-hr` to both workout commands. If the JSON has an `hrNote`, heart-rate access is missing: mention it once and carry on. Each sync output line is `enriched`, `created`, `skip` or `unmatched`. Mention any `unmatched` workout and ask about it in one line ("Oura saw a 45 min strength session yesterday but you logged two. Which one was it?"). Never log a strength session from Oura alone; the user logs those with sets and loads.
4. `node scripts/notion.mjs sync-dashboard --now <today>` (refreshes the Recovery tile too).
5. Message, short and in this order:
   - **Yesterday:** activity score, steps, any notable workout, one-line verdict.
   - **This morning:** did the logged session match readiness? (Pushed hard on a low-readiness day: say so kindly. Took it easy on a green day: fine, note it.)
   - **Rest of today:** one concrete nutrition or hydration nudge tied to the data (high activity or a hard session means protein and carbs at lunch; short sleep means steady meals and caffeine before 2pm; elevated temperature means fluids and an easy day). Follow the nutrition-advice skill and PERSONAL.md.
   - **Tomorrow:** a heads-up if the trend says so (two short nights, HRV sliding), else skip.
6. If yesterday's data is still `ready: false` at lunch (rare), schedule one quiet retry (`"id": "oura-retry-<today>-lunch"`, `"inMinutes": 60`, prompt: re-run lunch mode steps 2-4 and only message if something notable changed). Send the recap with what you have. No sync nudge at lunch.

## Trends and progress

For "how's my sleep been", progress reports, or weekly planning, use `trend` (up to 90 days, fetched live from Oura, nothing stored) and the Notion **Recovery** database (one row per day plus your takeaways). Cross-reference with the Workout Log: bad nights before weak sessions, or readiness dropping after heavy weeks, are worth naming.

## Privacy

Only aggregates go to Notion (the Recovery row and the Oura fields on Workout Log rows, including average and peak HR and zone minutes). From Oura's personal info only the age is used; never repeat or store weight, height, sex or email from it. Never write raw Oura payloads, heart-rate samples, sleep stages, or anything beyond those fields to Notion or files.
