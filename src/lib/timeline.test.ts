import { beforeEach, describe, expect, it } from 'vitest';
import {
  addKeyframe,
  audioEndMs,
  audioTrack,
  clipAt,
  cssTransform,
  endOfPrevious,
  findSegment,
  formatDuration,
  formatTimecode,
  insertClips,
  insertIndexAt,
  insertIndexAtTime,
  layout,
  moveAudio,
  moveKeyframe,
  packClips,
  photoClip,
  placeClip,
  insertTransitionClip,
  photoCuts,
  removeKeyframe,
  replaceSegment,
  replaceTransitionClip,
  resetIds,
  resizeAudio,
  resizeClip,
  resizeClipInList,
  segmentsOf,
  setPrompt,
  snapStartMs,
  snapTargets,
  startOfIndex,
  setTransitionDuration,
  timelineEndMs,
  trackEndMs,
  transformAt,
  transitionStaleness,
  truncateName,
  updateKeyframe,
  videoClip,
  type GeneratedTransition,
} from './timeline';
import {
  IDENTITY_TRANSFORM,
  MAX_PHOTO_DURATION_MS,
  MAX_SCALE,
  MIN_CLIP_DURATION_MS,
  type Clip,
} from '../types/project';

beforeEach(resetIds);

function photo(durationMs = 6000, startMs = 0): Clip {
  return photoClip({ id: 'asset_photo', name: 'sunset.jpg' }, durationMs, startMs);
}

function video(name: string, durationMs: number, startMs = 0): Clip {
  return videoClip({ id: `asset_${name}`, name }, durationMs, startMs);
}

describe('layout', () => {
  it('lays a fresh import end to end', () => {
    const clips = packClips([photo(6000), video('surf.mp4', 9000)]);
    expect(layout(clips).map((p) => [p.startMs, p.endMs])).toEqual([
      [0, 6000],
      [6000, 15000],
    ]);
    expect(trackEndMs(clips)).toBe(15000);
  });

  it('places each clip at the time it carries, gaps and all, in time order', () => {
    const clips = [video('surf.mp4', 9000, 8000), photo(6000, 1000)];
    expect(layout(clips).map((p) => [p.clip.name, p.startMs, p.endMs])).toEqual([
      ['sunset.jpg', 1000, 7000],
      ['surf.mp4', 8000, 17000],
    ]);
    expect(trackEndMs(clips)).toBe(17000);
  });

  it('finds the clip under the playhead and the time within it', () => {
    const clips = packClips([photo(6000), video('surf.mp4', 9000)]);
    expect(clipAt(clips, 0)?.placed.clip.name).toBe('sunset.jpg');
    expect(clipAt(clips, 7000)?.placed.clip.name).toBe('surf.mp4');
    expect(clipAt(clips, 7000)?.localMs).toBe(1000);
  });

  it('reads a gap as nothing at all — which the preview and the export draw black', () => {
    const clips = [photo(2000, 1000), video('surf.mp4', 2000, 6000)];
    expect(clipAt(clips, 500)).toBeNull();
    expect(clipAt(clips, 4000)).toBeNull();
    expect(clipAt(clips, 1500)?.placed.clip.name).toBe('sunset.jpg');
    expect(clipAt(clips, 6500)?.placed.clip.name).toBe('surf.mp4');
  });

  it('holds on the last frame at the very end instead of going blank', () => {
    const clips = [photo(6000)];
    expect(clipAt(clips, 6000)?.localMs).toBe(6000);
    expect(clipAt([], 0)).toBeNull();
  });
});

describe('keyframes', () => {
  it('adds keyframes in time order however they are placed', () => {
    let clip = photo();
    clip = addKeyframe(clip, 4000);
    clip = addKeyframe(clip, 1000);
    expect(clip.keyframes.map((k) => k.timeMs)).toEqual([1000, 4000]);
  });

  it('clamps a keyframe to the clip and re-keys rather than stacking', () => {
    let clip = photo(6000);
    clip = addKeyframe(clip, -500);
    clip = addKeyframe(clip, 99_000);
    expect(clip.keyframes.map((k) => k.timeMs)).toEqual([0, 6000]);

    clip = addKeyframe(clip, 0, { ...IDENTITY_TRANSFORM, scale: 2 });
    expect(clip.keyframes).toHaveLength(2);
    expect(clip.keyframes[0].transform.scale).toBe(2);
  });

  it('inherits the interpolated framing at the moment it is added', () => {
    let clip = photo(4000);
    clip = addKeyframe(clip, 0, { ...IDENTITY_TRANSFORM, scale: 1 });
    clip = addKeyframe(clip, 4000, { ...IDENTITY_TRANSFORM, scale: 3 });
    clip = addKeyframe(clip, 2000);
    expect(clip.keyframes[1].transform.scale).toBeCloseTo(2, 5);
  });

  it('clamps transforms to what the export can actually render', () => {
    let clip = addKeyframe(photo(), 0);
    clip = updateKeyframe(clip, clip.keyframes[0].id, { scale: 99, opacity: 5 });
    expect(clip.keyframes[0].transform.scale).toBe(MAX_SCALE);
    expect(clip.keyframes[0].transform.opacity).toBe(1);

    clip = updateKeyframe(clip, clip.keyframes[0].id, { scale: 0.1 });
    expect(clip.keyframes[0].transform.scale).toBe(1);
  });

  it('keeps the list sorted when a keyframe is dragged past another', () => {
    let clip = addKeyframe(addKeyframe(photo(), 1000), 4000);
    const first = clip.keyframes[0].id;
    clip = moveKeyframe(clip, first, 5000);
    expect(clip.keyframes.map((k) => k.timeMs)).toEqual([4000, 5000]);
  });

  it('drops the prompt that belonged to a deleted keyframe', () => {
    let clip = addKeyframe(addKeyframe(photo(), 0), 3000);
    const [a, b] = clip.keyframes;
    clip = setPrompt(clip, a.id, 'dolly in');
    clip = removeKeyframe(clip, a.id);
    expect(clip.prompts).toEqual({});
    expect(clip.keyframes.map((k) => k.id)).toEqual([b.id]);
  });
});

