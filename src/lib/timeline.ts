/**
 * Pure timeline arithmetic — no React, no Tauri.
 *
 * The whole editor is one track of clips laid end to end, so a clip's position is implied
 * by its index rather than stored. Everything here is a pure function of the clip list,
 * which keeps the interesting behaviour (interpolation, splitting a photo around a
 * generated segment) testable without rendering anything.
 */

import {
  DEFAULT_PHOTO_DURATION_MS,
  IDENTITY_TRANSFORM,
  MAX_SCALE,
  MIN_SCALE,
  type Clip,
  type Keyframe,
  type PlacedClip,
  type Segment,
  type Transform2D,
} from '../types/project';

let idCounter = 0;
/** Stable, readable ids. Not cryptographic — they only have to be unique in a session. */
export function makeId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Test seam: reset the counter so ids are predictable. */
export function resetIds(): void {
  idCounter = 0;
}

export function layout(clips: Clip[]): PlacedClip[] {
  let cursor = 0;
  return clips.map((clip) => {
    const startMs = cursor;
    cursor += clip.durationMs;
    return { clip, startMs, endMs: cursor };
  });
}

export function totalDurationMs(clips: Clip[]): number {
  return clips.reduce((sum, clip) => sum + clip.durationMs, 0);
}

/** The clip under the playhead, with the time relative to that clip's own start. */
export function clipAt(clips: Clip[], timeMs: number): { placed: PlacedClip; localMs: number } | null {
  const placed = layout(clips);
  for (const item of placed) {
    if (timeMs >= item.startMs && timeMs < item.endMs) {
      return { placed: item, localMs: timeMs - item.startMs };
    }
  }
  // Sitting exactly on the end shows the last frame rather than nothing.
  const last = placed[placed.length - 1];
  if (last && timeMs >= last.endMs) {
    return { placed: last, localMs: last.clip.durationMs };
  }
  return null;
}

export function startOfClip(clips: Clip[], clipId: string): number {
  return layout(clips).find((p) => p.clip.id === clipId)?.startMs ?? 0;
}

export function sortKeyframes(keyframes: Keyframe[]): Keyframe[] {
  return [...keyframes].sort((a, b) => a.timeMs - b.timeMs);
}

/** The gaps between consecutive keyframes. A prompt hangs off each one. */
export function segmentsOf(clip: Clip): Segment[] {
  const sorted = sortKeyframes(clip.keyframes);
  const segments: Segment[] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const from = sorted[i];
    const to = sorted[i + 1];
    segments.push({
      fromKeyframeId: from.id,
      toKeyframeId: to.id,
      startMs: from.timeMs,
      endMs: to.timeMs,
      durationMs: to.timeMs - from.timeMs,
    });
  }
  return segments;
}

export function findSegment(clip: Clip, fromKeyframeId: string, toKeyframeId: string): Segment | null {
  return (
    segmentsOf(clip).find(
      (s) => s.fromKeyframeId === fromKeyframeId && s.toKeyframeId === toKeyframeId,
    ) ?? null
  );
}

export function clampTransform(t: Transform2D): Transform2D {
  return {
    scale: clamp(t.scale, MIN_SCALE, MAX_SCALE),
    x: clamp(t.x, -100, 100),
    y: clamp(t.y, -100, 100),
    rotation: clamp(t.rotation, -180, 180),
    opacity: clamp(t.opacity, 0, 1),
  };
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * The photo's framing at `localMs`, interpolated between the surrounding keyframes.
 * Values are held flat before the first keyframe and after the last, which is what the
 * export filter does too.
 */
export function transformAt(clip: Clip, localMs: number): Transform2D {
  const keys = sortKeyframes(clip.keyframes);
  if (keys.length === 0) return { ...IDENTITY_TRANSFORM };
  if (keys.length === 1 || localMs <= keys[0].timeMs) return { ...keys[0].transform };

  const last = keys[keys.length - 1];
  if (localMs >= last.timeMs) return { ...last.transform };

  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    if (localMs >= a.timeMs && localMs <= b.timeMs) {
      const span = b.timeMs - a.timeMs;
      const t = span === 0 ? 0 : (localMs - a.timeMs) / span;
      return {
        scale: lerp(a.transform.scale, b.transform.scale, t),
        x: lerp(a.transform.x, b.transform.x, t),
        y: lerp(a.transform.y, b.transform.y, t),
        rotation: lerp(a.transform.rotation, b.transform.rotation, t),
        opacity: lerp(a.transform.opacity, b.transform.opacity, t),
      };
    }
  }
  return { ...last.transform };
}

/** The CSS transform that draws `t` in the preview, matching the export's semantics. */
export function cssTransform(t: Transform2D): string {
  return `translate(${t.x}%, ${t.y}%) scale(${t.scale}) rotate(${t.rotation}deg)`;
}

export function addKeyframe(clip: Clip, timeMs: number, transform?: Transform2D): Clip {
  const at = clamp(Math.round(timeMs), 0, clip.durationMs);
  const existing = clip.keyframes.find((k) => Math.abs(k.timeMs - at) < 1);
  if (existing) {
    // Re-keying the same instant replaces it rather than stacking two on one spot.
    return {
      ...clip,
      keyframes: sortKeyframes(
        clip.keyframes.map((k) =>
          k.id === existing.id
            ? { ...k, transform: clampTransform(transform ?? transformAt(clip, at)) }
            : k,
        ),
      ),
    };
  }
  const keyframe: Keyframe = {
    id: makeId('kf'),
    timeMs: at,
    transform: clampTransform(transform ?? transformAt(clip, at)),
  };
  return { ...clip, keyframes: sortKeyframes([...clip.keyframes, keyframe]) };
}

