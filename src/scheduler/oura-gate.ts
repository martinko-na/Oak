import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ask scripts/oura.mjs whether last night's data has reached Oura's cloud, so
 * the scheduler can hold the morning nudge back without waking the agent.
 * Runs with --track, so the sync log records the attempt like any other check.
 *
 * Returns true or false from the helper's `ready` field, or null when the check
 * itself failed (token expired, network, Oura down): the caller then runs the
 * agent anyway, which reports the problem rather than staying silent forever.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

export function ouraReady(date: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["scripts/oura.mjs", "day", "--date", date, "--track"],
      { cwd: PROJECT_ROOT, timeout: 60_000 },
      (err, stdout) => {
        if (err) {
          console.warn(`[oura-gate] Oura check failed: ${err.message}`);
          return resolve(null);
        }
        try {
          resolve(JSON.parse(stdout).ready === true);
        } catch {
          console.warn("[oura-gate] Oura check printed no JSON");
          resolve(null);
        }
      },
    );
  });
}