describe('segments', () => {
  it('exposes one segment per gap between keyframes', () => {
    let clip = photo(9000);
    clip = addKeyframe(clip, 1000);
    clip = addKeyframe(clip, 4200);
    clip = addKeyframe(clip, 7000);

    const segments = segmentsOf(clip);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ startMs: 1000, endMs: 4200, durationMs: 3200 });
    expect(findSegment(clip, segments[0].fromKeyframeId, segments[0].toKeyframeId)).not.toBeNull();
  });

  it('has no segments until there are two keyframes', () => {
    expect(segmentsOf(photo())).toEqual([]);
    expect(segmentsOf(addKeyframe(photo(), 0))).toEqual([]);
  });
});

describe('transformAt', () => {
  it('is the identity when there are no keyframes', () => {
    expect(transformAt(photo(), 1234)).toEqual(IDENTITY_TRANSFORM);
  });

  it('interpolates linearly between two keyframes', () => {
    let clip = photo(4000);
    clip = addKeyframe(clip, 0, { ...IDENTITY_TRANSFORM, scale: 1, x: 0 });
    clip = addKeyframe(clip, 4000, { ...IDENTITY_TRANSFORM, scale: 2, x: 10 });

    expect(transformAt(clip, 0).scale).toBeCloseTo(1, 5);
    expect(transformAt(clip, 2000).scale).toBeCloseTo(1.5, 5);
    expect(transformAt(clip, 2000).x).toBeCloseTo(5, 5);
    expect(transformAt(clip, 4000).scale).toBeCloseTo(2, 5);
  });

  it('holds the end values outside the keyframed range', () => {
    let clip = photo(8000);
    clip = addKeyframe(clip, 2000, { ...IDENTITY_TRANSFORM, scale: 1.5 });
    clip = addKeyframe(clip, 4000, { ...IDENTITY_TRANSFORM, scale: 2 });

    expect(transformAt(clip, 0).scale).toBeCloseTo(1.5, 5);
    expect(transformAt(clip, 8000).scale).toBeCloseTo(2, 5);
  });

  it('renders as a css transform the preview can apply', () => {
    expect(cssTransform({ scale: 1.5, x: -3, y: 2, rotation: 4, opacity: 1 })).toBe(
      'translate(-3%, 2%) scale(1.5) rotate(4deg)',
    );
  });
});

describe('insertion', () => {
  it('inserts dropped clips at a boundary and ripples what was there along', () => {
    const [a, c] = packClips([photo(1000), photo(3000)]);
    const inserted = insertClips([a, c], 1, [photo(2000)]);
    expect(inserted.map((x) => [x.durationMs, x.startMs])).toEqual([
      [1000, 0],
      [2000, 1000],
      [3000, 3000],
    ]);
  });

  it('lands at the end of the track, past any gap, when there is no boundary after it', () => {
    const clips = [photo(1000, 4000)];
    expect(insertClips(clips, 1, [photo(2000)]).map((x) => x.startMs)).toEqual([4000, 5000]);
  });

  it('leaves the clips in front of the insertion — and their gaps — where they are', () => {
    const clips = [photo(1000, 0), photo(1000, 5000)];
    expect(insertClips(clips, 1, [photo(2000)]).map((x) => x.startMs)).toEqual([0, 5000, 7000]);
  });

  it('picks the insertion point from where the drop landed', () => {
    const clips = packClips([photo(6000), video('v.mp4', 6000)]);
    expect(insertIndexAt(clips, 0)).toBe(0);
    expect(insertIndexAt(clips, 0.1)).toBe(0);
    expect(insertIndexAt(clips, 0.4)).toBe(1);
    expect(insertIndexAt(clips, 0.99)).toBe(2);
    expect(insertIndexAt([], 0.5)).toBe(0);
  });
});

