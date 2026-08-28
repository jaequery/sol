/**
 * Pure timeline arithmetic — no React, no Tauri.
 *
 * The editor is one visual track, but a clip's place on it is a time it carries (`startMs`)
 * rather than a position implied by its index: a clip can be dropped anywhere, leaving a
 * gap on either side. What one track still forbids is two clips at the same instant, since
 * there is nothing to composite them with — so an edit that would overlap slides the clip
 * it lands on out of the way instead. Everything here is a pure function of the clip list,
 * which keeps the interesting behaviour testable without rendering anything.
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
  type TransitionSource,
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

/** The clips in the order they play, each with the span it occupies. */
export function layout(clips: Clip[]): PlacedClip[] {
  return sortClips(clips).map((clip) => ({
    clip,
    startMs: clip.startMs,
    endMs: clip.startMs + clip.durationMs,
  }));
}

/** Clips in time order. The store keeps its list sorted; this is the guarantee. */
export function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.startMs - b.startMs);
}

/** Where the visual track ends — the end of its last clip, gaps included. */
export function trackEndMs(clips: Clip[]): number {
  return clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);
}

/** Lay clips end to end from `startMs` — how a batch of freshly imported media arrives. */
export function packClips(clips: Clip[], startMs = 0): Clip[] {
  let cursor = Math.max(0, Math.round(startMs));
  return clips.map((clip) => {
    const placed = { ...clip, startMs: cursor };
    cursor += clip.durationMs;
    return placed;
  });
}

/**
 * The clip under the playhead, with the time relative to that clip's own start. `null` in
 * a gap — and before the first clip — which the preview and the export both read as black.
 */
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
  return clips.find((c) => c.id === clipId)?.startMs ?? 0;
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

export function photoClip(
  asset: { id: string; name: string },
  durationMs = DEFAULT_PHOTO_DURATION_MS,
  startMs = 0,
): Clip {
  return {
    id: makeId('clip'),
    assetId: asset.id,
    kind: 'photo',
    name: asset.name,
    startMs: Math.max(0, Math.round(startMs)),
    durationMs,
    trimStartMs: 0,
    keyframes: [],
    prompts: {},
  };
}

export function videoClip(
  asset: { id: string; name: string },
  durationMs: number,
  startMs = 0,
): Clip {
  return {
    id: makeId('clip'),
    assetId: asset.id,
    kind: 'video',
    name: asset.name,
    startMs: Math.max(0, Math.round(startMs)),
    durationMs: Math.max(MIN_CLIP_DURATION_MS, Math.round(durationMs)),
    trimStartMs: 0,
    keyframes: [],
    prompts: {},
  };
}

/**
 * Drop `incoming` in at the boundary `index` names, laid end to end from there. Whatever
 * already sat at or after that boundary ripples right to make room — an import is an
 * insertion into the film, not something that lands on top of what is already there.
 */
export function insertClips(clips: Clip[], index: number, incoming: Clip[]): Clip[] {
  if (incoming.length === 0) return clips;
  const ordered = sortClips(clips);
  const at = startOfIndex(ordered, index);
  const placed = packClips(incoming, at);
  const room = trackEndMs(placed) - at;
  return sortClips([
    ...ordered.map((c) => (c.startMs >= at ? { ...c, startMs: c.startMs + room } : c)),
    ...placed,
  ]);
}

/** The boundary nearest `timeMs`, as an index into the clips in time order. */
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
  const total = trackEndMs(clips);
  if (total === 0) return 0;
  return insertIndexAtTime(clips, clamp(xRatio, 0, 1) * total);
}

/** Where the clip at `index` starts — the boundary an insertion marker is drawn on. */
export function startOfIndex(clips: Clip[], index: number): number {
  const ordered = sortClips(clips);
  const at = clamp(Math.round(index), 0, ordered.length);
  return at < ordered.length ? ordered[at].startMs : trackEndMs(ordered);
}

/**
 * Drop a clip at `startMs` — anywhere on the track, gaps included. The clip lands exactly
 * where it was let go; the only thing it cannot do is share an instant with another clip,
 * so whatever it comes down on top of slides right just far enough to clear it.
 */
export function placeClip(clips: Clip[], clipId: string, startMs: number): Clip[] {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return clips;
  const at = Math.max(0, Math.round(startMs));
  if (at === clip.startMs) return clips;
  return settleAround({ ...clip, startMs: at }, clips);
}

