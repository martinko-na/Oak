import type { Api, Bot } from "grammy";
import { redactSecrets } from "../util/redact.js";
import { toPlainText, toRichMarkdown, toTelegramHtml } from "./format.js";

/**
 * Outbound messaging, shared by inbound replies and proactive pushes (the
 * scheduler and any other background task). Secrets are scrubbed first. Each chunk
 * goes out as a rich message (Bot API 10.1+), which renders the model's Markdown
 * natively, tables included. If Telegram rejects it, the chunk falls back to the
 * older HTML path (tables as <pre> blocks), and then to plain text.
 */

/** Rich message text limit, per the Bot API. */
const RICH_MAX = 32768;
/** Classic message text limit, used by the HTML and plain-text fallbacks. */
const TEXT_MAX = 4096;

type SendApi = Pick<Api, "sendRichMessage" | "sendMessage">;

let botRef: Bot | null = null;

export function registerBot(bot: Bot): void {
  botRef = bot;
}

export async function sendMessage(chatId: string | number, text: string): Promise<void> {
  if (!botRef) {
    console.warn("[notify] No bot registered, cannot send message");
    return;
  }
  await deliver(botRef.api, chatId, text);
}

/** Send text to a chat: rich message first, then HTML, then plain text. */
export async function deliver(api: SendApi, chatId: string | number, text: string): Promise<void> {
  const safe = redactSecrets(text);
  for (const chunk of splitMessage(safe, RICH_MAX)) {
    try {
      await api.sendRichMessage(chatId, { markdown: toRichMarkdown(chunk) });
      continue;
    } catch (err: any) {
      console.warn(`[notify] Rich message rejected, falling back to HTML: ${err?.message ?? err}`);
    }
    for (const part of splitMessage(chunk, TEXT_MAX)) {
      try {
        await api.sendMessage(chatId, toTelegramHtml(part), { parse_mode: "HTML" });
      } catch {
        await api.sendMessage(chatId, toPlainText(part));
      }
    }
  }
}

/** Split a message into Telegram-sized chunks, preferring to break on newlines. */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
