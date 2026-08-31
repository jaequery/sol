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
  MAX_PHOTO_DURATION_MS,
  MIN_CLIP_DURATION_MS,
  type AudioTrack,
  type Clip,
  type ClipEdge,
  type PlacedClip,
  type Selection,
  type TransitionMode,
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

/**
 * Whether `splitAtPlayhead` would actually cut something.
 *
 * A split needs the playhead *strictly inside* a clip: on a boundary, in a gap, before the
 * first clip or past the last one there is no cut to make. The ✂ button reads this so it
 * cannot offer an edit the store will silently refuse — and the store reads it too, so the
 * button's promise and the action's rule are one statement rather than two that drift.
 */
export function canSplitAt(clips: Clip[], timeMs: number): boolean {
  const hit = clipAt(clips, timeMs);
  return hit !== null && hit.localMs > 0 && hit.localMs < hit.placed.clip.durationMs;
}

/**
 * Whether `deleteSelection` has anything to delete.
 *
 * A cut is a place, not a thing — there is nothing there to remove — so the 🗑 button and
 * the Delete key both stay dark on one, rather than lighting up for an edit that does
 * nothing.
 */
export function canDeleteSelection(selection: Selection): boolean {
  return selection.kind === 'clip' || selection.kind === 'audio';
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
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
  return { ...clip, durationMs };
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
  return {
    ...clip,
    startMs: clip.startMs + shift,
    durationMs: clip.durationMs - shift,
    trimStartMs: clip.kind === 'video' ? clip.trimStartMs + shift : clip.trimStartMs,
  };
}

