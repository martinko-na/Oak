#!/usr/bin/env node
/**
 * oura-auth.mjs: one-time Oura authorisation.
 *
 * Run manually during setup (not by the agent):
 *
 *   node --env-file=.env scripts/oura-auth.mjs
 *
 * Oura retired personal access tokens in December 2025, so the API is OAuth2
 * only. This uses the authorisation-code flow with a loopback redirect: it
 * starts a throwaway HTTP server on 127.0.0.1, prints the consent URL for you
 * to open, receives the redirect with the authorisation code, exchanges it for
 * tokens, and writes data/oura-token.json (gitignored). scripts/oura.mjs then
 * mints short-lived access tokens from it transparently.
 *
 * Prerequisites (once, at https://cloud.ouraring.com/oauth/applications):
 *   1. Create an API application.
 *   2. Add the redirect URI http://localhost:8765/callback (or set
 *      OURA_REDIRECT_PORT and register that port instead). Oura matches the
 *      redirect URI exactly, so the port is fixed rather than random.
 *   3. Put the client id/secret in .env as OURA_CLIENT_ID / OURA_CLIENT_SECRET.
 *
 * Scopes: daily summaries (sleep, readiness, activity), workouts, heart rate
 * (average/peak HR and zone minutes per workout), and personal info (only the
 * age is read, to estimate max HR for zones). No tags, no email. Re-run this script after changing scopes; the old token keeps its
 * original grant.
 *
 * Oura rotates the refresh token on every refresh, so the token file is the
 * live store and must persist between runs (a local data/ folder or a mounted
 * volume). A refresh token copied into an env var would stop working after the
 * first refresh.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const CLIENT_ID = process.env.OURA_CLIENT_ID;
const CLIENT_SECRET = process.env.OURA_CLIENT_SECRET;
const SCOPE = "daily workout heartrate personal";
const PORT = Number(process.env.OURA_REDIRECT_PORT ?? 8765);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const TOKEN_FILE = path.resolve(
  process.cwd(),
  process.env.OURA_TOKEN_FILE ?? path.join("data", "oura-token.json"),
);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "OURA_CLIENT_ID / OURA_CLIENT_SECRET are not set. Create an API application at " +
      "https://cloud.ouraring.com/oauth/applications, add both to .env, then re-run with:\n" +
      "  node --env-file=.env scripts/oura-auth.mjs",
  );
  process.exit(1);
}

// CSRF guard: the redirect must echo back the state we generated.
const state = crypto.randomBytes(16).toString("hex");

const server = http.createServer();
server.listen(PORT, "127.0.0.1", () => {
  const url = new URL("https://cloud.ouraring.com/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    state,
  }).toString();

  console.log("Open this URL in your browser and grant Oura access:\n");
  console.log(url.toString());
  console.log(`\nWaiting for Oura to redirect back to ${REDIRECT_URI} ...`);

  server.on("request", async (req, res) => {
    const reqUrl = new URL(req.url, REDIRECT_URI);
    const code = reqUrl.searchParams.get("code");
    const error = reqUrl.searchParams.get("error");
    if (!code && !error) {
      // Favicon or stray request; ignore and keep waiting.
      res.writeHead(404).end();
      return;
    }
    const badState = !error && reqUrl.searchParams.get("state") !== state;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      error || badState
        ? `<h3>Authorisation failed: ${error ?? "state mismatch"}</h3>You can close this tab.`
        : "<h3>Authorised.</h3>You can close this tab and return to the terminal.",
    );
    server.close();
    if (error || badState) {
      console.error(`Authorisation failed: ${error ?? "state mismatch"}`);
      process.exit(1);
    }
    try {
      await exchange(code);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });
});

server.on("error", (err) => {
  console.error(
    `Could not listen on 127.0.0.1:${PORT} (${err.message}). Free the port or set OURA_REDIRECT_PORT (and register the matching redirect URI in your Oura application).`,
  );
  process.exit(1);
});

async function exchange(code) {
  const res = await fetch("https://api.ouraring.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.refresh_token) {
    throw new Error(
      `Token exchange failed (${res.status}): ${json.error_description ?? json.error ?? "no refresh token returned"}`,
    );
  }
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  const tmp = `${TOKEN_FILE}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify(
      {
        refresh_token: json.refresh_token,
        access_token: json.access_token,
        expires_at: Date.now() + (json.expires_in ?? 86400) * 1000,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  fs.renameSync(tmp, TOKEN_FILE);
  console.log(`\nTokens saved to ${path.relative(process.cwd(), TOKEN_FILE)}.`);
  console.log("Oura is ready. Try: node --env-file=.env scripts/oura.mjs status");
}
