import { beforeEach, describe, expect, it } from 'vitest';
import {
  addKeyframe,
  clipAt,
  cssTransform,
  dropIndexFor,
  findSegment,
  formatDuration,
  formatTimecode,
  insertClips,
  insertIndexAt,
  insertIndexAtTime,
  layout,
  moveClip,
  moveKeyframe,
  photoClip,
  removeKeyframe,
  replaceSegment,
  resetIds,
  resizeClip,
  segmentsOf,
  setPrompt,
  startOfIndex,
  totalDurationMs,
  transformAt,
  truncateName,
  updateKeyframe,
  videoClip,
} from './timeline';
import {
  IDENTITY_TRANSFORM,
  MAX_PHOTO_DURATION_MS,
  MAX_SCALE,
  MIN_CLIP_DURATION_MS,
  type Clip,
} from '../types/project';

beforeEach(resetIds);

function photo(durationMs = 6000): Clip {
  return photoClip({ id: 'asset_photo', name: 'sunset.jpg' }, durationMs);
}

describe('layout', () => {
  it('lays clips end to end on a single track', () => {
    const clips = [photo(6000), videoClip({ id: 'a', name: 'surf.mp4' }, 9000)];
    expect(layout(clips).map((p) => [p.startMs, p.endMs])).toEqual([
      [0, 6000],
      [6000, 15000],
    ]);
    expect(totalDurationMs(clips)).toBe(15000);
  });

  it('finds the clip under the playhead and the time within it', () => {
    const clips = [photo(6000), videoClip({ id: 'a', name: 'surf.mp4' }, 9000)];
    expect(clipAt(clips, 0)?.placed.clip.name).toBe('sunset.jpg');
    expect(clipAt(clips, 7000)?.placed.clip.name).toBe('surf.mp4');
    expect(clipAt(clips, 7000)?.localMs).toBe(1000);
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
  it('inserts dropped clips at an index', () => {
    const a = photo(1000);
    const b = photo(2000);
    const c = photo(3000);
    expect(insertClips([a, c], 1, [b]).map((x) => x.durationMs)).toEqual([1000, 2000, 3000]);
  });

  it('picks the insertion point from where the drop landed', () => {
    const clips = [photo(6000), videoClip({ id: 'v', name: 'v.mp4' }, 6000)];
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
    expect(totalDurationMs(result)).toBe(totalDurationMs([clip]));
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

describe('reordering a clip', () => {
  const three = () => [
    photoClip({ id: 'a', name: 'a.jpg' }, 1000),
    photoClip({ id: 'b', name: 'b.jpg' }, 2000),
    photoClip({ id: 'c', name: 'c.jpg' }, 3000),
  ];

  it('drops on the boundary nearest where the clip was let go', () => {
    const clips = three();
    const c = clips[2].id;
    // Ignoring the dragged clip, the rest is a(0–1000) then b(1000–3000).
    expect(dropIndexFor(clips, c, 0)).toBe(0);
    expect(dropIndexFor(clips, c, 900)).toBe(1);
    expect(dropIndexFor(clips, c, 2900)).toBe(2);
  });

  it('moves the clip to that index and leaves the others in order', () => {
    const clips = three();
    const moved = moveClip(clips, clips[2].id, 0);
    expect(moved.map((x) => x.name)).toEqual(['c.jpg', 'a.jpg', 'b.jpg']);
    // Only the order changed; the track is the same length.
    expect(totalDurationMs(moved)).toBe(totalDurationMs(clips));
  });

  it('is a no-op when the clip is put back where it came from', () => {
    const clips = three();
    expect(moveClip(clips, clips[1].id, 1)).toBe(clips);
    expect(moveClip(clips, 'not-a-clip', 0)).toBe(clips);
  });

  it('clamps a drag past either end onto the end', () => {
    const clips = three();
    expect(moveClip(clips, clips[0].id, 99).map((x) => x.name)).toEqual([
      'b.jpg',
      'c.jpg',
      'a.jpg',
    ]);
    expect(moveClip(clips, clips[2].id, -5).map((x) => x.name)).toEqual([
      'c.jpg',
      'a.jpg',
      'b.jpg',
    ]);
  });

  it('agrees with the file-drop index, which is the same maths over a ratio', () => {
    const clips = three();
    expect(insertIndexAt(clips, 0.5)).toBe(insertIndexAtTime(clips, 3000));
    expect(startOfIndex(clips, 2)).toBe(3000);
    expect(startOfIndex(clips, 99)).toBe(6000);
  });
});

describe('resizing a clip', () => {
  it('changes a photo\u2019s duration from the tail', () => {
    const clip = resizeClip(photo(6000), 'end', 2500);
    expect(clip.durationMs).toBe(8500);
    expect(resizeClip(clip, 'end', -3000).durationMs).toBe(5500);
  });

  it('trims a photo from the head, which shortens it without moving the tail', () => {
    const before = photo(6000);
    const after = resizeClip(before, 'start', 1500);
    expect(after.durationMs).toBe(4500);
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
    let clip = photo(6000);
    clip = addKeyframe(clip, 1000);
    clip = addKeyframe(clip, 5000);

    const trimmed = resizeClip(clip, 'start', 2000);
    expect(trimmed.durationMs).toBe(4000);
    // 1000 fell off the front and pinned to 0; 5000 travelled to 3000.
    expect(trimmed.keyframes.map((k) => k.timeMs)).toEqual([0, 3000]);

    const grown = resizeClip(clip, 'start', -1000);
    expect(grown.durationMs).toBe(7000);
    expect(grown.keyframes.map((k) => k.timeMs)).toEqual([2000, 6000]);
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
    expect(resizeClip(clip, 'start', -MAX_PHOTO_DURATION_MS * 2).durationMs).toBe(
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
