/**
 * Rendering a keyframe to a still.
 *
 * Higgsfield animates between two images, so "the photo as keyframe 1 frames it" and "the
 * photo as keyframe 2 frames it" have to be baked into actual pixels before the request
 * goes out. That is exactly what the preview already draws, done once onto a canvas.
 */

import type { Transform2D } from '../types/project';

export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 720;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load the photo (${src.slice(0, 60)})`));
    img.src = src;
  });
}

/**
 * Draw `src` with `transform` applied and return it as a JPEG data URL.
 *
 * The source is scaled to *cover* the frame first, matching both the preview's `object-fit`
 * and the export filter's `force_original_aspect_ratio=increase`, so what the user sees is
 * what the API is asked to animate.
 */
export async function renderKeyframeJpeg(
  src: string,
  transform: Transform2D,
  width = FRAME_WIDTH,
  height = FRAME_HEIGHT,
): Promise<string> {
  const image = await loadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('this browser cannot render keyframes to an image');

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  const cover = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * cover;
  const drawHeight = image.naturalHeight * cover;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, transform.opacity));
  // Percentages of the canvas, so the numbers mean the same thing at any export size.
  ctx.translate(width / 2 + (transform.x / 100) * width, height / 2 + (transform.y / 100) * height);
  ctx.rotate((transform.rotation * Math.PI) / 180);
  ctx.scale(transform.scale, transform.scale);
  ctx.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  ctx.restore();

  return canvas.toDataURL('image/jpeg', 0.9);
}

/**
 * A video's real duration, read from its metadata.
 *
 * Resolves to `fallbackMs` if the browser cannot tell us in time — a clip that appears at
 * the wrong length is far better than an import that hangs.
 */
export function probeVideoDurationMs(src: string, fallbackMs: number, timeoutMs = 4000): Promise<number> {
  return probeDurationMs('video', src, fallbackMs, timeoutMs);
}

/** The same for a sound file, read through an `<audio>` element. */
export function probeAudioDurationMs(src: string, fallbackMs: number, timeoutMs = 4000): Promise<number> {
  return probeDurationMs('audio', src, fallbackMs, timeoutMs);
}

function probeDurationMs(
  tag: 'video' | 'audio',
  src: string,
  fallbackMs: number,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ms: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ms);
    };
    const timer = setTimeout(() => done(fallbackMs), timeoutMs);

    try {
      const media = document.createElement(tag);
      media.preload = 'metadata';
      media.onloadedmetadata = () => {
        const seconds = media.duration;
        done(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : fallbackMs);
      };
      media.onerror = () => done(fallbackMs);
      media.src = src;
    } catch {
      done(fallbackMs);
    }
  });
}