describe('replaceSegment', () => {
  function clipWithThreeKeyframes(): Clip {
    let clip = photo(6000);
    clip = addKeyframe(clip, 1000);
    clip = addKeyframe(clip, 4200);
    clip = addKeyframe(clip, 6000);
    return clip;
  }

  const generated = { assetId: 'asset_ai', name: 'ai-segment-01.mp4', prompt: 'slow dolly-in' };

  it('splits the photo into before, the generated clip, and after', () => {
    const clip = clipWithThreeKeyframes();
    const [kf1, kf2] = clip.keyframes;
    const result = replaceSegment([clip], clip.id, kf1.id, kf2.id, generated);

    expect(result.map((c) => [c.kind, c.durationMs])).toEqual([
      ['photo', 1000],
      ['video', 3200],
      ['photo', 1800],
    ]);
    expect(trackEndMs(result)).toBe(trackEndMs([clip]));
  });

  it('marks the generated clip as AI and remembers its prompt and source', () => {
    const clip = clipWithThreeKeyframes();
    const [kf1, kf2] = clip.keyframes;
    const ai = replaceSegment([clip], clip.id, kf1.id, kf2.id, generated)[1];

    expect(ai.kind).toBe('video');
    expect(ai.assetId).toBe('asset_ai');
    expect(ai.ai).toEqual({ prompt: 'slow dolly-in', sourceAssetId: 'asset_photo' });
  });

  it('rebases the keyframes of the trailing photo to its own start', () => {
    const clip = clipWithThreeKeyframes();
    const [kf1, kf2] = clip.keyframes;
    const tail = replaceSegment([clip], clip.id, kf1.id, kf2.id, generated)[2];
    expect(tail.keyframes.map((k) => k.timeMs)).toEqual([0, 1800]);
  });

  it('replaces the clip outright when the segment covers all of it', () => {
    let clip = photo(4000);
    clip = addKeyframe(clip, 0);
    clip = addKeyframe(clip, 4000);
    const [kf1, kf2] = clip.keyframes;

    const result = replaceSegment([clip], clip.id, kf1.id, kf2.id, generated);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('video');
    expect(result[0].durationMs).toBe(4000);
  });

  it('leaves the other clips on the track untouched and in order', () => {
    const before = videoClip({ id: 'v1', name: 'intro.mp4' }, 2000);
    const clip = clipWithThreeKeyframes();
    const after = videoClip({ id: 'v2', name: 'outro.mp4' }, 2000);
    const [kf1, kf2] = clip.keyframes;

    const result = replaceSegment([before, clip, after], clip.id, kf1.id, kf2.id, generated);
    expect(result[0].id).toBe(before.id);
    expect(result[result.length - 1].id).toBe(after.id);
    expect(result).toHaveLength(5);
  });

  it('keeps the prompt with whichever half still owns that keyframe', () => {
    let clip = clipWithThreeKeyframes();
    const [kf1, kf2, kf3] = clip.keyframes;
    clip = setPrompt(clip, kf2.id, 'second segment prompt');

    const result = replaceSegment([clip], clip.id, kf1.id, kf2.id, generated);
    expect(result[2].prompts[kf2.id]).toBe('second segment prompt');
    expect(result[0].prompts[kf3.id]).toBeUndefined();
  });

  it('is a no-op for an unknown clip or a zero-length segment', () => {
    const clip = clipWithThreeKeyframes();
    const [kf1] = clip.keyframes;
    expect(replaceSegment([clip], 'nope', kf1.id, kf1.id, generated)).toHaveLength(1);
    expect(replaceSegment([clip], clip.id, kf1.id, kf1.id, generated)).toEqual([clip]);
  });
});

describe('formatting', () => {
  it('renders timecodes and durations the way the transport shows them', () => {
    expect(formatTimecode(0)).toBe('00:00.00');
    expect(formatTimecode(4100)).toBe('00:04.10');
    expect(formatTimecode(65_430)).toBe('01:05.43');
    expect(formatTimecode(-10)).toBe('00:00.00');
    expect(formatDuration(3200)).toBe('3.2s');
  });

  it('middle-truncates long names so the extension stays visible', () => {
    expect(truncateName('short.jpg')).toBe('short.jpg');
    const long = truncateName('a-really-long-holiday-photo-name.jpeg', 20);
    expect(long).toHaveLength(20);
    expect(long).toContain('…');
    expect(long.endsWith('jpeg')).toBe(true);
  });
});

