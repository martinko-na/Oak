import http from "node:http";
import { type ScheduledTask, addTask, listTasks, removeTask } from "./scheduler.js";

/**
 * Localhost-only control plane for reminders. The agent (running as a child process
 * on the same host) can curl these endpoints to manage scheduled tasks live, so
 * "remind me to train at 6pm on weekdays" takes effect immediately rather than on
 * the next restart. Bound to 127.0.0.1 only, so it is not reachable off-box.
 *
 * POST /tasks takes either `cron` (recurring) or a one-shot time: `inMinutes`
 * (relative, preferred) or `runAt` (absolute ISO 8601). One-shots fire once and
 * are then removed.
 */

const PORT = 9130;

export function startSchedulerServer(): void {
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && req.url === "/tasks") {
      send(200, { tasks: listTasks() });
      return;
    }

    if (req.method === "POST" && req.url === "/tasks") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const t = JSON.parse(body) as Partial<ScheduledTask> & { inMinutes?: number };
          // One-shots: `inMinutes` is computed here from the host clock, so the
          // agent never has to work out an absolute timestamp in the right zone.
          let runAt: string | undefined;
          if (t.inMinutes !== undefined) {
            const mins = Number(t.inMinutes);
            if (!Number.isFinite(mins) || mins <= 0 || mins > 7 * 24 * 60) {
              send(400, { error: "inMinutes must be a positive number of minutes (max 7 days)" });
              return;
            }
            runAt = new Date(Date.now() + mins * 60_000).toISOString();
          } else if (t.runAt !== undefined) {
            const at = Date.parse(t.runAt);
            if (Number.isNaN(at) || at <= Date.now()) {
              send(400, { error: "runAt must be a future ISO 8601 datetime" });
              return;
            }
            runAt = new Date(at).toISOString();
          }
          if (!t.name || !t.prompt || !t.chatId || (!t.cron && !runAt)) {
            send(400, {
              error: "name, prompt, chatId, and one of cron, runAt or inMinutes are required",
            });
            return;
          }
          const task: ScheduledTask = {
            id: t.id || `task-${Date.now()}`,
            name: t.name,
            cron: runAt ? "" : (t.cron as string),
            ...(runAt ? { runAt } : {}),
            prompt: t.prompt,
            chatId: t.chatId,
            enabled: t.enabled ?? true,
            modelTier: t.modelTier ?? "standard",
          };
          addTask(task);
          send(200, { ok: true, task });
        } catch (err: any) {
          send(500, { error: err.message });
        }
      });
      return;
    }

    if (req.method === "DELETE" && req.url?.startsWith("/tasks/")) {
      const id = decodeURIComponent(req.url.slice("/tasks/".length));
      const removed = removeTask(id);
      send(removed ? 200 : 404, { ok: removed });
      return;
    }

    send(404, { error: "Not found" });
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[scheduler] Control plane on http://localhost:${PORT}/tasks`);
  });
}
