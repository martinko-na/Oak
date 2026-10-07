import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/**
 * Oura access.
 *
 * The agent reads Oura exclusively through the bundled `scripts/oura.mjs`
 * helper (run via Bash), the same pattern as Notion and Google Calendar. Auth
 * is OAuth2: tokens minted once by `scripts/oura-auth.mjs` into
 * data/oura-token.json, refreshed (and rotated) on demand by the helper.
 *
 * Configured means: OAuth client id and secret are set, and a refresh token is
 * available (token file, or OURA_REFRESH_TOKEN as a bootstrap seed). When not
 * configured the bot runs fine; coaching just goes without recovery data.
 */
export function ouraConfigured(): boolean {
  if (!config.ouraClientId || !config.ouraClientSecret) return false;
  if (config.ouraRefreshToken) return true;
  try {
    const tokenPath = path.resolve(process.cwd(), config.ouraTokenFile);
    const token = JSON.parse(fs.readFileSync(tokenPath, "utf-8")) as { refresh_token?: string };
    return Boolean(token.refresh_token);
  } catch {
    return false;
  }
}