describe('placing a clip', () => {
  const three = () =>
    packClips([
      photoClip({ id: 'a', name: 'a.jpg' }, 1000),
      photoClip({ id: 'b', name: 'b.jpg' }, 2000),
      photoClip({ id: 'c', name: 'c.jpg' }, 3000),
    ]);

  it('drops the clip exactly where it was let go, leaving a gap behind it', () => {
    const clips = three();
    const moved = placeClip(clips, clips[2].id, 20_000);
    expect(moved.map((x) => [x.name, x.startMs])).toEqual([
      ['a.jpg', 0],
      ['b.jpg', 1000],
      ['c.jpg', 20_000],
    ]);
    // Nothing else moved: the hole the clip left is a hole.
    expect(trackEndMs(moved)).toBe(23_000);
  });

  it('never starts before the timeline does', () => {
    const clips = three();
    expect(placeClip(clips, clips[2].id, -9000)[0]).toMatchObject({ name: 'c.jpg', startMs: 0 });
  });

  it('keeps a clip dropped near another exactly where it landed, not against its edge', () => {
    const clips = three();
    // 400 ms clear of the end of the track — close, but placement is free, so it stays there.
    const moved = placeClip(clips, clips[0].id, 6400);
    expect(moved.map((x) => [x.name, x.startMs])).toEqual([
      ['b.jpg', 1000],
      ['c.jpg', 3000],
      ['a.jpg', 6400],
    ]);
  });

  it('pushes the clip it lands on out of the way, since one track cannot stack two', () => {
    const clips = three();
    // c (3s) dropped over the top of a and b, which slide right just far enough to clear it.
    const moved = placeClip(clips, clips[2].id, 0);
    expect(moved.map((x) => [x.name, x.startMs])).toEqual([
      ['c.jpg', 0],
      ['a.jpg', 3000],
      ['b.jpg', 4000],
    ]);
  });

  it('slides only what it has to, and never closes a gap it did not make', () => {
    const clips = [
      photoClip({ id: 'a', name: 'a.jpg' }, 1000, 0),
      photoClip({ id: 'b', name: 'b.jpg' }, 1000, 5000),
      photoClip({ id: 'c', name: 'c.jpg' }, 1000, 20_000),
    ];
    const moved = placeClip(clips, clips[0].id, 5500);
    expect(moved.map((x) => [x.name, x.startMs])).toEqual([
      ['a.jpg', 5500],
      ['b.jpg', 6500],
      // Far enough away that the push never reached it.
      ['c.jpg', 20_000],
    ]);
  });

  it('is a no-op when the clip is put back where it came from', () => {
    const clips = three();
    expect(placeClip(clips, clips[1].id, 1000)).toBe(clips);
    expect(placeClip(clips, 'not-a-clip', 0)).toBe(clips);
  });

  it('agrees with the file-drop index, which is the same maths over a ratio', () => {
    const clips = three();
    expect(insertIndexAt(clips, 0.5)).toBe(insertIndexAtTime(clips, 3000));
    expect(startOfIndex(clips, 2)).toBe(3000);
    expect(startOfIndex(clips, 99)).toBe(6000);
  });
});

describe('snapping', () => {
  const clips = packClips([photo(6000), video('surf.mp4', 4000)]);
  const song = audioTrack({ id: 'asset_song', name: 'theme.mp3' }, 12_000, 3000);

  it('offers every edge on the timeline, 0:00 and the playhead — but not the dragged clip', () => {
    const targets = snapTargets(clips, [song], clips[0].id, 2500);
    expect(targets).toContain(0);
    expect(targets).toContain(2500);
    expect(targets).toEqual(expect.arrayContaining([6000, 10_000, 12_000, 15_000]));
    // The clip being dragged is not a target, or it would snap back to where it started.
    expect(targets.filter((t) => t === 0)).toHaveLength(1);
  });

  it('pulls either edge of the dragged clip onto a nearby target', () => {
    const targets = snapTargets(clips, [], clips[1].id, 0);
    // Head 40 ms past the photo's end: near enough, so it lands flush against it.
    expect(snapStartMs(6040, 4000, targets, 100)).toBe(6000);
    // Tail 30 ms short of it: the *end* is what lines up, so the start comes back by 4000.
    expect(snapStartMs(1970, 4000, targets, 100)).toBe(2000);
  });

  it('leaves a drop that is not near anything exactly where it is', () => {
    const targets = snapTargets(clips, [], clips[1].id, 0);
    expect(snapStartMs(9000, 4000, targets, 100)).toBe(9000);
    // And with the aid switched off, nothing is ever near anything.
    expect(snapStartMs(6040, 4000, targets, 0)).toBe(6040);
  });

  it('never snaps a clip to before the timeline starts', () => {
    expect(snapStartMs(20, 4000, [0], 100)).toBe(0);
    // Lining this clip's *tail* up with 900 would put its head at -100, so it is not offered
    // and the drop stays where it is.
    expect(snapStartMs(50, 1000, [900], 200)).toBe(50);
  });
});

