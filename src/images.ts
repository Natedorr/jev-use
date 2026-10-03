/**
 * Images by reference: screenshot paths turned into the base64 a vision model
 * takes, on the server side, so the pixels never pass through the agent's
 * context. Only paths are accepted from the agent — base64 in a tool argument
 * would put the image in context, the opposite of the point.
 */

import { open } from "node:fs/promises";
import { scopedPath, SourceError } from "./sources.js";

/** Most images one call may carry. */
export const MAX_IMAGES = 8;

/** Refuse to read a file larger than this; no vision model takes more. */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** Most decoded bytes one call may carry across all its images. */
export const MAX_TOTAL_IMAGE_BYTES = 48 * 1024 * 1024;

/** Enough leading bytes for every magic-number check. */
const SNIFF_BYTES = 16;

export interface ImageScope {
  roots: string[];
  allowPaths?: string[];
}

export type ImageType = "png" | "jpeg" | "webp";

export interface LoadedImages {
  /** Base64, no data-URL prefix, in the order given. */
  data: string[];
  /** What was read, e.g. "shot.png (png, 48213 bytes)". */
  origins: string[];
  /** Total decoded size in bytes. */
  bytes: number;
}

/** The image type a file's leading bytes declare, or null. */
export function sniffImageType(head: Uint8Array): ImageType | null {
  const startsWith = (offset: number, bytes: number[]) =>
    head.length >= offset + bytes.length && bytes.every((byte, i) => head[offset + i] === byte);
  if (startsWith(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(0, [0xff, 0xd8, 0xff])) return "jpeg";
  // RIFF....WEBP
  if (startsWith(0, [0x52, 0x49, 0x46, 0x46]) && startsWith(8, [0x57, 0x45, 0x42, 0x50])) return "webp";
  return null;
}

/** Read each path inside the allowed roots, check its magic bytes, and base64 it. */
export async function loadImages(files: string[], scope: ImageScope): Promise<LoadedImages> {
  if (files.length > MAX_IMAGES) {
    throw new SourceError(`At most ${MAX_IMAGES} images per call; got ${files.length}.`);
  }
  const loaded: LoadedImages = { data: [], origins: [], bytes: 0 };
  for (const file of files) {
    const { path } = await scopedPath(file, { ...scope, redact: false, maxChars: 0 });
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      if (size > MAX_IMAGE_BYTES) {
        throw new SourceError(
          `${file} is ${size} bytes; images over ${MAX_IMAGE_BYTES} bytes are not read. Capture a smaller viewport.`,
        );
      }
      if (loaded.bytes + size > MAX_TOTAL_IMAGE_BYTES) {
        throw new SourceError(
          `Images total over ${MAX_TOTAL_IMAGE_BYTES} bytes at ${file}; pass fewer or smaller images.`,
        );
      }
      // Check the type from the head before reading the rest of the file.
      const head = Buffer.alloc(Math.min(SNIFF_BYTES, size));
      await handle.read(head, 0, head.length, 0);
      const type = sniffImageType(head);
      if (!type) {
        throw new SourceError(`${file} is not a PNG, JPEG or WebP image.`);
      }
      const content = await handle.readFile();
      loaded.data.push(content.toString("base64"));
      loaded.origins.push(`${file} (${type}, ${content.length} bytes)`);
      loaded.bytes += content.length;
    } finally {
      await handle.close();
    }
  }
  return loaded;
}
