import fs from "node:fs";
import { Cron } from "croner";
import { type ModelTier, runAgent } from "../agent/runner.js";
import { sendMessage } from "../channel/notify.js";
import { config } from "../config.js";
import { writeJsonAtomic } from "../util/atomicfile.js";

/**
 * Cron-based scheduler for proactive coaching: morning session nudges, the weekly
 * plan, reminders. Tasks are persisted to a plain local JSON file.
 *
 * When a task fires, it runs the agent with the task's prompt and pushes the result
 * to the task's chat. Because the agent shares the chat's session, the reminder lands
 * in context with the ongoing conversation.
 *
 * A task with `runAt` (ISO datetime) instead of a cron expression is a one-shot: it
 * fires once and is then removed. The Oura sync retries (+10 min, +1 h) use these.
 * One-shots survive a restart: a past-due one fires on load unless it is more than
 * ONE_SHOT_STALE_MS late, in which case it is dropped (a retry for a morning that
 * has long passed is noise, not help).
 */

export interface ScheduledTask {
  id: string;
  name: string;
  /** Standard 5-field cron. Empty for one-shot tasks. */
  cron: string;
  /** One-shot fire time (ISO 8601). When set, `cron` is ignored. */
  runAt?: string;
  prompt: string;
  chatId: string;
  enabled: boolean;
  modelTier?: ModelTier;
}

const tasks = new Map<string, { task: ScheduledTask; job: Cron }>();
const SCHEDULE_FILE = config.scheduleFile;
export const ONE_SHOT_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * What to do with a one-shot task at `now`: schedule it for later, fire it right
 * away (past-due but recent, e.g. after a restart), or drop it (stale or invalid).
 * Returns null for recurring (cron) tasks.
 */
export function oneShotDisposition(
  task: ScheduledTask,
  now: number = Date.now(),
): "schedule" | "fire" | "drop" | null {
  if (!task.runAt) return null;
  const at = Date.parse(task.runAt);
  if (Number.isNaN(at)) return "drop";
  if (at > now) return "schedule";
  return now - at > ONE_SHOT_STALE_MS ? "drop" : "fire";
}

/**
 * Default reminders seeded the first time the agent runs with no schedule file.
 * The user can edit, disable, or remove these by asking the agent in chat. Times
 * are interpreted in the configured timezone.
 */
function defaultTasks(): ScheduledTask[] {
  if (!config.ownerChatId) return [];
  return [
    {
      id: "morning-nudge",
      name: "Morning session nudge",
      cron: "0 8 * * *",
      prompt:
        "Good morning. If Oura is configured, run the recovery-check skill in morning mode first (it handles data that has not synced yet). Then tell me what today's training session should be based on my goals, my weekly plan, what I have logged recently, and last night's recovery. Keep it short and motivating.",
      chatId: config.ownerChatId,
      enabled: true,
      modelTier: "standard",
    },
    // Only seeded when Oura is set up: without it there is nothing to recap.
    ...(config.ouraClientId
      ? [
          {
            id: "lunch-recovery",
            name: "Lunch recovery recap",
            cron: "30 12 * * *",
            prompt:
              "Lunch check-in. Run the recovery-check skill in lunch mode: recap yesterday from Oura (recovery, activity, workouts), say how this morning's session lined up with today's readiness, give me a nutrition and hydration nudge for the rest of today, and a heads-up for tomorrow. Save yesterday's Recovery row and sync Oura workouts to Notion. Keep it short.",
            chatId: config.ownerChatId,
            enabled: true,
            modelTier: "standard" as ModelTier,
          },
        ]
      : []),
    {
      id: "weekly-plan",
      name: "Sunday weekly plan",
      cron: "0 18 * * 0",
      prompt:
        "It is the start of a new week. Build my training plan for the coming week from my goals and recent training volume, then save it to Notion and summarise it for me here.",
      chatId: config.ownerChatId,
      enabled: true,
      modelTier: "standard",
    },
  ];
}

// The task definitions, kept in memory whether or not croner is driving them.
// In webhook mode the external scheduler (Cloud Scheduler) fires them via
// /cron/run, so the in-process croner jobs are not started.
let definitions: ScheduledTask[] = [];