export function removeKeyframe(clip: Clip, keyframeId: string): Clip {
  const prompts = { ...clip.prompts };
  delete prompts[keyframeId];
  return {
    ...clip,
    keyframes: clip.keyframes.filter((k) => k.id !== keyframeId),
    prompts,
  };
}

export function updateKeyframe(clip: Clip, keyframeId: string, patch: Partial<Transform2D>): Clip {
  return {
    ...clip,
    keyframes: clip.keyframes.map((k) =>
      k.id === keyframeId ? { ...k, transform: clampTransform({ ...k.transform, ...patch }) } : k,
    ),
  };
}

export function moveKeyframe(clip: Clip, keyframeId: string, timeMs: number): Clip {
  const at = clamp(Math.round(timeMs), 0, clip.durationMs);
  return {
    ...clip,
    keyframes: sortKeyframes(
      clip.keyframes.map((k) => (k.id === keyframeId ? { ...k, timeMs: at } : k)),
    ),
  };
}

export function setPrompt(clip: Clip, fromKeyframeId: string, prompt: string): Clip {
  return { ...clip, prompts: { ...clip.prompts, [fromKeyframeId]: prompt } };
}

export function photoClip(asset: { id: string; name: string }, durationMs = DEFAULT_PHOTO_DURATION_MS): Clip {
  return {
    id: makeId('clip'),
    assetId: asset.id,
    kind: 'photo',
    name: asset.name,
    durationMs,
    trimStartMs: 0,
    keyframes: [],
    prompts: {},
  };
}

export function videoClip(asset: { id: string; name: string }, durationMs: number): Clip {
  return {
    id: makeId('clip'),
    assetId: asset.id,
    kind: 'video',
    name: asset.name,
    durationMs: Math.max(100, Math.round(durationMs)),
    trimStartMs: 0,
    keyframes: [],
    prompts: {},
  };
}

export function insertClips(clips: Clip[], index: number, incoming: Clip[]): Clip[] {
  const at = clamp(index, 0, clips.length);
  return [...clips.slice(0, at), ...incoming, ...clips.slice(at)];
}

/** Where a drop at `xRatio` (0..1 across the track) should land. */
export function insertIndexAt(clips: Clip[], xRatio: number): number {
  const total = totalDurationMs(clips);
  if (total === 0) return 0;
  const timeMs = clamp(xRatio, 0, 1) * total;
  const placed = layout(clips);
  for (let i = 0; i < placed.length; i += 1) {
    const { startMs, endMs } = placed[i];
    if (timeMs < startMs + (endMs - startMs) / 2) return i;
  }
  return clips.length;
}

/**
 * Put a generated clip where the KF1→KF2 segment was.
 *
 * The photo is split into what came before the segment, the generated video, and what came
 * after — so a segment covering the whole photo replaces it outright, and a segment in the
 * middle leaves the untouched parts alone with their own keyframes.
 */
export function replaceSegment(
  clips: Clip[],
  clipId: string,
  fromKeyframeId: string,
  toKeyframeId: string,
  generated: { assetId: string; name: string; prompt: string },
): Clip[] {
  const index = clips.findIndex((c) => c.id === clipId);
  if (index === -1) return clips;

  const clip = clips[index];
  const segment = findSegment(clip, fromKeyframeId, toKeyframeId);
  if (!segment || segment.durationMs <= 0) return clips;

  const replacement: Clip[] = [];

  if (segment.startMs > 0) {
    replacement.push({
      ...clip,
      id: makeId('clip'),
      durationMs: segment.startMs,
      keyframes: sortKeyframes(clip.keyframes.filter((k) => k.timeMs < segment.startMs)),
      prompts: pickPrompts(clip, (k) => k.timeMs < segment.startMs),
    });
  }

  replacement.push({
    id: makeId('clip'),
    assetId: generated.assetId,
    kind: 'video',
    name: generated.name,
    durationMs: segment.durationMs,
    trimStartMs: 0,
    keyframes: [],
    prompts: {},
    ai: { prompt: generated.prompt, sourceAssetId: clip.assetId },
  });

  if (segment.endMs < clip.durationMs) {
    replacement.push({
      ...clip,
      id: makeId('clip'),
      durationMs: clip.durationMs - segment.endMs,
      keyframes: sortKeyframes(
        clip.keyframes
          .filter((k) => k.timeMs >= segment.endMs)
          .map((k) => ({ ...k, timeMs: k.timeMs - segment.endMs })),
      ),
      prompts: pickPrompts(clip, (k) => k.timeMs >= segment.endMs),
    });
  }

  return [...clips.slice(0, index), ...replacement, ...clips.slice(index + 1)];
}

function pickPrompts(clip: Clip, keep: (k: Keyframe) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of clip.keyframes) {
    if (keep(k) && clip.prompts[k.id]) out[k.id] = clip.prompts[k.id];
  }
  return out;
}

export function formatTimecode(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hundredths = Math.floor((safe % 1000) / 10);
  return `${pad(minutes)}:${pad(seconds)}.${pad(hundredths)}`;
}

export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function pad(v: number): string {
  return v.toString().padStart(2, '0');
}

/** Middle-truncate so the extension stays readable on a narrow clip. */
export function truncateName(name: string, max = 26): string {
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}