describe('resizing a clip', () => {
  it('changes a photo\u2019s duration from the tail', () => {
    const clip = resizeClip(photo(6000), 'end', 2500);
    expect(clip.durationMs).toBe(8500);
    expect(resizeClip(clip, 'end', -3000).durationMs).toBe(5500);
  });

  it('trims a photo from the head, which shortens it and leaves its tail where it was', () => {
    const before = photo(6000);
    const after = resizeClip(before, 'start', 1500);
    expect([after.startMs, after.durationMs]).toEqual([1500, 4500]);
    // Photos have no in-point to move.
    expect(after.trimStartMs).toBe(0);
  });

  it('keeps a photo\u2019s keyframes inside it, pinning the ones that fall outside', () => {
    let clip = photo(6000);
    clip = addKeyframe(clip, 0, { ...IDENTITY_TRANSFORM, scale: 1 });
    clip = addKeyframe(clip, 6000, { ...IDENTITY_TRANSFORM, scale: 3 });
    clip = setPrompt(clip, clip.keyframes[0].id, 'dolly in');

    const shorter = resizeClip(clip, 'end', -3000);
    expect(shorter.durationMs).toBe(3000);
    expect(shorter.keyframes.map((k) => k.timeMs)).toEqual([0, 3000]);
    // The framing the user set for the end is still the framing at the new end.
    expect(shorter.keyframes[1].transform.scale).toBe(3);
    expect(shorter.prompts[shorter.keyframes[0].id]).toBe('dolly in');
  });

  it('slides a photo\u2019s keyframes with the content when the head moves', () => {
    // Sitting at 4 s, so there is room in front of it to pull the head back into.
    let clip = photo(6000, 4000);
    clip = addKeyframe(clip, 1000);
    clip = addKeyframe(clip, 5000);

    const trimmed = resizeClip(clip, 'start', 2000);
    expect([trimmed.startMs, trimmed.durationMs]).toEqual([6000, 4000]);
    // 1000 fell off the front and pinned to 0; 5000 travelled to 3000.
    expect(trimmed.keyframes.map((k) => k.timeMs)).toEqual([0, 3000]);

    const grown = resizeClip(clip, 'start', -1000);
    expect([grown.startMs, grown.durationMs]).toEqual([3000, 7000]);
    expect(grown.keyframes.map((k) => k.timeMs)).toEqual([2000, 6000]);
  });

  it('cannot pull a head back past 0:00, or past the clip in front of it', () => {
    // Against the start of the timeline there is nothing in front to reveal.
    const first = photo(6000);
    expect(resizeClip(first, 'start', -2000)).toBe(first);

    // And with a clip ending at 3000 in front of it, the head stops there.
    const clip = photo(6000, 4000);
    const stopped = resizeClip(clip, 'start', -5000, undefined, 3000);
    expect([stopped.startMs, stopped.durationMs]).toEqual([3000, 7000]);
  });

  it('collapses keyframes that come to rest on the same instant, keeping the last', () => {
    let clip = photo(6000);
    clip = addKeyframe(clip, 4000, { ...IDENTITY_TRANSFORM, scale: 2 });
    clip = addKeyframe(clip, 5000, { ...IDENTITY_TRANSFORM, scale: 3 });
    clip = setPrompt(clip, clip.keyframes[0].id, 'gone with it');

    const shorter = resizeClip(clip, 'end', -3000);
    expect(shorter.durationMs).toBe(3000);
    expect(shorter.keyframes).toHaveLength(1);
    expect(shorter.keyframes[0].transform.scale).toBe(3);
    // The prompt hung off a keyframe that no longer exists, so it went too.
    expect(shorter.prompts).toEqual({});
  });

  it('will not pull a video past the end of its source', () => {
    const clip = videoClip({ id: 'v', name: 'surf.mp4' }, 4000);
    expect(resizeClip(clip, 'end', 10_000, 9000).durationMs).toBe(9000);
    // Already at the source's length: there is nothing more to show.
    const full = resizeClip(clip, 'end', 10_000, 9000);
    expect(resizeClip(full, 'end', 1000, 9000)).toBe(full);
  });

  it('lets an unprobed video shrink but not grow, because nothing proves the frames exist', () => {
    const clip = videoClip({ id: 'v', name: 'surf.mp4' }, 4000);
    expect(resizeClip(clip, 'end', 3000)).toBe(clip);
    expect(resizeClip(clip, 'end', -1500).durationMs).toBe(2500);
  });

  it('walks a video\u2019s in-point when its head is trimmed, and back again', () => {
    const clip = videoClip({ id: 'v', name: 'surf.mp4' }, 9000);
    const trimmed = resizeClip(clip, 'start', 2000, 9000);
    expect([trimmed.trimStartMs, trimmed.durationMs]).toEqual([2000, 7000]);
    // The out-point never moved, so it is still inside the source.
    expect(trimmed.trimStartMs + trimmed.durationMs).toBe(9000);

    const back = resizeClip(trimmed, 'start', -5000, 9000);
    expect([back.trimStartMs, back.durationMs]).toEqual([0, 9000]);
    // And it cannot be pulled back past the first frame.
    expect(resizeClip(back, 'start', -1000, 9000)).toBe(back);
  });

  it('holds both edges apart by the minimum, and caps a photo', () => {
    const clip = photo(6000);
    expect(resizeClip(clip, 'end', -99_000).durationMs).toBe(MIN_CLIP_DURATION_MS);
    expect(resizeClip(clip, 'start', 99_000).durationMs).toBe(MIN_CLIP_DURATION_MS);
    expect(resizeClip(clip, 'end', MAX_PHOTO_DURATION_MS * 2).durationMs).toBe(
      MAX_PHOTO_DURATION_MS,
    );
    // Pulled back from an hour in, the cap is still what stops it.
    const late = photo(6000, 60 * 60 * 1000);
    expect(resizeClip(late, 'start', -MAX_PHOTO_DURATION_MS * 2).durationMs).toBe(
      MAX_PHOTO_DURATION_MS,
    );
  });

  it('leaves the clip alone when the edge did not really move', () => {
    const clip = photo(6000);
    expect(resizeClip(clip, 'end', 0)).toBe(clip);
    expect(resizeClip(clip, 'end', Number.NaN)).toBe(clip);
    expect(resizeClip(clip, 'start', 0.4)).toBe(clip);
  });
});