/** The longest this clip could be played from its current in-point. */
function maxDurationOf(clip: Clip, sourceDurationMs?: number): number {
  if (clip.kind !== 'video') return MAX_PHOTO_DURATION_MS;
  // Unprobed: the only frames known to exist are the ones the clip already plays.
  const available =
    sourceDurationMs === undefined ? clip.durationMs : sourceDurationMs - clip.trimStartMs;
  return Math.max(available, MIN_CLIP_DURATION_MS);
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

// ---------------------------------------------------------------- cuts & transitions

/**
 * A cut: two clips next to each other — the place a transition can fill. Their edges may
 * touch, or the user may have dragged one away to leave a gap; either way the pair can be
 * bridged, and a render into a gap consumes it.
 */
export interface Cut {
  /** The clip on the left; the transition lands right after it. */
  afterClipId: string;
  /** The clip on the right. */
  beforeClipId: string;
  /** Where the ✦ chip sits: the shared edge, or the middle of the gap between the pair. */
  timeMs: number;
  /** How much empty track separates the pair. Zero when their edges touch. */
  gapMs: number;
}

/**
 * Whether a clip is something a transition can be rendered *from*. Anything on the track
 * qualifies — a photo is already a still, a video hands over the frame at its edge — except
 * a transition that has already landed: bridging one would be animating an animation, and
 * every landing would sprout two fresh chips on either side of itself.
 */
function bridgeable(clip: Clip): boolean {
  return clip.transition === undefined;
}

/**
 * Every cut a transition could fill: two clips consecutive in time order, touching or with
 * a gap between them — a gap a user drags open between a pair is exactly where a transition
 * goes, so it keeps the pair's chip rather than losing it.
 *
 * Kind-blind by design. Higgsfield animates between two stills; a photo is one already and
 * a video's frame at the cut is pulled off it (`backend.captureVideoFrame`), so photo→photo,
 * video→video and the mixed pairs are all the same job. What is *not* offered is a boundary
 * touching a landed transition — see `bridgeable`.
 */
export function bridgeableCuts(clips: Clip[]): Cut[] {
  const placed = layout(clips);
  const cuts: Cut[] = [];
  for (let i = 0; i < placed.length - 1; i += 1) {
    const a = placed[i];
    const b = placed[i + 1];
    if (bridgeable(a.clip) && bridgeable(b.clip)) {
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

/**
 * Whether this pair has a still to give up — the whole rule behind the replace option.
 *
 * `replace` means the stills leave and the motion stands in their place. Two videos have no
 * still between them: there is nothing to consume, so the option is not offered at all
 * rather than offered and quietly doing nothing. A photo on either side does have one, so
 * the option stands and applies to that side.
 */
export function cutOffersReplace(a: Clip, b: Clip): boolean {
  return a.kind === 'photo' || b.kind === 'photo';
}

/**
 * One frame at 30 fps — the step between the point a clip runs *to* and the last frame it
 * actually shows. A seek to the out point itself lands on the first frame the clip no
 * longer plays, which is one frame of the wrong footage.
 */
export const FRAME_STEP_MS = 33;

/**
 * Where in its source a clip's anchor frame sits: the last frame it shows on its outgoing
 * edge, the first on its incoming one.
 *
 * `undefined` for a photo — it has exactly one frame, and the image itself is what is sent.
 * That absence is the same absence every record written before transitions could involve
 * video carries, which is why nothing has to be migrated.
 */
export function anchorMs(clip: Clip, edge: 'out' | 'in'): number | undefined {
  if (clip.kind !== 'video') return undefined;
  if (edge === 'in') return clip.trimStartMs;
  return Math.max(clip.trimStartMs, clip.trimStartMs + clip.durationMs - FRAME_STEP_MS);
}

/** What a finished transition records about one of its two sides. */
export function transitionSource(clip: Clip, edge: 'out' | 'in'): TransitionSource {
  const atMs = anchorMs(clip, edge);
  const source: TransitionSource = { clipId: clip.id, assetId: clip.assetId };
  if (atMs !== undefined) source.atMs = atMs;
  return source;
}

/**
 * The clips a `replace` landing on this pair takes off the track: its stills, and only
 * those. A video keeps its span and its trim — it is footage the user shot, not a held
 * frame the motion is standing in for.
 */
export function consumedByReplace(a: Clip, b: Clip): string[] {
  return [a, b].filter((c) => c.kind === 'photo').map((c) => c.id);
}

/** What lands on the timeline when a transition render finishes. */
export interface GeneratedTransition {
  assetId: string;
  name: string;
  prompt: string;
  durationMs: number;
  from: TransitionSource;
  to: TransitionSource;
  /** How the clip lands and later regenerates. Absent means `insert`, as ever. */
  mode?: TransitionMode;
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
    ai: { prompt: generated.prompt, sourceAssetId: generated.from.assetId },
    transition: {
      prompt: generated.prompt,
      from: generated.from,
      to: generated.to,
      mode: generated.mode,
    },
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
  const cut = bridgeableCuts(clips).find(
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
 * Put a finished replace-mode transition in the place of the pair's **stills**. The pair
 * must still form a cut — same guard, and same identity no-op, as `insertTransitionClip` —
 * so an edit made while Higgsfield rendered can never have the clips yanked out from under
 * it.
 *
 * One rule covers every pair: the stills leave, the footage stays. The render therefore
 * stands from wherever the left side stops being footage — a photo's start, a video's end —
 * to wherever the right side starts being it, consuming the gap between them either way.
 * Two photos both go and the clip holds their whole span, exactly as before. A photo beside
 * a video gives up only the photo, because the video is footage the user shot rather than a
 * held frame the motion can stand in for. Two videos have no still to give up, so this
 * reduces to `insertTransitionClip` — and `cutOffersReplace` sees to it that the mode is
 * never offered there in the first place.
 *
 * Everything from the consumed span's end shifts by the difference between the render's
 * length and that span, so gaps further along keep their shape.
 */
export function replacePairWithTransition(
  clips: Clip[],
  afterClipId: string,
  beforeClipId: string,
  generated: GeneratedTransition,
): Clip[] {
  const cut = bridgeableCuts(clips).find(
    (c) => c.afterClipId === afterClipId && c.beforeClipId === beforeClipId,
  );
  const after = clips.find((c) => c.id === afterClipId);
  const before = clips.find((c) => c.id === beforeClipId);
  if (!cut || !after || !before) return clips;

  const spanStart = after.kind === 'photo' ? after.startMs : after.startMs + after.durationMs;
  const spanEnd = before.kind === 'photo' ? before.startMs + before.durationMs : before.startMs;
  const doomed = new Set(consumedByReplace(after, before));

  const clip = transitionClip(makeId('clip'), spanStart, generated);
  const delta = clip.durationMs - (spanEnd - spanStart);
  return sortClips([
    ...clips
      .filter((c) => !doomed.has(c.id))
      .map((c) => (c.startMs >= spanEnd ? { ...c, startMs: c.startMs + delta } : c)),
    clip,
  ]);
}

/**
 * Remove the named clips and close the spans they held: everything starting at or after a
 * removed clip's end walks left by that clip's duration, shifts accumulating across
 * removals in time order, so each removed span closes behind it while gaps the user left
 * elsewhere keep their shape. Unknown ids are no-ops. This is how an "Animate all" run
 * ends — the photos its landings stand for leave the track and the chain closes up into
 * pure motion.
 */
export function removeClipsClosingSpans(clips: Clip[], ids: string[]): Clip[] {
  const doomed = new Set(ids);
  const removed = sortClips(clips.filter((c) => doomed.has(c.id)));
  if (removed.length === 0) return clips;
  // Clips never overlap, so a survivor is either wholly before a removed clip (untouched)
  // or starts at/after its end (walked left by its length).
  const shiftAt = (startMs: number) =>
    removed.reduce(
      (sum, r) => (startMs >= r.startMs + r.durationMs ? sum + r.durationMs : sum),
      0,
    );
  return sortClips(
    clips
      .filter((c) => !doomed.has(c.id))
      .map((c) => {
        const shift = shiftAt(c.startMs);
        return shift === 0 ? c : { ...c, startMs: c.startMs - shift };
      }),
  );
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

/**
 * Whether a finished transition still matches what stands around it. `stale` means it no
 * longer spans what it was rendered from, so a one-tap regenerate can fix it; `orphaned`
 * means there is nothing left to regenerate between at all. Never acts — the user decides
 * what to spend.
 *
 * An insert-mode transition is judged by its neighbours, which is what makes stale →
 * Regenerate correct after a reorder. A replace-mode one consumed the pair's *stills*, so
 * those say nothing and it is `fresh` for as long as their assets stand in the bin
 * (`assets`), `orphaned` once one is gone or missing. What it does still watch is a side it
 * did **not** consume: a video keeps its place on the track, and trimming it moves the very
 * frame the motion was rendered from.
 */
export function transitionStaleness(
  clips: Clip[],
  transitionClipId: string,
  assets?: Record<string, { missing?: boolean }>,
): TransitionStaleness {
  const placed = layout(clips);
  const at = placed.findIndex((p) => p.clip.id === transitionClipId);
  const clip = at === -1 ? undefined : placed[at].clip;
  if (!clip?.transition) return 'orphaned';
  const { from, to } = clip.transition;

  if (clip.transition.mode === 'replace') {
    const gone = (assetId: string) =>
      assets !== undefined && (!assets[assetId] || assets[assetId].missing);
    if (gone(from.assetId) || gone(to.assetId)) return 'orphaned';
    return anchorMoved(clips, from, 'out') || anchorMoved(clips, to, 'in') ? 'stale' : 'fresh';
  }

  const left = placed[at - 1]?.clip;
  const right = placed[at + 1]?.clip;
  if (!left || !right) return 'orphaned';

  if (left.id !== from.clipId || left.assetId !== from.assetId) return 'stale';
  if (right.id !== to.clipId || right.assetId !== to.assetId) return 'stale';
  if (anchorMs(left, 'out') !== from.atMs || anchorMs(right, 'in') !== to.atMs) return 'stale';
  return 'fresh';
}

/**
 * Whether the clip a source names is still on the track *and* no longer offers the frame
 * that was rendered from it. A source whose clip is gone — every photo a replace landing
 * consumed — has moved nowhere; it is judged by its asset instead.
 */
function anchorMoved(clips: Clip[], source: TransitionSource, edge: 'out' | 'in'): boolean {
  const live = clips.find((c) => c.id === source.clipId);
  return live !== undefined && anchorMs(live, edge) !== source.atMs;
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
