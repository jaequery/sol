import { beforeEach, describe, expect, it } from 'vitest';
import {
  addKeyframe,
  clipAt,
  cssTransform,
  findSegment,
  formatDuration,
  formatTimecode,
  insertClips,
  insertIndexAt,
  layout,
  moveKeyframe,
  photoClip,
  removeKeyframe,
  replaceSegment,
  resetIds,
  segmentsOf,
  setPrompt,
  totalDurationMs,
  transformAt,
  truncateName,
  updateKeyframe,
  videoClip,
} from './timeline';
import { IDENTITY_TRANSFORM, MAX_SCALE, type Clip } from '../types/project';

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