describe('resizing a clip on the track', () => {
  const two = () => packClips([photo(6000), video('surf.mp4', 4000)]);

  it('pushes the clip behind it along when a tail grows into it', () => {
    const clips = two();
    const grown = resizeClipInList(clips, clips[0].id, 'end', 2000);
    expect(grown.map((c) => [c.name, c.startMs, c.durationMs])).toEqual([
      ['sunset.jpg', 0, 8000],
      ['surf.mp4', 8000, 4000],
    ]);
  });

  it('leaves a gap rather than dragging anything back when a tail shrinks', () => {
    const clips = two();
    const shrunk = resizeClipInList(clips, clips[0].id, 'end', -2000);
    expect(shrunk.map((c) => [c.name, c.startMs, c.durationMs])).toEqual([
      ['sunset.jpg', 0, 4000],
      ['surf.mp4', 6000, 4000],
    ]);
  });

  it('stops a head at the clip in front of it instead of shoving it', () => {
    const clips = two();
    const trimmed = resizeClipInList(clips, clips[1].id, 'start', -3000, 9000);
    expect(trimmed.map((c) => [c.name, c.startMs, c.durationMs])).toEqual([
      ['sunset.jpg', 0, 6000],
      ['surf.mp4', 6000, 4000],
    ]);
  });

  it('knows where the clip in front of each one ends', () => {
    const clips = [photo(1000, 0), photo(1000, 5000), photo(1000, 9000)];
    expect(endOfPrevious(clips, clips[0].id)).toBe(0);
    expect(endOfPrevious(clips, clips[1].id)).toBe(1000);
    expect(endOfPrevious(clips, clips[2].id)).toBe(6000);
    expect(endOfPrevious(clips, 'not-a-clip')).toBe(0);
  });

  it('is the same list back when nothing could move', () => {
    const clips = two();
    expect(resizeClipInList(clips, 'not-a-clip', 'end', 1000)).toBe(clips);
    expect(resizeClipInList(clips, clips[0].id, 'end', 0)).toBe(clips);
  });
});