/**
 * Put `actor` on the track and make room for it: clips wholly before it keep their places
 * — and their gaps — while everything from its start onwards is walked right only as far
 * as it must be to stop overlapping. Sliding never closes a gap, so the rest of the
 * timeline reads exactly as the user left it.
 */
function settleAround(actor: Clip, clips: Clip[]): Clip[] {
  const others = sortClips(clips.filter((c) => c.id !== actor.id));
  const settled: Clip[] = [];
  let frontier = actor.startMs + actor.durationMs;

  for (const clip of others) {
    if (clip.startMs + clip.durationMs <= actor.startMs) {
      settled.push(clip);
      continue;
    }
    const startMs = Math.max(clip.startMs, frontier);
    frontier = startMs + clip.durationMs;
    settled.push(startMs === clip.startMs ? clip : { ...clip, startMs });
  }
  return sortClips([...settled, actor]);
}

/** Where the clip in front of `clipId` ends — the wall its head cannot be pulled past. */
export function endOfPrevious(clips: Clip[], clipId: string): number {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return 0;
  return clips
    .filter((c) => c.id !== clipId && c.startMs + c.durationMs <= clip.startMs)
    .reduce((end, c) => Math.max(end, c.startMs + c.durationMs), 0);
}

/**
 * Drag one edge of a clip on the track. The head is bounded by the clip in front of it —
 * it stops rather than shoving anything — while a tail that grows into the clip behind it
 * pushes that one along, which is how a clip has always been stretched.
 */
export function resizeClipInList(
  clips: Clip[],
  clipId: string,
  edge: ClipEdge,
  deltaMs: number,
  sourceDurationMs?: number,
): Clip[] {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return clips;
  const resized = resizeClip(
    clip,
    edge,
    deltaMs,
    sourceDurationMs,
    edge === 'start' ? endOfPrevious(clips, clipId) : 0,
  );
  return resized === clip ? clips : settleAround(resized, clips);
}

/**
 * Move one edge of a clip by `deltaMs` — positive is always "to the right", whichever edge
 * it is.
 *
 * The head edge moves the clip's place on the timeline as well as its length, so the tail
 * stays put on the frame it was on: pulling it right trims the front away, pulling it left
 * reveals more of the source in front. On a video that walks `trimStartMs` by the same
 * amount, so the frames still on screen stay on the frames they were on.
 *
 * `sourceDurationMs` is the real length of the file behind the clip. Leave it `undefined`
 * when it has not been probed yet: the clip can then only shrink, because nothing proves
 * there are more frames to show. `minStartMs` is the earliest the head may go — the end of
 * the clip in front of it on the track, or 0:00 when it is the first.
 */
