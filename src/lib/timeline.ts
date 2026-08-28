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
  MAX_PHOTO_DURATION_MS,
  MAX_SCALE,
  MIN_CLIP_DURATION_MS,
  MIN_SCALE,
  type AudioTrack,
  type Clip,
  type ClipEdge,
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
    durationMs: Math.max(MIN_CLIP_DURATION_MS, Math.round(durationMs)),
    trimStartMs: 0,
    keyframes: [],
    prompts: {},
  };
}

export function insertClips(clips: Clip[], index: number, incoming: Clip[]): Clip[] {
  const at = clamp(index, 0, clips.length);
  return [...clips.slice(0, at), ...incoming, ...clips.slice(at)];
}

/** The boundary nearest `timeMs`, as an index into `clips`. */
export function insertIndexAtTime(clips: Clip[], timeMs: number): number {
  const placed = layout(clips);
  for (let i = 0; i < placed.length; i += 1) {
    const { startMs, endMs } = placed[i];
    if (timeMs < startMs + (endMs - startMs) / 2) return i;
  }
  return clips.length;
}

/** Where a drop at `xRatio` (0..1 across the track) should land. */
export function insertIndexAt(clips: Clip[], xRatio: number): number {
  const total = totalDurationMs(clips);
  if (total === 0) return 0;
  return insertIndexAtTime(clips, clamp(xRatio, 0, 1) * total);
}

/** Where the clip at `index` starts — the boundary an insertion marker is drawn on. */
export function startOfIndex(clips: Clip[], index: number): number {
  return clips
    .slice(0, clamp(index, 0, clips.length))
    .reduce((sum, c) => sum + c.durationMs, 0);
}

/**
 * Where a clip dragged to `timeMs` wants to land, counted among the clips it leaves
 * behind — the same index `moveClip` takes.
 */
export function dropIndexFor(clips: Clip[], clipId: string, timeMs: number): number {
  return insertIndexAtTime(
    clips.filter((c) => c.id !== clipId),
    timeMs,
  );
}

/**
 * Reposition a clip in the order. `toIndex` counts positions among the *other* clips, so
 * "put it back where it was" is a no-op rather than an off-by-one.
 */
export function moveClip(clips: Clip[], clipId: string, toIndex: number): Clip[] {
  const from = clips.findIndex((c) => c.id === clipId);
  if (from === -1) return clips;
  const rest = [...clips.slice(0, from), ...clips.slice(from + 1)];
  const at = clamp(Math.round(toIndex), 0, rest.length);
  if (at === from) return clips;
  return [...rest.slice(0, at), clips[from], ...rest.slice(at)];
}

/**
 * Move one edge of a clip by `deltaMs` — positive is always "to the right", whichever edge
 * it is.
 *
 * The track is gapless, so the head edge is a trim rather than a move: pulling it right
 * shortens the clip from the front and everything after slides left with it. On a video
 * that walks `trimStartMs` by the same amount, so the frames still on screen stay on the
 * frames they were on and only the in-point moves.
 *
 * `sourceDurationMs` is the real length of the file behind the clip. Leave it `undefined`
 * when it has not been probed yet: the clip can then only shrink, because nothing proves
 * there are more frames to show.
 */
export function resizeClip(
  clip: Clip,
  edge: ClipEdge,
  deltaMs: number,
  sourceDurationMs?: number,
): Clip {
  const delta = Math.round(deltaMs);
  if (!Number.isFinite(delta) || delta === 0) return clip;
  return edge === 'end' ? resizeEnd(clip, delta, sourceDurationMs) : resizeStart(clip, delta);
}

function resizeEnd(clip: Clip, delta: number, sourceDurationMs?: number): Clip {
  const durationMs = clamp(
    clip.durationMs + delta,
    MIN_CLIP_DURATION_MS,
    maxDurationOf(clip, sourceDurationMs),
  );
  if (durationMs === clip.durationMs) return clip;
  return withKeyframesInside({ ...clip, durationMs }, 0);
}

// No `sourceDurationMs` here: a head trim moves the in-point and the length by the same
// amount, so the out-point never moves and whatever bound it was already inside, it stays in.
function resizeStart(clip: Clip, delta: number): Clip {
  // How far left the head can go: back to the start of the source, or — for a photo, which
  // has no source to run out of — as far as the overall cap allows.
  const headroom =
    clip.kind === 'video' ? clip.trimStartMs : MAX_PHOTO_DURATION_MS - clip.durationMs;
  const shift = clamp(delta, -headroom, clip.durationMs - MIN_CLIP_DURATION_MS);
  if (shift === 0) return clip;

  // `trimStartMs + durationMs` is unchanged, so the out-point cannot escape the source.
  return withKeyframesInside(
    {
      ...clip,
      durationMs: clip.durationMs - shift,
      trimStartMs: clip.kind === 'video' ? clip.trimStartMs + shift : clip.trimStartMs,
    },
    -shift,
  );
}

