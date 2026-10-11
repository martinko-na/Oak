---
name: nutrition-advice
description: Give food, macro, and meal guidance tied to the user's goals, and record what they ate in the Notion Nutrition Log. Use when the user asks about what to eat, calories, protein or macros, meal ideas, eating around training, or fat loss and muscle gain nutrition, and whenever they tell you (or show you) what they have eaten.
---

# Nutrition advice

Give practical, sustainable food guidance that supports the user's training goals.

## 1. Gather context

- Read `PERSONAL.md`: goals, body stats, dietary preferences and restrictions, foods they dislike, daily routine, and any nutrition target.
- Read today's Nutrition Log row before advising, so the advice accounts for what is already eaten: `node scripts/notion.mjs query-recent --db "Nutrition Log" --limit 3`. Advising 180g of protein to someone who has already had 150g is worse than useless.
- Consider their recent training (from the Notion Workout Log, via `node scripts/notion.mjs query-recent --db "Workout Log"`) if energy or recovery is relevant to the question.

## 2. Advise sensibly

- Tie advice to the goal: a modest surplus with enough protein for muscle gain, a modest deficit with high protein and preserved training for fat loss, adequate fuelling for performance.
- Respect their dietary restrictions and dislikes without exception. Suggest foods they will actually eat.
- Give concrete, usable answers: portion guidance, simple meal ideas, protein targets in grams, timing around training when it matters. Avoid jargon and faff.

## 3. Log what they ate

Nutrition is stored, not just discussed. The Nutrition Log keeps one row per day (totals in the
properties) with each meal as a line in the page body. Whenever the user tells you or shows you a
meal, record it:

```bash
# The date comes from the Telegram message header, never computed.
node scripts/notion.mjs log-meal --date 2026-10-11 --time 13:00 \
     --meal "Chicken rice bowl" --kcal 710 --protein 58 --carbs 72 --fat 18

# Correcting a day: the user edits or deletes a line in Notion, then
node scripts/notion.mjs recompute-nutrition --date 2026-10-11
```

- `--kcal` is required; the macros are optional. Pass only what you can actually estimate, and
  leave a macro out rather than guessing it: a missing value reads as "not recorded", a wrong one
  reads as fact.
- The day's totals are re-derived from the logged lines on every write, so never try to set a
  total yourself and never state a daily total you have not read back from the output.
- An estimate from a photo or a description is an estimate. Say so in one short clause ("roughly
  700 kcal") rather than implying precision you do not have. If the description is too vague to
  estimate ("had a sandwich"), ask one specific question instead of inventing a number.
- When you agree targets with the user, record them so the Dashboard compares against a real
  number, and mirror them into the Nutrition section of `PERSONAL.md`:

```bash
node scripts/notion.mjs set-nutrition-target --kcal 2200 --protein 180
```

- After any nutrition write, refresh the Dashboard in the same turn:
  `node scripts/notion.mjs sync-dashboard --now <today>`.

## 4. Stay safe

- You are not a registered dietitian or doctor. Say so when it matters.
- Keep it healthy and sustainable. Do not recommend very low calorie targets, crash diets, dehydration or water cuts, extreme restriction, or supplements with safety concerns.
- If the request suggests disordered eating, a medical condition, pregnancy, or being significantly under or over weight, recommend they speak to a qualified professional, and keep your guidance conservative and supportive.

Keep the reply concise and encouraging. If they have no targets recorded yet and one would help them stay consistent, offer to set them.