export function resizeClip(
  clip: Clip,
  edge: ClipEdge,
  deltaMs: number,
  sourceDurationMs?: number,
  minStartMs = 0,
): Clip {
  const delta = Math.round(deltaMs);
  if (!Number.isFinite(delta) || delta === 0) return clip;
  return edge === 'end'
    ? resizeEnd(clip, delta, sourceDurationMs)
    : resizeStart(clip, delta, minStartMs);
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
function resizeStart(clip: Clip, delta: number, minStartMs: number): Clip {
  // How far left the head can go: back to the start of the source — or, for a photo, as far
  // as the overall cap allows — and never past the clip in front of it on the track.
  const headroom =
    clip.kind === 'video' ? clip.trimStartMs : MAX_PHOTO_DURATION_MS - clip.durationMs;
  const room = Math.min(headroom, Math.max(0, clip.startMs - minStartMs));
  const shift = clamp(delta, -room, clip.durationMs - MIN_CLIP_DURATION_MS);
  if (shift === 0) return clip;

  // `trimStartMs + durationMs` is unchanged, so the out-point cannot escape the source.
  return withKeyframesInside(
    {
      ...clip,
      startMs: clip.startMs + shift,
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

// ---------------------------------------------------------------- snapping

/**
 * The times a dragged clip's edges like to line up with: 0:00, the playhead, and every
 * edge already on the timeline — the visual track's clips and the sounds on their lanes.
 * The clip being dragged is left out, or it would snap to where it started.
 */
export function snapTargets(
  clips: Clip[],
  tracks: AudioTrack[],
  excludeId: string,
  playheadMs: number,
): number[] {
  const targets = [0, Math.max(0, Math.round(playheadMs))];
  for (const clip of clips) {
    if (clip.id === excludeId) continue;
    targets.push(clip.startMs, clip.startMs + clip.durationMs);
  }
  for (const track of tracks) {
    if (track.id === excludeId) continue;
    targets.push(track.startMs, track.startMs + track.durationMs);
  }
  return targets;
}

/**
 * The snapping aid: pull `startMs` onto a nearby target if either edge of the dragged
 * block is within `toleranceMs` of one, otherwise leave the drag exactly where it is.
 * Placement is free — this only nudges the last few pixels, and only when it is switched on.
 */
export function snapStartMs(
  startMs: number,
  durationMs: number,
  targets: number[],
  toleranceMs: number,
): number {
  if (!(toleranceMs > 0)) return startMs;

  let best = startMs;
  let bestDistance = toleranceMs;
  for (const target of targets) {
    // Either edge may be the one that lines up: the head on the target, or the tail on it.
    for (const candidate of [target, target - durationMs]) {
      if (candidate < 0) continue;
      const distance = Math.abs(candidate - startMs);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
  }
  return best;
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
  return Math.max(trackEndMs(clips), audioEndMs(tracks));
}

/**
 * Put a generated clip where the KF1→KF2 segment was.
 *
 * The photo is split into what came before the segment, the generated video, and what came
 * after — so a segment covering the whole photo replaces it outright, and a segment in the
 * middle leaves the untouched parts alone with their own keyframes. The three parts fill
 * exactly the span the photo held, so nothing else on the track moves.
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
      startMs: clip.startMs,
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
    startMs: clip.startMs + segment.startMs,
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
      startMs: clip.startMs + segment.endMs,
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

// ---------------------------------------------------------------- cuts & transitions

/**
 * A photo→photo cut: two photos next to each other — the place a transition can fill.
 * Their edges may touch, or the user may have dragged one away to leave a gap; either way
 * the pair can be bridged, and a render into a gap consumes it.
 */
export interface Cut {
  /** The photo on the left; the transition lands right after it. */
  afterClipId: string;
  /** The photo on the right. */
  beforeClipId: string;
  /** Where the ✦ chip sits: the shared edge, or the middle of the gap between the pair. */
  timeMs: number;
  /** How much empty track separates the pair. Zero when their edges touch. */
  gapMs: number;
}

/**
 * Every cut between two photos: consecutive in time order, touching or with a gap between
 * them — a gap a user drags open between two photos is exactly where a transition goes, so
 * it keeps the pair's chip rather than losing it. Only photos: a generated transition
 * needs a still on each side, so boundaries touching video (including a landed transition,
 * which breaks its own pair into photo|video and video|photo) simply are not offered.
 */
export function photoCuts(clips: Clip[]): Cut[] {
  const placed = layout(clips);
  const cuts: Cut[] = [];
  for (let i = 0; i < placed.length - 1; i += 1) {
    const a = placed[i];
    const b = placed[i + 1];
    if (a.clip.kind === 'photo' && b.clip.kind === 'photo') {
      const gapMs = b.startMs - a.endMs;
      cuts.push({
        afterClipId: a.clip.id,
        beforeClipId: b.clip.id,
        timeMs: a.endMs + Math.round(gapMs / 2),
        gapMs,
      });
    }
  }
  return cuts;
}

/** What lands on the timeline when a transition render finishes. */
export interface GeneratedTransition {
  assetId: string;
  name: string;
  prompt: string;
  durationMs: number;
  from: TransitionSource;
  to: TransitionSource;
}

function transitionClip(id: string, startMs: number, generated: GeneratedTransition): Clip {
  return {
    id,
    assetId: generated.assetId,
    kind: 'video',
    name: generated.name,
    startMs,
    durationMs: Math.max(MIN_CLIP_DURATION_MS, Math.round(generated.durationMs)),
    trimStartMs: 0,
    keyframes: [],
    prompts: {},
    ai: { prompt: generated.prompt, sourceAssetId: generated.from.assetId },
    transition: { prompt: generated.prompt, from: generated.from, to: generated.to },
  };
}

/**
 * Put a finished transition into its cut. The pair must still form a cut — the timeline
 * may have been edited while Higgsfield rendered — otherwise this is an identity no-op and
 * the caller explains rather than inserting the clip somewhere wrong.
 *
 * The clip lands right after the left photo and the right photo comes to rest flush
 * against its tail — a transition is continuous film from one still to the other, so a
 * gap the user dragged open for it is consumed rather than left as black. Everything from
 * the right photo onwards shifts by the difference between the render's length and the
 * gap's (right for a touching pair, either way across a gap), so gaps further along keep
 * their shape.
 */
export function insertTransitionClip(
  clips: Clip[],
  afterClipId: string,
  beforeClipId: string,
  generated: GeneratedTransition,
): Clip[] {
  const cut = photoCuts(clips).find(
    (c) => c.afterClipId === afterClipId && c.beforeClipId === beforeClipId,
  );
  const after = clips.find((c) => c.id === afterClipId);
  if (!cut || !after) return clips;

  const startMs = after.startMs + after.durationMs;
  const clip = transitionClip(makeId('clip'), startMs, generated);
  const delta = clip.durationMs - cut.gapMs;
  const rightStartMs = startMs + cut.gapMs;
  return sortClips([
    ...clips.map((c) => (c.startMs >= rightStartMs ? { ...c, startMs: c.startMs + delta } : c)),
    clip,
  ]);
}

/**
 * A regeneration swaps the finished render over the existing transition clip, keeping its
 * id (so the selection stays on it) and its start; a change of length ripples everything
 * after its old end by the difference, so what follows keeps its spacing. Identity no-op
 * when the clip is gone or is not a transition.
 */
export function replaceTransitionClip(
  clips: Clip[],
  transitionClipId: string,
  generated: GeneratedTransition,
): Clip[] {
  const old = clips.find((c) => c.id === transitionClipId);
  if (!old?.transition) return clips;
  const next = transitionClip(old.id, old.startMs, generated);
  const delta = next.durationMs - old.durationMs;
  const oldEnd = old.startMs + old.durationMs;
  return sortClips(
    clips.map((c) => {
      if (c.id === old.id) return next;
      return delta !== 0 && c.startMs >= oldEnd ? { ...c, startMs: c.startMs + delta } : c;
    }),
  );
}

/**
 * Correct a transition's provisional length once the real file has been probed, rippling
 * everything after its old end by the difference so the reel stays exactly as arranged.
 */
export function setTransitionDuration(clips: Clip[], clipId: string, durationMs: number): Clip[] {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip?.transition) return clips;
  const next = Math.max(MIN_CLIP_DURATION_MS, Math.round(durationMs));
  const delta = next - clip.durationMs;
  if (delta === 0) return clips;
  const oldEnd = clip.startMs + clip.durationMs;
  return sortClips(
    clips.map((c) => {
      if (c.id === clipId) return { ...c, durationMs: next };
      return c.startMs >= oldEnd ? { ...c, startMs: c.startMs + delta } : c;
    }),
  );
}

export type TransitionStaleness = 'fresh' | 'stale' | 'orphaned';

/** Below this, a framing difference is slider noise, not a reason to flag a re-render. */
const STALENESS_EPSILON = 0.001;

function framingDrifted(a: Transform2D, b: Transform2D): boolean {
  return (
    Math.abs(a.scale - b.scale) > STALENESS_EPSILON ||
    Math.abs(a.x - b.x) > STALENESS_EPSILON ||
    Math.abs(a.y - b.y) > STALENESS_EPSILON ||
    Math.abs(a.rotation - b.rotation) > STALENESS_EPSILON ||
    Math.abs(a.opacity - b.opacity) > STALENESS_EPSILON
  );
}

/**
 * Whether a finished transition still matches what stands around it. `stale` means both
 * neighbours are photos but not the ones (or not the framings) it was rendered from, so a
 * one-tap regenerate can fix it; `orphaned` means a neighbour is missing or not a photo,
 * so there is nothing to regenerate between. Never acts — the user decides what to spend.
 */
export function transitionStaleness(clips: Clip[], transitionClipId: string): TransitionStaleness {
  const placed = layout(clips);
  const at = placed.findIndex((p) => p.clip.id === transitionClipId);
  const clip = at === -1 ? undefined : placed[at].clip;
  if (!clip?.transition) return 'orphaned';

  const left = placed[at - 1]?.clip;
  const right = placed[at + 1]?.clip;
  if (!left || !right || left.kind !== 'photo' || right.kind !== 'photo') return 'orphaned';

  const { from, to } = clip.transition;
  if (left.id !== from.clipId || left.assetId !== from.assetId) return 'stale';
  if (right.id !== to.clipId || right.assetId !== to.assetId) return 'stale';
  if (framingDrifted(transformAt(left, left.durationMs), from.transform)) return 'stale';
  if (framingDrifted(transformAt(right, 0), to.transform)) return 'stale';
  return 'fresh';
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
