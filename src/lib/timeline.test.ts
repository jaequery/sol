import { beforeEach, describe, expect, it } from 'vitest';
import {
  audioEndMs,
  audioTrack,
  canDeleteSelection,
  canSplitAt,
  clipAt,
  endOfPrevious,
  durationInputValue,
  formatDuration,
  formatTimecode,
  insertClips,
  insertIndexAt,
  insertIndexAtTime,
  layout,
  moveAudio,
  packClips,
  parseDurationInput,
  photoClip,
  placeClip,
  insertTransitionClip,
  anchorMs,
  FRAME_STEP_MS,
  bridgeableCuts,
  consumedByReplace,
  cutOffersReplace,
  removeClipsClosingSpans,
  replacePairWithTransition,
  replaceTransitionClip,
  resetIds,
  resizeAudio,
  resizeClip,
  resizeClipInList,
  retimeClip,
  snapStartMs,
  snapTargets,
  startOfIndex,
  setTransitionDuration,
  timelineEndMs,
  trackEndMs,
  transitionStaleness,
  truncateName,
  videoClip,
  type GeneratedTransition,
} from './timeline';
import { MAX_PHOTO_DURATION_MS, MIN_CLIP_DURATION_MS, type Clip } from '../types/project';

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
  it('changes a photo’s duration from the tail', () => {
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

  it('cannot pull a head back past 0:00, or past the clip in front of it', () => {
    // Against the start of the timeline there is nothing in front to reveal.
    const first = photo(6000);
    expect(resizeClip(first, 'start', -2000)).toBe(first);

    // And with a clip ending at 3000 in front of it, the head stops there.
    const clip = photo(6000, 4000);
    const stopped = resizeClip(clip, 'start', -5000, undefined, 3000);
    expect([stopped.startMs, stopped.durationMs]).toEqual([3000, 7000]);
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

  it('walks a video’s in-point when its head is trimmed, and back again', () => {
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

describe('a typed length', () => {
  it('seeds the box with a typed length that survives being handed straight back', () => {
    expect(durationInputValue(5000)).toBe('5.0');
    expect(durationInputValue(0)).toBe('0.0');
    expect(durationInputValue(MIN_CLIP_DURATION_MS)).toBe('0.1');
    expect(durationInputValue(600_000)).toBe('600.0');
    // Not a round tenth: every millisecond is kept, or pressing Enter on an untouched box
    // would quietly retime the clip to the value the box had rounded it to.
    expect(durationInputValue(4237)).toBe('4.237');
    expect(parseDurationInput(durationInputValue(4237))).toBe(4237);
  });

  it('reads a typed length in seconds, however it is spelled', () => {
    expect(parseDurationInput('5')).toBe(5000);
    expect(parseDurationInput('5.0')).toBe(5000);
    expect(parseDurationInput(' 12 ')).toBe(12_000);
    expect(parseDurationInput('5.')).toBe(5000);
    expect(parseDurationInput('.5')).toBe(500);
    expect(parseDurationInput('0.05')).toBe(50);
    // Zero is a length; the resize is what floors it, exactly as dragging an edge shut is.
    expect(parseDurationInput('0')).toBe(0);
  });

  it('refuses everything `Number` would have guessed at, rather than retiming on a typo', () => {
    // An empty box is the dangerous one: `Number('')` is 0, so a stray Enter would floor
    // the clip to the minimum.
    expect(parseDurationInput('')).toBeNull();
    expect(parseDurationInput('   ')).toBeNull();
    expect(parseDurationInput('.')).toBeNull();
    expect(parseDurationInput('abc')).toBeNull();
    expect(parseDurationInput('-3')).toBeNull();
    expect(parseDurationInput('1e3')).toBeNull();
    expect(parseDurationInput('0x10')).toBeNull();
    expect(parseDurationInput('Infinity')).toBeNull();
    // A decimal comma is a different notation, not a length in this box.
    expect(parseDurationInput('5,0')).toBeNull();
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
      from: { clipId: a.id, assetId: a.assetId },
      to: { clipId: b.id, assetId: b.assetId },
    };
  }

  describe('bridgeableCuts', () => {
    it('offers a cut at every boundary, whatever the two clips are', () => {
      // Higgsfield animates between two stills, and a video hands over the frame at its
      // edge exactly as a photo hands over itself — so no boundary is special.
      const [a, b] = pair();
      const v = videoClip({ id: 'asset_v', name: 'v.mp4' }, 4000, 5000);
      const c = photoClip({ id: 'asset_c', name: 'c.jpg' }, 1000, 9000);

      expect(bridgeableCuts([a, b, v, c])).toEqual([
        { afterClipId: a.id, beforeClipId: b.id, timeMs: 2000, gapMs: 0 },
        { afterClipId: b.id, beforeClipId: v.id, timeMs: 5000, gapMs: 0 },
        { afterClipId: v.id, beforeClipId: c.id, timeMs: 9000, gapMs: 0 },
      ]);
      expect(bridgeableCuts([a])).toEqual([]);
      expect(bridgeableCuts([])).toEqual([]);
    });

    it('offers a cut between two videos, and one across a gap between them', () => {
      const v1 = videoClip({ id: 'asset_v1', name: 'one.mp4' }, 2000, 0);
      const v2 = videoClip({ id: 'asset_v2', name: 'two.mp4' }, 3000, 2500);
      expect(bridgeableCuts([v1, v2])).toEqual([
        { afterClipId: v1.id, beforeClipId: v2.id, timeMs: 2250, gapMs: 500 },
      ]);
    });

    it('a gap dragged open between two photos keeps the cut, chip centred in the gap', () => {
      const a = photoClip({ id: 'asset_a', name: 'a.jpg' }, 2000, 0);
      const b = photoClip({ id: 'asset_b', name: 'b.jpg' }, 3000, 2500);
      expect(bridgeableCuts([a, b])).toEqual([
        { afterClipId: a.id, beforeClipId: b.id, timeMs: 2250, gapMs: 500 },
      ]);
    });

    it('a landed transition is a side of the cut on each side of it', () => {
      // Its own pair's cut is gone — the render stands there now — and the two boundaries
      // it just made are cuts like any other: a landed render is footage, and running it on
      // into the next clip is exactly the thing a user may want next.
      const [a, b] = pair();
      const withTransition = insertTransitionClip([a, b], a.id, b.id, generatedBetween(a, b));
      expect(withTransition).toHaveLength(3);
      const landed = withTransition[1];
      expect(bridgeableCuts(withTransition)).toEqual([
        { afterClipId: a.id, beforeClipId: landed.id, timeMs: 2000, gapMs: 0 },
        { afterClipId: landed.id, beforeClipId: b.id, timeMs: 7000, gapMs: 0 },
      ]);
      // Two landings back to back are a cut too — the same rule, no exception to explain.
      const chained = insertTransitionClip(
        withTransition,
        landed.id,
        withTransition[2].id,
        generatedBetween(landed, withTransition[2], 'asset_tr2'),
      );
      expect(chained).toHaveLength(4);
      expect(bridgeableCuts(chained).map((c) => [c.afterClipId, c.beforeClipId])).toEqual([
        [a.id, landed.id],
        [landed.id, chained[2].id],
        [chained[2].id, b.id],
      ]);
    });

    it('two halves of one split photo still make a cut — same image on both sides', () => {
      const [a] = pair();
      const half = { ...a, id: 'clip_half2', startMs: a.durationMs };
      expect(bridgeableCuts([a, half])).toHaveLength(1);
    });
  });

  describe('what a pair can do', () => {
    it('offers replace wherever there is a still to stand in for, and nowhere else', () => {
      const [a, b] = pair();
      const v1 = videoClip({ id: 'asset_v1', name: 'one.mp4' }, 2000, 0);
      const v2 = videoClip({ id: 'asset_v2', name: 'two.mp4' }, 2000, 2000);

      expect(cutOffersReplace(a, b)).toBe(true);
      expect(cutOffersReplace(a, v2)).toBe(true);
      expect(cutOffersReplace(v1, b)).toBe(true);
      // Two videos have nothing to give up: the motion cannot stand in for footage.
      expect(cutOffersReplace(v1, v2)).toBe(false);
    });

    it('consumes only the stills, so footage on either side is never taken', () => {
      const [a, b] = pair();
      const v = videoClip({ id: 'asset_v', name: 'v.mp4' }, 2000, 0);
      expect(consumedByReplace(a, b)).toEqual([a.id, b.id]);
      expect(consumedByReplace(v, b)).toEqual([b.id]);
      expect(consumedByReplace(a, v)).toEqual([a.id]);
      expect(consumedByReplace(v, { ...v, id: 'clip_v2' })).toEqual([]);
    });
  });

  describe('anchorMs', () => {
    it('is the frame at the clip edge for a video, and nothing at all for a photo', () => {
      const [a] = pair();
      expect(anchorMs(a, 'out')).toBeUndefined();
      expect(anchorMs(a, 'in')).toBeUndefined();

      // Trimmed to run 1000-4000 inside its source: the motion leaves on the last frame it
      // shows, which is one step before the point it runs to — seeking to the out point
      // itself lands on the first frame this clip no longer plays.
      const v = { ...videoClip({ id: 'asset_v', name: 'v.mp4' }, 3000, 0), trimStartMs: 1000 };
      expect(anchorMs(v, 'in')).toBe(1000);
      expect(anchorMs(v, 'out')).toBe(4000 - FRAME_STEP_MS);
    });

    it('never backs a clip shorter than one frame out before its own start', () => {
      // Below `MIN_CLIP_DURATION_MS` no drag can take a clip, so this guards a stored
      // project rather than a gesture — but an anchor before the trim is a different shot.
      const v = {
        ...videoClip({ id: 'asset_v', name: 'v.mp4' }, 1000, 0),
        trimStartMs: 500,
        durationMs: 20,
      };
      expect(anchorMs(v, 'out')).toBe(500);
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

  describe('replacePairWithTransition', () => {
    it('removes both photos and stands the clip where the left one started', () => {
      const [a, b] = pair();
      // A later photo with a 1 s gap after b — the render stands where b stood, so that
      // black is now against the render and closes.
      const d = photoClip({ id: 'asset_d', name: 'd.jpg' }, 1000, 6000);
      const result = replacePairWithTransition([a, b, d], a.id, b.id, {
        ...generatedBetween(a, b),
        mode: 'replace',
      });

      // The 5 s render covers the pair's 5 s span exactly; d comes up against its tail
      // rather than leaving a second of black beside the motion.
      expect(result.map((c) => [c.kind, c.startMs])).toEqual([
        ['video', 0],
        ['photo', 5000],
      ]);
      expect(result.find((c) => c.id === a.id)).toBeUndefined();
      expect(result.find((c) => c.id === b.id)).toBeUndefined();

      const t = result[0];
      expect(t.assetId).toBe('asset_tr');
      expect(t.ai).toEqual({ prompt: 'smooth cinematic motion', sourceAssetId: 'asset_a' });
      expect(t.transition).toMatchObject({
        mode: 'replace',
        from: { clipId: a.id, assetId: 'asset_a' },
        to: { clipId: b.id, assetId: 'asset_b' },
      });
    });

    it('takes only the photo when a video stands on the other side of the cut', () => {
      // The ticket's own rule: replace applies to the image side. A video is footage the
      // user shot, not a held frame the motion can stand in for — so it keeps its span and
      // its trim, and the render fills from where it ends.
      const v = { ...videoClip({ id: 'asset_v', name: 'v.mp4' }, 2000, 0), trimStartMs: 800 };
      const b = photoClip({ id: 'asset_b', name: 'b.jpg' }, 3000, 2000);
      const d = photoClip({ id: 'asset_d', name: 'd.jpg' }, 1000, 6000);

      const result = replacePairWithTransition([v, b, d], v.id, b.id, {
        ...generatedBetween(v, b),
        durationMs: 3000,
        mode: 'replace',
      });

      // The video is untouched — same id, same span, same trim — and the 3 s render stands
      // exactly where the photo held; d comes up against it rather than staying behind
      // black the photo used to hold back.
      expect(result.map((c) => [c.kind, c.startMs, c.durationMs])).toEqual([
        ['video', 0, 2000],
        ['video', 2000, 3000],
        ['photo', 5000, 1000],
      ]);
      expect(result[0].id).toBe(v.id);
      expect(result[0].trimStartMs).toBe(800);
      expect(result.find((c) => c.id === b.id)).toBeUndefined();
    });

    it('takes only the photo when it is the left side, pulling the video up behind it', () => {
      const a = photoClip({ id: 'asset_a', name: 'a.jpg' }, 2000, 0);
      const v = videoClip({ id: 'asset_v', name: 'v.mp4' }, 4000, 2000);

      const result = replacePairWithTransition([a, v], a.id, v.id, {
        ...generatedBetween(a, v),
        durationMs: 3000,
        mode: 'replace',
      });

      // The photo's 2 s hold becomes a 3 s render, and the video — whole — follows it.
      expect(result.map((c) => [c.kind, c.startMs, c.durationMs])).toEqual([
        ['video', 0, 3000],
        ['video', 3000, 4000],
      ]);
      expect(result[1].id).toBe(v.id);
    });

    it('is exactly an insert between two videos — there is no still to consume', () => {
      // `cutOffersReplace` keeps the mode off that card entirely, so this is a safety
      // property rather than a path a user can take: a stray `replace` must not eat
      // footage. Both spellings land the same clips in the same places.
      const v1 = videoClip({ id: 'asset_v1', name: 'one.mp4' }, 2000, 0);
      const v2 = videoClip({ id: 'asset_v2', name: 'two.mp4' }, 3000, 2500);
      const generated = { ...generatedBetween(v1, v2), durationMs: 4000 };

      const replaced = replacePairWithTransition([v1, v2], v1.id, v2.id, {
        ...generated,
        mode: 'replace' as const,
      });
      const inserted = insertTransitionClip([v1, v2], v1.id, v2.id, generated);
      expect(replaced.map((c) => [c.kind, c.startMs, c.durationMs])).toEqual(
        inserted.map((c) => [c.kind, c.startMs, c.durationMs]),
      );
      expect(replaced).toHaveLength(3);
    });

    it('ripples what follows by the difference between the render and the span it replaced', () => {
      const [a, b] = pair();
      const d = photoClip({ id: 'asset_d', name: 'd.jpg' }, 1000, 6000);
      const result = replacePairWithTransition([a, b, d], a.id, b.id, {
        ...generatedBetween(a, b),
        durationMs: 3000,
        mode: 'replace',
      });

      // A 3 s render over a 5 s span: everything after comes back, and d comes all the way
      // back — nothing black is left standing against the render.
      expect(result.map((c) => [c.kind, c.startMs])).toEqual([
        ['video', 0],
        ['photo', 3000],
      ]);
    });

    it('consumes a gap dragged open between the pair', () => {
      const [a, b] = pair();
      const apart = { ...b, startMs: 4000 };
      const d = photoClip({ id: 'asset_d', name: 'd.jpg' }, 1000, 8000);
      const result = replacePairWithTransition([a, apart, d], a.id, b.id, {
        ...generatedBetween(a, apart),
        mode: 'replace',
      });

      // The 5 s render replaces the 7 s span, gap included; d comes up flush behind it.
      expect(result.map((c) => [c.kind, c.startMs])).toEqual([
        ['video', 0],
        ['photo', 5000],
      ]);
    });

    it('leaves clips in front of the pair — and the span before its own start — untouched', () => {
      const z = photoClip({ id: 'asset_z', name: 'z.jpg' }, 1000, 0);
      const a = photoClip({ id: 'asset_a', name: 'a.jpg' }, 2000, 1000);
      const b = photoClip({ id: 'asset_b', name: 'b.jpg' }, 3000, 3000);
      const result = replacePairWithTransition([z, a, b], a.id, b.id, {
        ...generatedBetween(a, b),
        mode: 'replace',
      });

      expect(result.map((c) => [c.kind, c.startMs])).toEqual([
        ['photo', 0],
        ['video', 1000],
      ]);
    });

    it('is an identity no-op when the pair no longer forms a cut', () => {
      const [a, b] = pair();
      const generated = { ...generatedBetween(a, b), mode: 'replace' as const };

      expect(replacePairWithTransition([b], a.id, b.id, generated)).toEqual([b]);
      // A third clip between the pair means they are no longer adjacent — nothing to replace.
      const between = photoClip({ id: 'asset_x', name: 'x.jpg' }, 1000, 2000);
      const shifted = { ...b, startMs: 3000 };
      expect(replacePairWithTransition([a, between, shifted], a.id, b.id, generated)).toEqual([
        a,
        between,
        shifted,
      ]);
    });
  });

  describe('removeClipsClosingSpans', () => {
    /** a(0–2000) · t1(2000–5000) · b(5000–8000): the shape an insert landing leaves. */
    function chain(): [Clip, Clip, Clip] {
      return [
        photoClip({ id: 'asset_a', name: 'a.jpg' }, 2000, 0),
        videoClip({ id: 'asset_t1', name: 't1.mp4' }, 3000, 2000),
        photoClip({ id: 'asset_b', name: 'b.jpg' }, 3000, 5000),
      ];
    }

    it('closes the removed span: everything after walks left by its duration', () => {
      const [a, t1, b] = chain();
      const result = removeClipsClosingSpans([a, t1, b], [a.id]);
      expect(result.map((c) => [c.id, c.startMs])).toEqual([
        [t1.id, 0],
        [b.id, 3000],
      ]);
    });

    it('accumulates shifts across multiple removals', () => {
      // a · t1 · b · t2 · c — the two-cut animate chain; both photos and the tail go.
      const [a, t1, b] = chain();
      const t2 = videoClip({ id: 'asset_t2', name: 't2.mp4' }, 4000, 8000);
      const c = photoClip({ id: 'asset_c', name: 'c.jpg' }, 1000, 12_000);

      const result = removeClipsClosingSpans([a, t1, b, t2, c], [a.id, b.id, c.id]);
      expect(result.map((x) => [x.id, x.startMs])).toEqual([
        [t1.id, 0],
        [t2.id, 3000],
      ]);
    });

    it('keeps user gaps elsewhere in shape', () => {
      // A 1 s gap the user dragged open in front of d survives the span closing before it.
      const [a, t1, b] = chain();
      const d = photoClip({ id: 'asset_d', name: 'd.jpg' }, 1000, 9000);

      const result = removeClipsClosingSpans([a, t1, b, d], [b.id]);
      expect(result.map((x) => [x.id, x.startMs])).toEqual([
        [a.id, 0],
        [t1.id, 2000],
        [d.id, 6000],
      ]);
    });

    it('never moves a clip that sits before the removal', () => {
      const [a, t1, b] = chain();
      const result = removeClipsClosingSpans([a, t1, b], [b.id]);
      expect(result.map((x) => [x.id, x.startMs])).toEqual([
        [a.id, 0],
        [t1.id, 2000],
      ]);
    });

    it('unknown ids are no-ops', () => {
      const [a, t1, b] = chain();
      expect(removeClipsClosingSpans([a, t1, b], ['nope'])).toEqual([a, t1, b]);
      expect(removeClipsClosingSpans([a, t1, b], [])).toEqual([a, t1, b]);
      // A mix removes what it knows and ignores the rest.
      expect(removeClipsClosingSpans([a, t1, b], ['nope', a.id]).map((x) => x.id)).toEqual([
        t1.id,
        b.id,
      ]);
    });
  });

  describe('replace-mode staleness', () => {
    function landedReplace(): Clip {
      const [a, b] = pair();
      const clips = replacePairWithTransition([a, b], a.id, b.id, {
        ...generatedBetween(a, b),
        mode: 'replace',
      });
      return clips[0];
    }

    it('is fresh while both source assets stand in the bin, whatever its neighbours are', () => {
      const t = landedReplace();
      const bin = { asset_a: {}, asset_b: {} };
      expect(transitionStaleness([t], t.id, bin)).toBe('fresh');
      // Neighbours say nothing: flanked by a video it would orphan an insert-mode clip.
      const v = videoClip({ id: 'asset_v', name: 'v.mp4' }, 1500, 5000);
      expect(transitionStaleness([t, v], t.id, bin)).toBe('fresh');
    });

    it('is orphaned once a source asset left the bin or its file went missing', () => {
      const t = landedReplace();
      expect(transitionStaleness([t], t.id, { asset_a: {} })).toBe('orphaned');
      expect(transitionStaleness([t], t.id, { asset_a: {}, asset_b: { missing: true } })).toBe(
        'orphaned',
      );
    });

    it('a regenerated live source is a moved anchor, even at the same time', () => {
      // A photo beside a video: only the photo is consumed, the video stays on the track as
      // the live side. Something that keeps its clip id but plays a new file — a transition
      // regenerated in place — no longer offers the frame this one was rendered from.
      const v = videoClip({ id: 'asset_v', name: 'v.mp4' }, 2000, 0);
      const b = photoClip({ id: 'asset_b', name: 'b.jpg' }, 3000, 2000);
      const clips = replacePairWithTransition([v, b], v.id, b.id, {
        ...generatedBetween(v, b),
        from: { clipId: v.id, assetId: v.assetId, atMs: anchorMs(v, 'out') },
        mode: 'replace',
      });
      const t = clips[1];
      const bin = { asset_v: {}, asset_b: {}, asset_v2: {} };
      expect(transitionStaleness(clips, t.id, bin)).toBe('fresh');

      const swapped = clips.map((c) => (c.id === v.id ? { ...c, assetId: 'asset_v2' } : c));
      expect(transitionStaleness(swapped, t.id, bin)).toBe('stale');
      // And it is the file the clip plays *now* that has to stand in the bin, not the one
      // its record remembers.
      expect(transitionStaleness(swapped, t.id, { asset_v: {}, asset_b: {} })).toBe('orphaned');
    });
  });

  describe('retimeClip', () => {
    /** Three clips laid end to end at the provisional length a drop guesses. */
    function guessed(): Clip[] {
      return [
        videoClip({ id: 'asset_a', name: 'a.mp4' }, 5000, 0),
        videoClip({ id: 'asset_b', name: 'b.mp4' }, 5000, 5000),
        videoClip({ id: 'asset_c', name: 'c.mp4' }, 5000, 10_000),
      ];
    }

    it('closes up behind a file shorter than the guess', () => {
      const clips = guessed();
      const result = retimeClip(clips, clips[0].id, 3000);
      expect(result.map((c) => [c.startMs, c.durationMs])).toEqual([
        [0, 3000],
        [3000, 5000],
        [8000, 5000],
      ]);
    });

    it('makes room for a file longer than the guess rather than stacking two on one instant', () => {
      const clips = guessed();
      const result = retimeClip(clips, clips[0].id, 8000);
      expect(result.map((c) => [c.startMs, c.durationMs])).toEqual([
        [0, 8000],
        [8000, 5000],
        [13_000, 5000],
      ]);
    });

    it('keeps a gap further along in shape — it moves with the reel, it does not close', () => {
      const clips = [
        videoClip({ id: 'asset_a', name: 'a.mp4' }, 5000, 0),
        videoClip({ id: 'asset_b', name: 'b.mp4' }, 5000, 5000),
        // A second of black the user left after b.
        videoClip({ id: 'asset_d', name: 'd.mp4' }, 1000, 11_000),
      ];
      const result = retimeClip(clips, clips[0].id, 3000);
      expect(result.map((c) => c.startMs)).toEqual([0, 3000, 9000]);
    });

    it('is the same reel back when the guess was right, or the clip is not there', () => {
      const clips = guessed();
      expect(retimeClip(clips, clips[0].id, 5000)).toBe(clips);
      expect(retimeClip(clips, 'nope', 3000)).toBe(clips);
    });

    it('never lets a correction shrink a clip below the minimum', () => {
      const clips = guessed();
      expect(retimeClip(clips, clips[0].id, 5)[0].durationMs).toBe(MIN_CLIP_DURATION_MS);
    });

    it('commutes: probes settling in any order leave the same reel', () => {
      const start = guessed();
      const [a, b, c] = start.map((x) => x.id);
      const orders = [
        [a, b, c],
        [c, b, a],
        [b, a, c],
        [b, c, a],
      ];
      const reels = orders.map((order) =>
        order
          .reduce((clips, id) => retimeClip(clips, id, 3000), start)
          .map((x) => [x.startMs, x.durationMs]),
      );
      for (const reel of reels) expect(reel).toEqual(reels[0]);
      expect(reels[0]).toEqual([
        [0, 3000],
        [3000, 3000],
        [6000, 3000],
      ]);
    });
  });

  describe('no black touches a render', () => {
    it('pulls what follows up against a landing that stood in a still\'s place', () => {
      const [a, b] = pair();
      // A second of black after b, which the render now stands in front of.
      const d = photoClip({ id: 'asset_d', name: 'd.jpg' }, 1000, 6000);
      const result = replacePairWithTransition([a, b, d], a.id, b.id, {
        ...generatedBetween(a, b),
        mode: 'replace',
      });
      expect(result.map((c) => [c.kind, c.startMs])).toEqual([
        ['video', 0],
        ['photo', 5000],
      ]);
    });

    it('brings the render back to meet the clip in front of it', () => {
      // Two seconds of black between z and the pair the render stands in for.
      const z = photoClip({ id: 'asset_z', name: 'z.jpg' }, 1000, 0);
      const a = photoClip({ id: 'asset_a', name: 'a.jpg' }, 2000, 3000);
      const b = photoClip({ id: 'asset_b', name: 'b.jpg' }, 3000, 5000);
      const result = replacePairWithTransition([z, a, b], a.id, b.id, {
        ...generatedBetween(a, b),
        mode: 'replace',
      });
      expect(result.map((c) => [c.kind, c.startMs, c.durationMs])).toEqual([
        ['photo', 0, 1000],
        ['video', 1000, 5000],
      ]);
    });

    it('leaves the head and the tail of the reel alone — black with no clip beside it is not a seam', () => {
      // The film opens on two seconds of black, and the pair is all there is.
      const a = photoClip({ id: 'asset_a', name: 'a.jpg' }, 2000, 2000);
      const b = photoClip({ id: 'asset_b', name: 'b.jpg' }, 3000, 4000);
      const result = replacePairWithTransition([a, b], a.id, b.id, {
        ...generatedBetween(a, b),
        mode: 'replace',
      });
      expect(result.map((c) => [c.startMs, c.durationMs])).toEqual([[2000, 5000]]);
    });

    it('is nothing to do for an insert landing, which is already flush on both sides', () => {
      const [a, b] = pair();
      const d = photoClip({ id: 'asset_d', name: 'd.jpg' }, 1000, 6000);
      const result = insertTransitionClip([a, b, d], a.id, b.id, generatedBetween(a, b));
      // a | render | b are back to back, and d keeps the second of black it had after b —
      // that boundary is not the render's, so it is still the user's.
      expect(result.map((c) => [c.kind, c.startMs])).toEqual([
        ['photo', 0],
        ['video', 2000],
        ['photo', 7000],
        ['photo', 11_000],
      ]);
    });

    it('a regenerated render closes its seams too', () => {
      const [a, b] = pair();
      const clips = insertTransitionClip([a, b], a.id, b.id, generatedBetween(a, b));
      const t = clips[1];
      // The user drags the clip behind the render away, then regenerates.
      const pulled = clips.map((c) => (c.id === clips[2].id ? { ...c, startMs: c.startMs + 2000 } : c));
      const again = replaceTransitionClip(pulled, t.id, {
        ...generatedBetween(a, b),
        durationMs: 4000,
      });
      expect(again.map((c) => [c.kind, c.startMs, c.durationMs])).toEqual([
        ['photo', 0, 2000],
        ['video', 2000, 4000],
        ['photo', 6000, 3000],
      ]);
    });
  });

  /**
   * The rule as an invariant rather than as examples: over a couple of thousand landings on
   * randomly shaped tracks — both kinds, landed transitions among them, gaps of every size,
   * every cut, both modes, and the probe correcting the length underneath afterwards — a
   * reel may never overlap, may never leave black standing against a render, and may never
   * come out carrying more black than it went in with. Seeded, so a failure repeats.
   */
  describe('no reel gains black, whatever the landing', () => {
    let seed = 12_345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

    function madeUpClip(i: number, kind: 'photo' | 'video', startMs: number, durationMs: number, isRender: boolean): Clip {
      const clip: Clip = {
        id: `c${i}`, assetId: `a${i}`, kind, name: `n${i}`, startMs, durationMs, trimStartMs: 0,
      };
      if (isRender) {
        clip.ai = { prompt: 'p', sourceAssetId: 'a0' };
        clip.transition = {
          prompt: 'p',
          from: { clipId: 'x', assetId: 'ax' },
          to: { clipId: 'y', assetId: 'ay' },
        };
      }
      return clip;
    }

    /** A track of two to five clips, with gaps — and the odd overlap — thrown in. */
    function madeUpTrack(): Clip[] {
      const clips: Clip[] = [];
      let cursor = Math.floor(rnd() * 3) * 1000;
      for (let i = 0; i < 2 + Math.floor(rnd() * 4); i += 1) {
        const kind = pick(['photo', 'video'] as const);
        const durationMs = pick([1000, 2000, 3400, 5000, 8000]);
        clips.push(madeUpClip(i, kind, cursor, durationMs, kind === 'video' && rnd() < 0.3));
        cursor += durationMs + pick([0, 0, 0, 500, 2000, 8000]);
      }
      return clips;
    }

    const render = (durationMs: number, mode?: 'insert' | 'replace') => ({
      assetId: 'asset_tr', name: 't.mp4', prompt: 'p', durationMs,
      from: { clipId: 'c0', assetId: 'a0' }, to: { clipId: 'c1', assetId: 'a1' }, mode,
    });

    const blackIn = (clips: Clip[]) => {
      const placed = layout(clips);
      return placed
        .slice(1)
        .reduce((sum, p, i) => sum + Math.max(0, p.startMs - placed[i].endMs), 0);
    };

    function holds(before: Clip[], after: Clip[], renderId: string | undefined, what: string) {
      const placed = layout(after);
      for (let i = 0; i < placed.length - 1; i += 1) {
        expect(placed[i + 1].startMs - placed[i].endMs, `${what}: two clips on one instant`)
          .toBeGreaterThanOrEqual(0);
      }
      expect(after.every((c) => c.startMs >= 0), `${what}: started before the reel`).toBe(true);
      expect(blackIn(after), `${what}: came out with more black`).toBeLessThanOrEqual(blackIn(before));
      if (renderId === undefined) return;
      const at = placed.findIndex((p) => p.clip.id === renderId);
      if (at === -1) return;
      if (placed[at - 1]) {
        expect(placed[at].startMs - placed[at - 1].endMs, `${what}: black in front of the render`).toBe(0);
      }
      if (placed[at + 1]) {
        expect(placed[at + 1].startMs - placed[at].endMs, `${what}: black behind the render`).toBe(0);
      }
    }

    it('holds over two thousand landings, before and after the probe corrects the length', () => {
      let landings = 0;
      for (let trial = 0; trial < 2000; trial += 1) {
        const clips = madeUpTrack();
        const cuts = bridgeableCuts(clips);
        if (cuts.length === 0) continue;
        const cut = pick(cuts);
        const mode = pick(['insert', 'replace'] as const);
        const landed =
          mode === 'insert'
            ? insertTransitionClip(clips, cut.afterClipId, cut.beforeClipId, render(pick([100, 1000, 3400, 5000, 12_000])))
            : replacePairWithTransition(clips, cut.afterClipId, cut.beforeClipId, render(pick([100, 1000, 3400, 5000, 12_000]), 'replace'));
        if (landed === clips) continue;
        landings += 1;
        const t = landed.find((c) => c.assetId === 'asset_tr');
        holds(clips, landed, t?.id, `trial ${trial} ${mode}`);
        holds(landed, retimeClip(landed, t!.id, pick([500, 3400, 9000])), undefined, `trial ${trial} ${mode} retimed`);
      }
      expect(landings).toBeGreaterThan(1500);
    });

    it('holds over six hundred regenerations', () => {
      let regenerations = 0;
      for (let trial = 0; trial < 600; trial += 1) {
        const clips = madeUpTrack();
        const t = clips.find((c) => c.transition);
        if (!t) continue;
        const again = replaceTransitionClip(clips, t.id, render(pick([500, 3400, 9000])));
        if (again === clips) continue;
        regenerations += 1;
        holds(clips, again, t.id, `regeneration ${trial}`);
      }
      expect(regenerations).toBeGreaterThan(100);
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

    it('is fresh while the pair still matches what was rendered', () => {
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

    it('is orphaned only when there is no longer a clip on both sides', () => {
      const { a, b, t } = landed();
      expect(transitionStaleness([t, b], t.id)).toBe('orphaned');
      expect(transitionStaleness([a, t], t.id)).toBe('orphaned');
      // A video neighbour is not an orphan any more — it is simply the wrong clip, which
      // is a thing Regenerate can fix.
      const v = videoClip({ id: 'asset_v', name: 'v.mp4' }, 1500, 0);
      expect(transitionStaleness([v, t, b], t.id)).toBe('stale');
      // Not a transition at all — there are no sources to compare.
      expect(transitionStaleness([a, t, b], a.id)).toBe('orphaned');
      expect(transitionStaleness([a, t, b], 'nope')).toBe('orphaned');
    });
  });

  describe('seams that are continuous by construction', () => {
    /** Two videos with a kept-frames transition between them: v1(0–2000) t1(2000–7000) v2. */
    function bridged(): { clips: Clip[]; v1: Clip; t1: Clip; v2: Clip } {
      const v1 = videoClip({ id: 'asset_v1', name: 'one.mp4' }, 2000, 0);
      const v2 = videoClip({ id: 'asset_v2', name: 'two.mp4' }, 3000, 2000);
      const clips = insertTransitionClip([v1, v2], v1.id, v2.id, {
        ...generatedBetween(v1, v2, 'asset_t1'),
        from: { clipId: v1.id, assetId: v1.assetId, atMs: anchorMs(v1, 'out') },
        to: { clipId: v2.id, assetId: v2.assetId, atMs: anchorMs(v2, 'in') },
      });
      return { clips, v1: clips[0], t1: clips[1], v2: clips[2] };
    }

    /** What a render off `a`'s tail into `b`'s head records — the real anchors, as the store sends them. */
    function rendered(a: Clip, b: Clip, assetId: string, mode?: 'insert' | 'replace'): GeneratedTransition {
      return {
        ...generatedBetween(a, b, assetId),
        from: { clipId: a.id, assetId: a.assetId, atMs: anchorMs(a, 'out') },
        to: { clipId: b.id, assetId: b.assetId, atMs: anchorMs(b, 'in') },
        mode,
      };
    }

    it('a landing beside a transition continues it — the clip it ran into is now the landing', () => {
      const { clips, t1, v2 } = bridged();
      expect(transitionStaleness(clips, t1.id)).toBe('fresh');

      // t2 is rendered out of t1's tail into v2: it opens on the very frame t1 ends on, so
      // t1 — whose record named v2 as what it ran into — now runs into t2 on that frame.
      const withT2 = insertTransitionClip(clips, t1.id, v2.id, rendered(t1, v2, 'asset_t2'));
      const [, t1After, t2] = withT2;
      expect(t2.transition?.from).toEqual({ clipId: t1.id, assetId: 'asset_t1', atMs: 4967 });
      expect(t1After.transition?.to).toEqual({ clipId: t2.id, assetId: 'asset_t2', atMs: 0 });
      expect(transitionStaleness(withT2, t1.id)).toBe('fresh');
      expect(transitionStaleness(withT2, t2.id)).toBe('fresh');
      // What is not rendered off it is left alone: v2 was never a transition.
      expect(withT2[3]).toEqual({ ...v2, startMs: v2.startMs + 5000 });
    });

    it('a landing that consumed a still continues whatever ran into that still', () => {
      // [v1][t1][p]: t1 was rendered into p. Bridging t1|p stands t2 in p's place, opening on
      // p's image — exactly the frame t1 closes on.
      const v1 = videoClip({ id: 'asset_v1', name: 'one.mp4' }, 2000, 0);
      const p = photoClip({ id: 'asset_p', name: 'p.jpg' }, 3000, 2000);
      const clips = insertTransitionClip([v1, p], v1.id, p.id, rendered(v1, p, 'asset_t1'));
      const [, t1, pAfter] = clips;
      expect(transitionStaleness(clips, t1.id)).toBe('fresh');

      const replaced = replacePairWithTransition(
        clips,
        t1.id,
        pAfter.id,
        rendered(t1, pAfter, 'asset_t2', 'replace'),
      );
      const [, t1After, t2] = replaced;
      expect(replaced).toHaveLength(3);
      expect(t2.transition).toMatchObject({ mode: 'replace', from: { clipId: t1.id } });
      expect(t1After.transition?.to).toEqual({ clipId: t2.id, assetId: 'asset_t2', atMs: 0 });
      expect(transitionStaleness(replaced, t1.id)).toBe('fresh');
      // Symmetric on the left: [p][t3] where t3 ran out of p, and a landing consumes p.
      const p2 = photoClip({ id: 'asset_p2', name: 'p2.jpg' }, 2000, 0);
      const v3 = videoClip({ id: 'asset_v3', name: 'three.mp4' }, 2000, 2000);
      const right = insertTransitionClip([p2, v3], p2.id, v3.id, rendered(p2, v3, 'asset_t3'));
      const x = videoClip({ id: 'asset_x', name: 'x.mp4' }, 1000, 10_000);
      const shifted = [{ ...x, startMs: 0 }, ...right.map((c) => ({ ...c, startMs: c.startMs + 1000 }))];
      const landedLeft = replacePairWithTransition(
        shifted,
        x.id,
        p2.id,
        rendered(shifted[0], shifted[1], 'asset_t4', 'replace'),
      );
      const t4 = landedLeft.find((c) => c.assetId === 'asset_t4')!;
      const t3After = landedLeft.find((c) => c.assetId === 'asset_t3')!;
      expect(t3After.transition?.from).toEqual({ clipId: t4.id, assetId: 'asset_t4', atMs: 4967 });
      expect(transitionStaleness(landedLeft, t3After.id)).toBe('fresh');
    });

    it('a regenerated live source re-stamps what was rendered off it, so nothing goes stale', () => {
      const { clips, t1, v2 } = bridged();
      const withT2 = insertTransitionClip(clips, t1.id, v2.id, rendered(t1, v2, 'asset_t2'));
      const t2 = withT2[2];

      // t1 is re-rendered — same clip, new file, and a new length: 4 s instead of 5.
      const again = replaceTransitionClip(withT2, t1.id, {
        ...rendered(withT2[0], t2, 'asset_t1b'),
        durationMs: 4000,
      });
      const t1b = again[1];
      expect(t1b.id).toBe(t1.id);
      expect(t1b.assetId).toBe('asset_t1b');
      // t2 was rendered off t1's tail, which was re-rendered toward t2's head: still one
      // seam, so t2's record follows the new file and the new anchor.
      expect(again[2].transition?.from).toEqual({ clipId: t1.id, assetId: 'asset_t1b', atMs: 3967 });
      expect(transitionStaleness(again, t1.id)).toBe('fresh');
      expect(transitionStaleness(again, t2.id)).toBe('fresh');

      // Strictness is intact: a trim after that is a real change.
      const trimmed = again.map((c) => (c.id === t1.id ? { ...c, durationMs: 3000 } : c));
      expect(transitionStaleness(trimmed, t2.id)).toBe('stale');
    });

    it("the probe correcting a source's length moves the record with it", () => {
      const { clips, t1, v2 } = bridged();
      const withT2 = insertTransitionClip(clips, t1.id, v2.id, rendered(t1, v2, 'asset_t2'));
      const t2 = withT2[2];
      expect(t2.transition?.from.atMs).toBe(4967);

      // The file was really 4.2 s; t2 keeps meeting the tail — now at 4167 into it.
      const corrected = setTransitionDuration(withT2, t1.id, 4200);
      expect(corrected[1].durationMs).toBe(4200);
      expect(corrected[2].transition?.from).toEqual({ clipId: t1.id, assetId: 'asset_t1', atMs: 4167 });
      expect(transitionStaleness(corrected, t2.id)).toBe('fresh');
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

describe('what the toolbar is allowed to offer', () => {
  it('a split needs the playhead strictly inside a clip', () => {
    const clips = [photoClip({ id: 'a', name: 'a.jpg' }, 5000, 0), photoClip({ id: 'b', name: 'b.jpg' }, 5000, 5000)];

    expect(canSplitAt(clips, 2500)).toBe(true);
    expect(canSplitAt(clips, 7500)).toBe(true);

    // Boundaries cut nothing: one half would be empty.
    expect(canSplitAt(clips, 0)).toBe(false);
    expect(canSplitAt(clips, 5000)).toBe(false);
    expect(canSplitAt(clips, 10_000)).toBe(false);

    // Past the end, and on an empty track.
    expect(canSplitAt(clips, 12_000)).toBe(false);
    expect(canSplitAt([], 0)).toBe(false);
  });

  it('a split in a gap has nothing under the playhead to cut', () => {
    const spaced = [photoClip({ id: 'a', name: 'a.jpg' }, 2000, 0), photoClip({ id: 'b', name: 'b.jpg' }, 2000, 6000)];
    expect(canSplitAt(spaced, 4000)).toBe(false);
    expect(canSplitAt(spaced, 1000)).toBe(true);
  });

  it('only a clip or a sound is a thing that can be deleted', () => {
    expect(canDeleteSelection({ kind: 'clip', clipId: 'c1' })).toBe(true);
    expect(canDeleteSelection({ kind: 'audio', trackId: 't1' })).toBe(true);
    expect(canDeleteSelection({ kind: 'none' })).toBe(false);
    // A cut is a place between two clips — there is nothing there to remove.
    expect(canDeleteSelection({ kind: 'cut', afterClipId: 'a', beforeClipId: 'b' })).toBe(false);
  });
});