/** The longest this clip could be played from its current in-point. */
function maxDurationOf(clip: Clip, sourceDurationMs?: number): number {
  if (clip.kind !== 'video') return MAX_PHOTO_DURATION_MS;
  // Unprobed: the only frames known to exist are the ones the clip already plays.
  const available =
    sourceDurationMs === undefined ? clip.durationMs : sourceDurationMs - clip.trimStartMs;
  return Math.max(available, MIN_CLIP_DURATION_MS);
}

/**
 * Keep a resized clip's keyframes inside it.
 *
 * They travel with the content by `shiftMs`, and anything that ends up outside is pinned to
 * the nearest edge rather than dropped — the framing a user set for the end of a photo is
 * still the framing they want at its new end. Keyframes that come to rest on the same
 * instant collapse to the last of them, and prompts hanging off the ones that went with
 * them go too.
 */
function withKeyframesInside(clip: Clip, shiftMs: number): Clip {
  if (clip.keyframes.length === 0) return clip;

  const byTime = new Map<number, Keyframe>();
  for (const kf of sortKeyframes(clip.keyframes)) {
    const timeMs = clamp(kf.timeMs + shiftMs, 0, clip.durationMs);
    byTime.set(timeMs, { ...kf, timeMs });
  }
  const keyframes = sortKeyframes([...byTime.values()]);
  const kept = new Set(keyframes.map((k) => k.id));
  return { ...clip, keyframes, prompts: pickPrompts(clip, (k) => kept.has(k.id)) };
}

// ---------------------------------------------------------------- audio tracks

export function audioTrack(asset: { id: string; name: string }, startMs: number, durationMs: number): AudioTrack {
  return {
    id: makeId('audio'),
    assetId: asset.id,
    name: asset.name,
    startMs: Math.max(0, Math.round(startMs)),
    durationMs: Math.max(MIN_CLIP_DURATION_MS, Math.round(durationMs)),
    trimStartMs: 0,
    volume: 1,
    muted: false,
  };
}

/** Slide the sound along the timeline. It can start anywhere except before zero. */
export function moveAudio(track: AudioTrack, startMs: number): AudioTrack {
  const at = Math.max(0, Math.round(startMs));
  return at === track.startMs ? track : { ...track, startMs: at };
}

/**
 * Trim an audio track's edge by `deltaMs` — positive is "to the right", like `resizeClip`.
 *
 * Audio behaves like video: the head edge walks `trimStartMs` so the sound already playing
 * stays on the samples it was on, and the tail cannot pass the end of the source. Unlike a
 * clip on the gapless track, the head here also moves `startMs`, because trimming the
 * front of a free-floating sound must not slide its remainder earlier. Until the source
 * length is probed the track can only shrink, exactly as an unprobed video can.
 */
export function resizeAudio(
  track: AudioTrack,
  edge: ClipEdge,
  deltaMs: number,
  sourceDurationMs?: number,
): AudioTrack {
  const delta = Math.round(deltaMs);
  if (!Number.isFinite(delta) || delta === 0) return track;

  if (edge === 'end') {
    const available =
      sourceDurationMs === undefined ? track.durationMs : sourceDurationMs - track.trimStartMs;
    const durationMs = clamp(
      track.durationMs + delta,
      MIN_CLIP_DURATION_MS,
      Math.max(available, MIN_CLIP_DURATION_MS),
    );
    return durationMs === track.durationMs ? track : { ...track, durationMs };
  }

  // Head: leftwards is bounded by the source's start and the timeline's start, whichever
  // is nearer; rightwards by the resize floor.
  const shift = clamp(
    delta,
    -Math.min(track.trimStartMs, track.startMs),
    track.durationMs - MIN_CLIP_DURATION_MS,
  );
  if (shift === 0) return track;
  return {
    ...track,
    startMs: track.startMs + shift,
    trimStartMs: track.trimStartMs + shift,
    durationMs: track.durationMs - shift,
  };
}

/** Where the last sound ends. Zero when there are none. */
export function audioEndMs(tracks: AudioTrack[]): number {
  return tracks.reduce((end, t) => Math.max(end, t.startMs + t.durationMs), 0);
}

/**
 * How long the whole timeline runs: the visual track, or an audio tail that outlasts it.
 * Playback and the ruler both use this, so a music bed past the last clip is still heard.
 */
export function timelineEndMs(clips: Clip[], tracks: AudioTrack[]): number {
  return Math.max(totalDurationMs(clips), audioEndMs(tracks));
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