describe('cuts & transitions', () => {
  /** Two photos whose edges touch: a(0–2000) then b(2000–5000). */
  function pair(): [Clip, Clip] {
    return [
      photoClip({ id: 'asset_a', name: 'a.jpg' }, 2000, 0),
      photoClip({ id: 'asset_b', name: 'b.jpg' }, 3000, 2000),
    ];
  }

  /** What a finished render between `a` and `b` looks like when it lands. */
  function generatedBetween(a: Clip, b: Clip, assetId = 'asset_tr', durationMs = 5000): GeneratedTransition {
    return {
      assetId,
      name: 'ai-tr.mp4',
      prompt: 'smooth cinematic motion',
      durationMs,
      from: { clipId: a.id, assetId: a.assetId, transform: transformAt(a, a.durationMs) },
      to: { clipId: b.id, assetId: b.assetId, transform: transformAt(b, 0) },
    };
  }

  describe('photoCuts', () => {
    it('offers one cut per adjacent photo pair, and none touching video', () => {
      const [a, b] = pair();
      const v = videoClip({ id: 'asset_v', name: 'v.mp4' }, 4000, 5000);
      const c = photoClip({ id: 'asset_c', name: 'c.jpg' }, 1000, 9000);

      expect(photoCuts([a, b, v, c])).toEqual([
        { afterClipId: a.id, beforeClipId: b.id, timeMs: 2000, gapMs: 0 },
      ]);
      expect(photoCuts([a])).toEqual([]);
      expect(photoCuts([])).toEqual([]);
    });

    it('a gap dragged open between two photos keeps the cut, chip centred in the gap', () => {
      const a = photoClip({ id: 'asset_a', name: 'a.jpg' }, 2000, 0);
      const b = photoClip({ id: 'asset_b', name: 'b.jpg' }, 3000, 2500);
      expect(photoCuts([a, b])).toEqual([
        { afterClipId: a.id, beforeClipId: b.id, timeMs: 2250, gapMs: 500 },
      ]);
    });

    it('a landed transition breaks its own pair, so its chip disappears structurally', () => {
      const [a, b] = pair();
      const withTransition = insertTransitionClip([a, b], a.id, b.id, generatedBetween(a, b));
      expect(withTransition).toHaveLength(3);
      expect(photoCuts(withTransition)).toEqual([]);
    });

    it('two halves of one split photo still make a cut — same image on both sides', () => {
      const [a] = pair();
      const half = { ...a, id: 'clip_half2', startMs: a.durationMs };
      expect(photoCuts([a, half])).toHaveLength(1);
    });
  });

  describe('insertTransitionClip', () => {
    it('inserts a fully-marked video clip at the cut, rippling what follows right', () => {
      const [a, b] = pair();
      // A later photo with a deliberate 1s gap after b — the gap must survive the ripple.
      const d = photoClip({ id: 'asset_d', name: 'd.jpg' }, 1000, 6000);
      const result = insertTransitionClip([a, b, d], a.id, b.id, generatedBetween(a, b));

      expect(result.map((c) => [c.kind, c.startMs])).toEqual([
        ['photo', 0],
        ['video', 2000],
        ['photo', 7000],
        ['photo', 11_000],
      ]);
      const t = result[1];
      expect(t.assetId).toBe('asset_tr');
      expect(t.durationMs).toBe(5000);
      expect(t.trimStartMs).toBe(0);
      expect(t.ai).toEqual({ prompt: 'smooth cinematic motion', sourceAssetId: 'asset_a' });
      expect(t.transition).toMatchObject({
        prompt: 'smooth cinematic motion',
        from: { clipId: a.id, assetId: 'asset_a' },
        to: { clipId: b.id, assetId: 'asset_b' },
      });
    });

    it('fills a gap between the pair: the render lands after the left photo and the right one comes flush', () => {
      const [a, b] = pair();
      // b dragged 2 s later to make room, and a photo further along keeping its own gap.
      const apart = { ...b, startMs: 4000 };
      const d = photoClip({ id: 'asset_d', name: 'd.jpg' }, 1000, 8000);

      const result = insertTransitionClip([a, apart, d], a.id, b.id, generatedBetween(a, apart));
      expect(result.map((c) => [c.kind, c.startMs])).toEqual([
        ['photo', 0],
        // The 5 s render starts where a ends and consumes the 2 s gap…
        ['video', 2000],
        // …so b sits flush against its tail, and d keeps its 1 s of spacing after b.
        ['photo', 7000],
        ['photo', 11_000],
      ]);
    });

    it('a render shorter than the gap pulls the right photo back flush rather than leaving black', () => {
      const [a, b] = pair();
      const apart = { ...b, startMs: 10_000 };

      const result = insertTransitionClip([a, apart], a.id, b.id, {
        ...generatedBetween(a, apart),
        durationMs: 3000,
      });
      expect(result.map((c) => [c.kind, c.startMs])).toEqual([
        ['photo', 0],
        ['video', 2000],
        ['photo', 5000],
      ]);
    });

    it('is an identity no-op when the pair no longer forms a cut', () => {
      const [a, b] = pair();
      const generated = generatedBetween(a, b);

      expect(insertTransitionClip([b], a.id, b.id, generated)).toEqual([b]);
      const v = videoClip({ id: 'asset_v', name: 'v.mp4' }, 3000, 2000);
      expect(insertTransitionClip([a, v], a.id, v.id, generated)).toEqual([a, v]);
      // A third clip between the pair means they are no longer adjacent — nowhere to land.
      const between = photoClip({ id: 'asset_x', name: 'x.jpg' }, 1000, 2000);
      const shifted = { ...b, startMs: 3000 };
      expect(insertTransitionClip([a, between, shifted], a.id, b.id, generated)).toEqual([
        a,
        between,
        shifted,
      ]);
    });

    it('never inserts a clip too short to grab', () => {
      const [a, b] = pair();
      const result = insertTransitionClip([a, b], a.id, b.id, {
        ...generatedBetween(a, b),
        durationMs: 10,
      });
      expect(result[1].durationMs).toBe(MIN_CLIP_DURATION_MS);
    });
  });

  describe('replaceTransitionClip', () => {
    it('swaps a regenerated render over the old one, keeping its id and start', () => {
      const [a, b] = pair();
      const clips = insertTransitionClip([a, b], a.id, b.id, generatedBetween(a, b));
      const old = clips[1];

      const result = replaceTransitionClip(clips, old.id, generatedBetween(a, b, 'asset_tr2'));
      expect(result.map((c) => c.id)).toEqual(clips.map((c) => c.id));
      expect(result[1].assetId).toBe('asset_tr2');
      expect(result[1].startMs).toBe(old.startMs);
      expect(result[1].transition).toBeTruthy();
    });

    it('ripples what follows by the length difference, keeping its spacing', () => {
      const [a, b] = pair();
      const clips = insertTransitionClip([a, b], a.id, b.id, generatedBetween(a, b));
      const old = clips[1];

      const shorter = replaceTransitionClip(clips, old.id, generatedBetween(a, b, 'asset_tr2', 3000));
      expect(shorter.map((c) => c.startMs)).toEqual([0, 2000, 5000]);
    });

    it('is an identity no-op for an unknown clip or one that is not a transition', () => {
      const [a, b] = pair();
      const clips = insertTransitionClip([a, b], a.id, b.id, generatedBetween(a, b));
      expect(replaceTransitionClip(clips, 'nope', generatedBetween(a, b))).toBe(clips);
      expect(replaceTransitionClip(clips, a.id, generatedBetween(a, b))).toBe(clips);
    });
  });

  describe('setTransitionDuration', () => {
    it('corrects the provisional length and ripples what follows along', () => {
      const [a, b] = pair();
      const clips = insertTransitionClip([a, b], a.id, b.id, generatedBetween(a, b));
      const t = clips[1];

      const corrected = setTransitionDuration(clips, t.id, 3400);
      expect(corrected[1].durationMs).toBe(3400);
      expect(corrected.map((c) => c.startMs)).toEqual([0, 2000, 5400]);
      expect(setTransitionDuration(clips, t.id, 5000)).toBe(clips);
      expect(setTransitionDuration(clips, a.id, 3400)).toBe(clips);
    });
  });

  describe('transitionStaleness', () => {
    function landed(): { clips: Clip[]; a: Clip; b: Clip; t: Clip } {
      const [a, b] = pair();
      const clips = insertTransitionClip([a, b], a.id, b.id, generatedBetween(a, b));
      return { clips, a, b: clips[2], t: clips[1] };
    }

    it('is fresh while the pair and their framings match what was rendered', () => {
      const { clips, t } = landed();
      expect(transitionStaleness(clips, t.id)).toBe('fresh');
    });

    it('goes stale when a neighbour is a different clip or a different asset', () => {
      const { clips, b, t } = landed();
      const other = photoClip({ id: 'asset_c', name: 'c.jpg' }, 1000, 0);
      expect(transitionStaleness([other, t, b], t.id)).toBe('stale');

      const swappedAsset = { ...clips[0], assetId: 'asset_other' };
      expect(transitionStaleness([swappedAsset, t, b], t.id)).toBe('stale');
    });

    it('goes stale when a neighbour’s relevant framing drifts, but shrugs off noise', () => {
      const { clips, a, b, t } = landed();
      const reframed = addKeyframe(a, a.durationMs, { ...IDENTITY_TRANSFORM, scale: 2 });
      expect(transitionStaleness([reframed, t, b], t.id)).toBe('stale');

      // A drift far below the epsilon is slider noise, not a reason to flag a re-spend.
      const noisy = addKeyframe(a, a.durationMs, { ...IDENTITY_TRANSFORM, scale: 1 + 1e-7 });
      expect(transitionStaleness([noisy, t, b], t.id)).toBe('fresh');
      expect(transitionStaleness(clips, t.id)).toBe('fresh');
    });

    it('is orphaned when a neighbour is missing or not a photo', () => {
      const { a, b, t } = landed();
      const v = videoClip({ id: 'asset_v', name: 'v.mp4' }, 1500, 0);
      expect(transitionStaleness([t, b], t.id)).toBe('orphaned');
      expect(transitionStaleness([a, t], t.id)).toBe('orphaned');
      expect(transitionStaleness([v, t, b], t.id)).toBe('orphaned');
      // Not a transition at all — there are no sources to compare.
      expect(transitionStaleness([a, t, b], a.id)).toBe('orphaned');
      expect(transitionStaleness([a, t, b], 'nope')).toBe('orphaned');
    });
  });
});

