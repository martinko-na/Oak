/**
 * Inbound attachments (images, PDFs) the user sends along with, or instead of, a
 * text message. The Telegram channel downloads the bytes; this module stages them
 * on disk and hands the agent a path to Read, rather than inlining base64 into the
 * message sent to the CLI. Handy for a coach: meal photos, food labels, a gym
 * machine, or a progress picture.
 *
 * Why a file and not an inline image block
 * ----------------------------------------
 * Inlining is the SDK's documented way to attach an image, and it is what this
 * module used to do. It does not survive contact with real photos: the CLI reads
 * the prompt as one JSON line on stdin, and a line carrying a base64 image in a
 * particular size window dies with "Error parsing streaming input line", killing
 * the subprocess with exit code 1 before any session opens.
 *
 * Measured on the deployment (2026-10-07, same options, idle host, repeated runs):
 *
 *   image <= 105KB   (<=140KB base64)  passes
 *   image 108-150KB  (144-200KB base64) fails, mostly deterministically
 *   image >= 200KB   (>=266KB base64)  passes, up to the 5MB cap
 *
 * A phone photo scaled by Telegram lands squarely in that window, which is why
 * photos looked like they never worked while text always did. Retrying does not
 * help: for a given photo it fails every time.
 *
 * Staging sidesteps the whole thing. The message becomes a short line of text, so
 * no payload size can break the parser, and the model sees the image through Read,
 * which handles both images and PDFs. It is a workaround for a CLI bug, so it is
 * written to be easy to revert: delete this file's staging half and pass the
 * attachments inline again once a fixed SDK is in place.
 */

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export interface Attachment {
  /** MIME type, e.g. "image/jpeg" or "application/pdf". */
  mediaType: string;
  /** Base64-encoded bytes (no data: URI prefix). */
  data: string;
}

/** One attachment written to disk, ready for the agent to Read. */
export interface StagedAttachment {
  /** Absolute path the agent is told to Read. */
  path: string;
  mediaType: string;
  bytes: number;
}

/** Image types Claude accepts as vision input. */
const SUPPORTED_IMAGE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** File extension per accepted type, so Read recognises what it is opening. */
const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/** True if a MIME type can be sent to the model as context. */
export function isSupportedAttachment(mediaType: string): boolean {
  return SUPPORTED_IMAGE.has(mediaType) || mediaType === "application/pdf";
}

/**
 * Write each usable attachment into `dir` and return what was staged. Unsupported
 * types are skipped. One attachment failing to write does not lose the others: it
 * is reported and dropped, the same as an attachment that failed to download.
 */
export async function stageAttachments(
  attachments: Attachment[] | undefined,
  dir: string,
): Promise<StagedAttachment[]> {
  if (!attachments?.length) return [];
  await fsp.mkdir(dir, { recursive: true });

  const staged: StagedAttachment[] = [];
  for (const att of attachments) {
    const extension = EXTENSION[att.mediaType];
    if (!extension) continue;
    const bytes = Buffer.from(att.data, "base64");
    // Random name: two photos in the same second must not collide, and the name
    // must not be attacker-chosen (it comes from a chat message).
    const file = path.join(dir, `${crypto.randomUUID()}.${extension}`);
    try {
      await fsp.writeFile(file, bytes);
      staged.push({ path: file, mediaType: att.mediaType, bytes: bytes.byteLength });
    } catch (err) {
      console.warn(`[attachments] Could not stage ${att.mediaType}: ${(err as Error).message}`);
    }
  }
  return staged;
}

/**
 * The line appended to the prompt telling the agent what arrived and where. Blunt
 * on purpose: the model has to actually call Read, and answering a photo it never
 * opened is worse than saying it could not open it.
 */
export function attachmentPrompt(staged: StagedAttachment[]): string {
  if (staged.length === 0) return "";
  const list = staged
    .map((s) => `- ${s.path} (${s.mediaType}, ${Math.round(s.bytes / 1024)}KB)`)
    .join("\n");
  const noun = staged.length === 1 ? "file" : "files";
  return `\n[The user attached the following ${noun} to this message. Read each one with the Read tool before you reply, and use what you see. If a Read fails, say so rather than guessing at the contents.]\n${list}`;
}

/** Delete staged files once the run is over. Never throws. */
export async function discardStaged(staged: StagedAttachment[]): Promise<void> {
  for (const s of staged) {
    try {
      await fsp.rm(s.path, { force: true });
    } catch (err) {
      console.warn(`[attachments] Could not remove ${s.path}: ${(err as Error).message}`);
    }
  }
}

/**
 * Remove staged files left behind by a crash or a hard restart. Called at startup:
 * without it the inbox grows without bound, since nothing else ever reads it.
 */
export async function sweepStagedDir(dir: string, maxAgeMs = 60 * 60 * 1000): Promise<number> {
  let removed = 0;
  try {
    const entries = await fsp.readdir(dir);
    const cutoff = Date.now() - maxAgeMs;
    for (const entry of entries) {
      const file = path.join(dir, entry);
      try {
        const stat = await fsp.stat(file);
        if (stat.mtimeMs < cutoff) {
          await fsp.rm(file, { force: true });
          removed++;
        }
      } catch {
        /* vanished under us, or not ours to read: leave it alone */
      }
    }
  } catch {
    // No inbox yet is the normal case on a fresh deployment.
    return 0;
  }
  return removed;
}