export async function initScheduler(): Promise<void> {
  let loaded = loadFromDisk();

  if (loaded.length === 0) {
    loaded = defaultTasks();
    if (loaded.length > 0) {
      saveToDisk(loaded);
      console.log(`[scheduler] Seeded ${loaded.length} default tasks`);
    }
  }
  definitions = loaded;

  // Only run the in-process cron loop when long-polling. In webhook mode the
  // process is asleep most of the time, so an external scheduler drives reminders.
  if (config.mode === "polling") {
    for (const task of loaded) {
      if (task.enabled) startTask(task);
    }
    console.log(`[scheduler] Loaded ${loaded.length} tasks (${tasks.size} active, croner)`);
  } else {
    console.log(`[scheduler] Loaded ${loaded.length} tasks (webhook mode, external trigger)`);
  }
}

/** Look up a task definition by id (used by the /cron/run endpoint). */
export function getTask(id: string): ScheduledTask | undefined {
  return definitions.find((t) => t.id === id);
}

/** Run a task now: invoke the agent with its prompt and push the result. */
export async function executeTask(task: ScheduledTask): Promise<void> {
  console.log(`[scheduler] Running: ${task.name}`);
  try {
    const response = await runAgent({
      userMessage: task.prompt,
      chatId: task.chatId,
      userLabel: "scheduled task",
      modelTier: task.modelTier ?? "standard",
    });
    await sendMessage(task.chatId, response.text || "(no output)");
  } catch (err: any) {
    console.error(`[scheduler] Task ${task.name} failed:`, err.message);
    await sendMessage(task.chatId, `Scheduled task "${task.name}" failed: ${err.message}`).catch(
      () => {},
    );
  }
}

export function addTask(task: ScheduledTask): void {
  if (definitions.some((t) => t.id === task.id)) {
    console.warn(`[scheduler] Task id "${task.id}" already exists; replacing it.`);
  }
  definitions = [...definitions.filter((t) => t.id !== task.id), task];
  // Only start a live croner job in polling mode; webhook mode is fired externally.
  if (config.mode === "polling") startTask(task);
  persist();
  console.log(`[scheduler] Added task: ${task.name} (${task.runAt ?? task.cron})`);
}

export function removeTask(taskId: string): boolean {
  const existed = definitions.some((t) => t.id === taskId);
  definitions = definitions.filter((t) => t.id !== taskId);
  const entry = tasks.get(taskId);
  if (entry) {
    entry.job.stop();
    tasks.delete(taskId);
  }
  if (!existed && !entry) return false;
  persist();
  console.log(`[scheduler] Removed task: ${taskId}`);
  return true;
}

export function listTasks(): ScheduledTask[] {
  return definitions;
}

function startTask(task: ScheduledTask): void {
  switch (oneShotDisposition(task)) {
    case null: {
      const job = new Cron(task.cron, { timezone: config.timezone }, () => executeTask(task));
      tasks.set(task.id, { task, job });
      return;
    }
    case "schedule": {
      const job = new Cron(new Date(task.runAt as string), () => runOneShot(task));
      tasks.set(task.id, { task, job });
      return;
    }
    case "fire":
      setImmediate(() => void runOneShot(task));
      return;
    case "drop":
      console.log(`[scheduler] Dropping stale one-shot: ${task.name} (${task.runAt})`);
      removeTask(task.id);
      return;
  }
}

/**
 * Fire a one-shot. It is removed before running, so a crash or restart mid-run
 * cannot fire it twice, and so the agent sees an accurate task list while it runs
 * (e.g. when it cancels the remaining Oura retry).
 */
async function runOneShot(task: ScheduledTask): Promise<void> {
  if (!definitions.some((t) => t.id === task.id)) return; // cancelled meanwhile
  removeTask(task.id);
  await executeTask(task);
}

function persist(): void {
  // definitions is the authoritative task list in both modes; add/remove keep it
  // in sync with the live croner jobs (polling mode) before this is called.
  saveToDisk(definitions);
}

function loadFromDisk(): ScheduledTask[] {
  try {
    if (!fs.existsSync(SCHEDULE_FILE)) return [];
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf-8")) as ScheduledTask[];
  } catch (err) {
    console.warn("[scheduler] Failed to read schedule file:", (err as Error).message);
    return [];
  }
}

function saveToDisk(all: ScheduledTask[]): void {
  try {
    writeJsonAtomic(SCHEDULE_FILE, all);
  } catch (err) {
    console.warn("[scheduler] Failed to persist schedule file:", (err as Error).message);
  }
}