describe('audio tracks', () => {
  const asset = { id: 'asset_song', name: 'theme.mp3' };

  it('starts where it was placed, never before zero, and never absurdly short', () => {
    const track = audioTrack(asset, 2500, 8000);
    expect([track.startMs, track.durationMs, track.trimStartMs]).toEqual([2500, 8000, 0]);
    expect([track.volume, track.muted]).toEqual([1, false]);
    expect(audioTrack(asset, -50, 8000).startMs).toBe(0);
    expect(audioTrack(asset, 0, 1).durationMs).toBe(MIN_CLIP_DURATION_MS);
  });

  it('slides along the lane but cannot start before the timeline does', () => {
    const track = audioTrack(asset, 2000, 8000);
    expect(moveAudio(track, 5000).startMs).toBe(5000);
    expect(moveAudio(track, -3000).startMs).toBe(0);
    expect(moveAudio(track, 2000)).toBe(track);
  });

  it('trims its head like a video: the sound stays on the samples it was on', () => {
    const track = audioTrack(asset, 2000, 8000);
    const trimmed = resizeAudio(track, 'start', 1500, 8000);
    expect([trimmed.startMs, trimmed.trimStartMs, trimmed.durationMs]).toEqual([3500, 1500, 6500]);
    // Pulling back restores it — and stops at the start of the source.
    const back = resizeAudio(trimmed, 'start', -5000, 8000);
    expect([back.startMs, back.trimStartMs, back.durationMs]).toEqual([2000, 0, 8000]);
  });

  it('cannot reveal sound from before the timeline or the source starts', () => {
    // Sitting at 1s with 3s already trimmed: the timeline is the nearer wall.
    const track = { ...audioTrack(asset, 1000, 4000), trimStartMs: 3000 };
    const pulled = resizeAudio(track, 'start', -9000, 10_000);
    expect([pulled.startMs, pulled.trimStartMs, pulled.durationMs]).toEqual([0, 2000, 5000]);
  });

  it('cannot outgrow its source, and only shrinks while the length is unknown', () => {
    const track = audioTrack(asset, 0, 5000);
    expect(resizeAudio(track, 'end', 99_000, 8000).durationMs).toBe(8000);
    expect(resizeAudio(track, 'end', 1000, undefined)).toBe(track);
    expect(resizeAudio(track, 'end', -1000, undefined).durationMs).toBe(4000);
    expect(resizeAudio(track, 'end', -99_000, 8000).durationMs).toBe(MIN_CLIP_DURATION_MS);
  });

  it('stretches the timeline when a sound outlasts the visuals', () => {
    const clips = [photo(6000)];
    expect(timelineEndMs(clips, [])).toBe(6000);
    expect(timelineEndMs(clips, [audioTrack(asset, 4000, 8000)])).toBe(12_000);
    expect(timelineEndMs(clips, [audioTrack(asset, 0, 3000)])).toBe(6000);
    expect(audioEndMs([])).toBe(0);
  });
});
