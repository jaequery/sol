/**
 * What survives a restart, and what a bad project file is not allowed to do.
 *
 * Everything here is pure, so the rules are asserted rather than clicked: the schema, what
 * is deliberately left out of it, and the refusals — because the file outlives app
 * versions and is sitting in a directory the user can open and edit.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_ASPECT_RATIO } from './aspect';
import {
  hydrate,
  INTERRUPTED,
  markMissing,
  PROJECT_VERSION,
  readProjectFile,
  toProjectFile,
  type ProjectDocument,
  type ProjectFile,
} from './project';
import { MAX_PX_PER_SECOND, type AudioTrack, type Clip, type Generation, type MediaAsset } from '../types/project';

const resolveSrc = (path: string) => `asset://${path}`;

function asset(over: Partial<MediaAsset> & { id: string }): MediaAsset {
  return {
    name: `${over.id}.png`,
    kind: 'photo',
    path: `/media/${over.id}.png`,
    src: `asset:///media/${over.id}.png`,
    sizeBytes: 1024,
    ...over,
  };
}

function clip(over: Partial<Clip> & { id: string; assetId: string }): Clip {
  return {
    kind: 'photo',
    name: 'cliff.png',
    startMs: 0,
    durationMs: 5000,
    trimStartMs: 0,
    ...over,
  };
}

function lane(over: Partial<AudioTrack> & { id: string; assetId: string }): AudioTrack {
  return {
    name: 'score.mp3',
    startMs: 0,
    durationMs: 8000,
    trimStartMs: 0,
    volume: 1,
    muted: false,
    ...over,
  };
}

function documentOf(over: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    assets: {},
    clips: [],
    audioTracks: [],
    cutPrompts: {},
    cutModes: {},
    aspectRatio: DEFAULT_ASPECT_RATIO,
    ...over,
  };
}

/** The real path: through `JSON`, exactly as the file on disk does it. */
function throughDisk(doc: ProjectDocument) {
  return readProjectFile(JSON.parse(JSON.stringify(toProjectFile(doc))));
}

describe('a project through disk and back', () => {
  const photo = asset({ id: 'asset_p' });
  const video = asset({ id: 'asset_v', kind: 'video', path: '/media/pan.mp4', durationMs: 12_000 });
  const sound = asset({ id: 'asset_s', kind: 'audio', path: '/media/score.mp3', durationMs: 30_000 });

  const doc = documentOf({
    assets: { asset_p: photo, asset_v: video, asset_s: sound },
    clips: [
      clip({ id: 'clip_1', assetId: 'asset_p' }),
      clip({ id: 'clip_2', assetId: 'asset_v', kind: 'video', startMs: 6000, trimStartMs: 1500 }),
    ],
    audioTracks: [lane({ id: 'track_1', assetId: 'asset_s', startMs: 2000, volume: 0.4 })],
    cutPrompts: { 'clip_1:clip_2': 'a slow push in' },
    cutModes: { 'clip_1:clip_2': 'replace' },
  });

  it('comes back as the same timeline — clips, trims, lanes and typed prompts', () => {
    const read = throughDisk(doc);
    expect(read.kind).toBe('project');
    if (read.kind !== 'project') return;

    const back = hydrate(read.file, { resolveSrc });
    expect(back.clips).toEqual(doc.clips);
    expect(back.audioTracks).toEqual(doc.audioTracks);
    expect(back.cutPrompts).toEqual({ 'clip_1:clip_2': 'a slow push in' });
    expect(back.cutModes).toEqual({ 'clip_1:clip_2': 'replace' });
    expect(Object.keys(back.assets).sort()).toEqual(['asset_p', 'asset_s', 'asset_v']);
  });

  /**
   * The whole reason the file stores `path` and not `src`: an `asset:` URL belongs to the
   * session that minted it, so it is rebuilt on the way in rather than trusted on the way
   * out.
   */
  it('never stores a session handle — `src` is rebuilt from the path', () => {
    const file = toProjectFile(doc);
    expect(JSON.stringify(file)).not.toContain('src');

    const read = throughDisk(doc);
    if (read.kind !== 'project') throw new Error('expected a project');
    const back = hydrate(read.file, { resolveSrc: (p) => `rebuilt://${p}` });
    expect(back.assets.asset_p.src).toBe('rebuilt:///media/asset_p.png');
  });

  /** Without this a restored video is stuck at the length it was drawn with, and cannot be lengthened. */
  it('keeps a probed source length, so a restored video can still be trimmed', () => {
    const read = throughDisk(doc);
    if (read.kind !== 'project') throw new Error('expected a project');
    const back = hydrate(read.file, { resolveSrc });
    expect(back.assets.asset_v.durationMs).toBe(12_000);
    expect(back.assets.asset_s.durationMs).toBe(30_000);
  });

  /**
   * A session's own state is not the project. Two things now survive it — where the user was
   * looking, and what was still rendering — and everything else is as absent as it ever was.
   * A document with nothing in flight still writes no `generations` key at all.
   */
  it('stores nothing about the session that made it', () => {
    const raw = JSON.stringify(toProjectFile(doc));
    for (const ephemeral of ['generations', 'film', 'playing', 'selection', 'toasts', 'exportState']) {
      expect(raw).not.toContain(ephemeral);
    }
  });
});

describe('how a clip is framed', () => {
  const photo = asset({ id: 'asset_p' });
  const framed: Clip = clip({
    id: 'clip_1',
    assetId: 'asset_p',
    transform: {
      crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
      zoom: 2.5,
      offsetX: -0.5,
      offsetY: 1,
      rotation: 270,
      flipH: true,
      flipV: false,
    },
  });

  it('comes back exactly as it was set', () => {
    const read = throughDisk(
      documentOf({ assets: { asset_p: photo }, clips: [framed] }),
    );
    if (read.kind !== 'project') throw new Error('expected a project');
    expect(hydrate(read.file, { resolveSrc }).clips[0]).toEqual(framed);
  });

  /** A clip nobody reframed carries no `transform` key at all — not one full of defaults. */
  it('writes nothing for a clip that was never reframed', () => {
    const plain = clip({ id: 'clip_1', assetId: 'asset_p' });
    const raw = JSON.stringify(
      toProjectFile(documentOf({ assets: { asset_p: photo }, clips: [plain] })),
    );
    expect(raw).not.toContain('transform');
  });

  it('reads a hand-edited nonsense framing as a clip that is simply not reframed', () => {
    const result = readProjectFile({
      version: PROJECT_VERSION,
      assets: [{ id: 'asset_p', name: 'a.png', kind: 'photo', path: '/a.png', sizeBytes: 1 }],
      clips: [
        { ...clip({ id: 'clip_1', assetId: 'asset_p' }), transform: 'sideways' },
        {
          ...clip({ id: 'clip_2', assetId: 'asset_p' }),
          transform: { crop: { x: -3, y: 0, width: 0, height: 9 }, zoom: 1, rotation: 45 },
        },
      ],
    });
    if (result.kind !== 'project') throw new Error('expected a project, not a refusal');
    expect(result.file.clips[0].transform).toBeUndefined();
    // The rotation was refused outright; the crop was pulled back onto the picture, which
    // leaves a rectangle that is real — so this clip *is* framed, just not as asked.
    expect(result.file.clips[1].transform).toEqual({
      crop: { x: 0, y: 0, width: 0.05, height: 1 },
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  });

  /** A framing that survives normalisation as the identity is dropped, not stored empty. */
  it('drops a stored framing that turns out to say nothing', () => {
    const result = readProjectFile({
      version: PROJECT_VERSION,
      assets: [{ id: 'asset_p', name: 'a.png', kind: 'photo', path: '/a.png', sizeBytes: 1 }],
      clips: [{ ...clip({ id: 'clip_1', assetId: 'asset_p' }), transform: { zoom: 0.2 } }],
    });
    if (result.kind !== 'project') throw new Error('expected a project');
    expect(result.file.clips[0].transform).toBeUndefined();
  });
});

describe('where the user was looking', () => {
  const doc = documentOf();

  it('round-trips the playhead, the zoom and the snap toggle', () => {
    const view = { playheadMs: 42_000, pxPerSecond: 80, snapping: false };
    const read = throughDisk({ ...doc, view });
    if (read.kind !== 'project') throw new Error('expected a project');
    expect(hydrate(read.file, { resolveSrc }).view).toEqual(view);
  });

  /** A project written before there was anywhere to put it, and the common case besides. */
  it('is simply absent when the stored project has none, rather than a default on screen', () => {
    const read = throughDisk(doc);
    if (read.kind !== 'project') throw new Error('expected a project');
    expect(read.file.view).toBeUndefined();
    expect(hydrate(read.file, { resolveSrc }).view).toBeUndefined();
  });

  /**
   * The file is hand-editable. A zoom outside the slider's own range would draw a timeline
   * the control that produced it cannot represent, and a negative playhead is not a place.
   */
  it('clamps a zoom the slider could never have produced, and a playhead before the start', () => {
    const read = readProjectFile({
      ...toProjectFile(doc),
      view: { playheadMs: -5000, pxPerSecond: 100_000, snapping: true },
    });
    if (read.kind !== 'project') throw new Error('expected a project');
    expect(read.file.view).toEqual({ playheadMs: 0, pxPerSecond: MAX_PX_PER_SECOND, snapping: true });
  });

  it('reads a half-written viewport as no viewport at all', () => {
    const read = readProjectFile({ ...toProjectFile(doc), view: { snapping: false } });
    if (read.kind !== 'project') throw new Error('expected a project');
    expect(read.file.view).toBeUndefined();
  });
});

describe('the shape of the frame', () => {
  const doc = documentOf();

  it('round-trips, so a project reopens at the ratio it was drawn at', () => {
    const read = throughDisk({ ...doc, aspectRatio: '9:16' });
    if (read.kind !== 'project') throw new Error('expected a project');
    expect(read.file.aspectRatio).toBe('9:16');
    expect(hydrate(read.file, { resolveSrc }).aspectRatio).toBe('9:16');
  });

  /**
   * The one field here that is *defaulted* rather than refused. Every project written
   * before the frame could be reshaped is missing it and is a perfectly good 16:9 project;
   * refusing the file over its shape would throw away a whole timeline.
   */
  it('reads a project written before the setting existed as 16:9, and still reads the timeline', () => {
    const withMedia = documentOf({
      assets: { asset_p: asset({ id: 'asset_p' }) },
      clips: [clip({ id: 'clip_1', assetId: 'asset_p' })],
    });
    // Exactly what an older build's bytes look like: the field is not there at all.
    const stored = { ...toProjectFile(withMedia) } as Partial<ProjectFile>;
    delete stored.aspectRatio;

    const read = readProjectFile(stored);
    if (read.kind !== 'project') throw new Error('expected a project');
    expect(read.file.aspectRatio).toBe(DEFAULT_ASPECT_RATIO);
    expect(read.file.clips).toHaveLength(1);
  });

  it('falls back on a shape a hand-edited file invented, rather than refusing the file', () => {
    for (const invented of ['7:3', '', 42, null, {}]) {
      const read = readProjectFile({ ...toProjectFile(doc), aspectRatio: invented });
      if (read.kind !== 'project') throw new Error(`expected a project for ${String(invented)}`);
      expect(read.file.aspectRatio).toBe(DEFAULT_ASPECT_RATIO);
    }
  });
});

describe('a render that was still going when the app went away', () => {
  // A cut record only survives the read if its pair is still on the track, so the document
  // it round-trips through has to actually carry that pair.
  const doc = documentOf({
    assets: { asset_p: asset({ id: 'asset_p' }) },
    clips: [
      clip({ id: 'clip_1', assetId: 'asset_p' }),
      clip({ id: 'clip_2', assetId: 'asset_p', startMs: 5000 }),
    ],
  });

  function generation(over: Partial<Generation> = {}): Generation {
    return {
      id: 'gen_1',
      target: {
        kind: 'cut',
        afterClipId: 'clip_1',
        beforeClipId: 'clip_2',
        from: { clipId: 'clip_1', assetId: 'asset_p' },
        to: { clipId: 'clip_2', assetId: 'asset_p' },
      },
      prompt: 'a gentle push in',
      modelId: 'seedance_2_5',
      status: 'running',
      progress: 0.4,
      elapsedSecs: 12,
      slow: true,
      jobId: 'd2f79a31-live',
      ...over,
    };
  }

  it('comes back as a card that can be retried, saying it was interrupted rather than that it failed', () => {
    const read = throughDisk({ ...doc, generations: { gen_1: generation() } });
    if (read.kind !== 'project') throw new Error('expected a project');
    const back = hydrate(read.file, { resolveSrc }).generations?.gen_1;
    expect(back?.status).toBe('failed');
    expect(back?.error).toEqual(INTERRUPTED);
    expect(back?.error?.retryable).toBe(true);
    expect(back?.prompt).toBe('a gentle push in');
    expect(back?.modelId).toBe('seedance_2_5');
  });

  /**
   * The job handle is the one field that would make a restored record *look* resumable, and
   * there is nothing on either side of the app that could re-attach to it. The rest is what
   * a running card draws with, and there is no running card any more.
   */
  it('writes down nothing that belonged to the process that died', () => {
    const raw = JSON.stringify(toProjectFile({ ...doc, generations: { gen_1: generation() } }));
    for (const dead of ['jobId', 'd2f79a31-live', 'progress', 'elapsedSecs', 'slow', 'outputPath']) {
      expect(raw).not.toContain(dead);
    }
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'does not write down a %s one — that is not work in flight',
    (status) => {
      const file = toProjectFile({ ...doc, generations: { gen_1: generation({ status }) } });
      expect(file.generations).toBeUndefined();
    },
  );

  /**
   * A film's own state is not part of the project, so a restored leg would be a record no
   * component renders, whose Retry dismisses the card and then silently does nothing.
   */
  it('never writes a film leg, and refuses one that was put there by hand', () => {
    const leg: Generation = {
      ...generation(),
      id: 'gen_film',
      target: { kind: 'film', startAssetId: 'asset_p', endAssetId: 'asset_v', filmSegmentIndex: 0 },
    };
    expect(toProjectFile({ ...doc, generations: { gen_film: leg } }).generations).toBeUndefined();

    const byHand = readProjectFile({
      ...toProjectFile(doc),
      generations: [
        { id: 'gen_film', prompt: 'x', modelId: 'seedance_2_5', target: { kind: 'film', startAssetId: 'a', endAssetId: 'b', filmSegmentIndex: 0 } },
      ],
    });
    if (byHand.kind !== 'project') throw new Error('expected a project');
    expect(byHand.file.generations).toBeUndefined();
  });

  /** The same rule a cut prompt gets: with no cut left, there is no chip and no card. */
  it('drops a cut record whose clips went with a dropped asset', () => {
    const read = readProjectFile({
      ...toProjectFile(doc),
      generations: [
        {
          id: 'gen_1',
          prompt: 'x',
          modelId: 'seedance_2_5',
          target: {
            kind: 'cut',
            afterClipId: 'clip_gone',
            beforeClipId: 'clip_also_gone',
            from: { clipId: 'clip_gone', assetId: 'asset_p' },
            to: { clipId: 'clip_also_gone', assetId: 'asset_p' },
          },
        },
      ],
    });
    if (read.kind !== 'project') throw new Error('expected a project');
    expect(read.file.generations).toBeUndefined();
  });

  /** A photo is retried from its prompt alone, so it never depended on the track. */
  it('keeps a photo record, which has no clips to lose', () => {
    const image: Generation = {
      ...generation(),
      id: 'gen_img',
      target: { kind: 'image', referenceAssetIds: ['asset_p'], aspect: '16:9' },
    };
    const read = throughDisk({ ...doc, clips: [], generations: { gen_img: image } });
    if (read.kind !== 'project') throw new Error('expected a project');
    expect(read.file.generations?.map((g) => g.id)).toEqual(['gen_img']);
  });

  /**
   * The same for a video, and the reason this test exists rather than being assumed: the
   * target reader answers `null` for any kind it does not know, and a `null` target drops
   * the whole record silently. Without its own branch a video generation interrupted by a
   * quit would simply never come back, where a photo comes back as an Interrupted card.
   */
  it('keeps a video record, which has no clips to lose either', () => {
    const video: Generation = {
      ...generation(),
      id: 'gen_vid',
      target: { kind: 'video' },
    };
    const read = throughDisk({ ...doc, clips: [], generations: { gen_vid: video } });
    if (read.kind !== 'project') throw new Error('expected a project');
    expect(read.file.generations?.map((g) => g.id)).toEqual(['gen_vid']);
    expect(read.file.generations?.[0].target).toEqual({ kind: 'video' });
    // And it comes back as something the user is told about, not as a live job.
    expect(read.file.generations?.[0].prompt).toBe(video.prompt);
  });
});

describe('media that is no longer there', () => {
  it('marks an asset whose file the probe could not find, and leaves the rest alone', () => {
    const assets = {
      here: asset({ id: 'here' }),
      gone: asset({ id: 'gone', path: '/media/gone.png' }),
    };
    const { assets: next, missing } = markMissing(assets, new Set(['/media/gone.png']));

    expect(next.gone.missing).toBe(true);
    expect(next.here.missing).toBeUndefined();
    expect(missing.map((a) => a.id)).toEqual(['gone']);
  });

  /**
   * Identity, not just equality: a probe that finds everything where it left it must not
   * look like an edit, or every launch would cost a pointless write.
   */
  it('hands back the very same object when nothing changed', () => {
    const assets = { here: asset({ id: 'here' }) };
    expect(markMissing(assets, new Set()).assets).toBe(assets);
  });

  it('clears the mark when the file comes back', () => {
    const assets = { back: { ...asset({ id: 'back' }), missing: true } };
    const { assets: next, missing } = markMissing(assets, new Set());
    expect(next.back.missing).toBeUndefined();
    expect(missing).toEqual([]);
  });

  /** A browser drop only ever had an object URL. There is no path to go back to, ever. */
  it('restores a path-less asset as missing without asking the filesystem', () => {
    const doc = documentOf({
      assets: { dropped: asset({ id: 'dropped', path: '', src: 'blob:whatever' }) },
      clips: [clip({ id: 'clip_1', assetId: 'dropped' })],
    });
    const read = throughDisk(doc);
    if (read.kind !== 'project') throw new Error('expected a project');

    const back = hydrate(read.file, { resolveSrc });
    expect(back.assets.dropped.missing).toBe(true);
    expect(back.assets.dropped.src).toBe('');
    // The clip stays: the timeline still says what it says, it just cannot draw this span.
    expect(back.clips).toHaveLength(1);
  });
});

describe('a file that is not a project of this version', () => {
  it('reads nothing at all as nothing', () => {
    expect(readProjectFile(null).kind).toBe('empty');
    expect(readProjectFile(undefined).kind).toBe('empty');
  });

  it.each([
    ['a string', '{ not json'],
    ['an array', [1, 2, 3]],
    ['no version', { assets: [], clips: [] }],
    ['a version that is not a number', { version: 'one' }],
    ['a version this build has left behind', { version: 0 }],
  ])('refuses %s rather than half-applying it', (_case, raw) => {
    expect(readProjectFile(raw).kind).toBe('unreadable');
  });

  /**
   * The one refusal that is not replaceable. A later build's project must survive being
   * opened by an older one, so this answer is what turns saving off for the session.
   */
  it('reports a newer project as newer, and says which version', () => {
    const read = readProjectFile({ version: PROJECT_VERSION + 1, clips: [] });
    expect(read).toEqual({ kind: 'newer', version: PROJECT_VERSION + 1 });
  });
});

describe('a project that has been edited by hand', () => {
  function read(raw: unknown) {
    const result = readProjectFile(raw);
    if (result.kind !== 'project') throw new Error(`expected a project, got ${result.kind}`);
    return result.file;
  }

  it('drops a clip whose media is not in the bin', () => {
    const file = read({
      version: PROJECT_VERSION,
      assets: [{ id: 'asset_p', name: 'a.png', kind: 'photo', path: '/a.png', sizeBytes: 1 }],
      clips: [clip({ id: 'clip_1', assetId: 'asset_p' }), clip({ id: 'clip_2', assetId: 'vanished' })],
    });
    expect(file.clips.map((c) => c.id)).toEqual(['clip_1']);
  });

  it('drops an audio lane whose media is not in the bin', () => {
    const file = read({
      version: PROJECT_VERSION,
      assets: [],
      audioTracks: [lane({ id: 'track_1', assetId: 'vanished' })],
    });
    expect(file.audioTracks).toEqual([]);
  });

  /**
   * Cut entries are keyed by the two clips they sit between. A key naming a clip that just
   * got dropped would otherwise live forever — invisible, and rewritten on every save.
   */
  it('prunes cut prompts and modes that name a clip which no longer exists', () => {
    const file = read({
      version: PROJECT_VERSION,
      assets: [{ id: 'asset_p', name: 'a.png', kind: 'photo', path: '/a.png', sizeBytes: 1 }],
      clips: [clip({ id: 'clip_1', assetId: 'asset_p' }), clip({ id: 'clip_2', assetId: 'asset_p' })],
      cutPrompts: { 'clip_1:clip_2': 'kept', 'clip_1:ghost': 'dropped', nonsense: 'dropped' },
      cutModes: { 'clip_1:clip_2': 'replace', 'ghost:clip_2': 'insert' },
    });
    expect(file.cutPrompts).toEqual({ 'clip_1:clip_2': 'kept' });
    expect(file.cutModes).toEqual({ 'clip_1:clip_2': 'replace' });
  });

  it('ignores a cut mode that is not a mode', () => {
    const file = read({
      version: PROJECT_VERSION,
      assets: [{ id: 'asset_p', name: 'a.png', kind: 'photo', path: '/a.png', sizeBytes: 1 }],
      clips: [clip({ id: 'clip_1', assetId: 'asset_p' }), clip({ id: 'clip_2', assetId: 'asset_p' })],
      cutModes: { 'clip_1:clip_2': 'sideways' },
    });
    expect(file.cutModes).toEqual({});
  });

  /**
   * A half-written transition record is what the staleness check reaches into, so it is
   * read whole or not at all — the clip survives as ordinary AI footage.
   */
  it('keeps a clip whose transition record is malformed, minus the record', () => {
    const file = read({
      version: PROJECT_VERSION,
      assets: [{ id: 'asset_p', name: 'a.png', kind: 'photo', path: '/a.png', sizeBytes: 1 }],
      clips: [
        {
          ...clip({ id: 'clip_1', assetId: 'asset_p', kind: 'video' }),
          ai: { prompt: 'a push in', sourceAssetId: 'asset_p' },
          transition: { prompt: 'a push in', from: { clipId: 'clip_a' } },
        },
      ],
    });
    expect(file.clips[0].transition).toBeUndefined();
    expect(file.clips[0].ai).toEqual({ prompt: 'a push in', sourceAssetId: 'asset_p' });
  });

  it('keeps a whole transition record intact', () => {
    const transition = {
      prompt: 'a slow push in',
      from: { clipId: 'clip_a', assetId: 'asset_p' },
      to: { clipId: 'clip_b', assetId: 'asset_p' },
      mode: 'replace' as const,
    };
    const file = read({
      version: PROJECT_VERSION,
      assets: [{ id: 'asset_p', name: 'a.png', kind: 'photo', path: '/a.png', sizeBytes: 1 }],
      clips: [{ ...clip({ id: 'clip_1', assetId: 'asset_p', kind: 'video' }), transition }],
    });
    expect(file.clips[0].transition).toEqual(transition);
  });

  it('keeps the moment a video side of a transition was taken from', () => {
    // A replace landing consumes its still, so the clip that knew the trim is gone. What
    // survives a save is the only thing that can regenerate the render at the same frame.
    const transition = {
      prompt: 'whip through',
      from: { clipId: 'clip_a', assetId: 'asset_v', atMs: 3967 },
      to: { clipId: 'clip_b', assetId: 'asset_p' },
      mode: 'replace' as const,
    };
    const file = read({
      version: PROJECT_VERSION,
      assets: [{ id: 'asset_p', name: 'a.png', kind: 'photo', path: '/a.png', sizeBytes: 1 }],
      clips: [{ ...clip({ id: 'clip_1', assetId: 'asset_p', kind: 'video' }), transition }],
    });
    expect(file.clips[0].transition).toEqual(transition);
  });

  it('drops an anchor that is not a moment, keeping the rest of the record', () => {
    const file = read({
      version: PROJECT_VERSION,
      assets: [{ id: 'asset_p', name: 'a.png', kind: 'photo', path: '/a.png', sizeBytes: 1 }],
      clips: [
        {
          ...clip({ id: 'clip_1', assetId: 'asset_p', kind: 'video' }),
          transition: {
            prompt: 'whip through',
            from: { clipId: 'clip_a', assetId: 'asset_v', atMs: -5 },
            to: { clipId: 'clip_b', assetId: 'asset_p', atMs: 'soon' },
          },
        },
      ],
    });
    expect(file.clips[0].transition).toEqual({
      prompt: 'whip through',
      from: { clipId: 'clip_a', assetId: 'asset_v' },
      to: { clipId: 'clip_b', assetId: 'asset_p' },
    });
  });

  it('refuses a clip that is missing the numbers a clip is made of', () => {
    const file = read({
      version: PROJECT_VERSION,
      assets: [{ id: 'asset_p', name: 'a.png', kind: 'photo', path: '/a.png', sizeBytes: 1 }],
      clips: [{ id: 'clip_1', assetId: 'asset_p', kind: 'photo', name: 'a.png' }],
    });
    expect(file.clips).toEqual([]);
  });

  /** A zero-length clip has nothing to grab and nothing to show; the floor is the app's own. */
  it('clamps a clip below the minimum length rather than restoring an ungrabbable one', () => {
    const file = read({
      version: PROJECT_VERSION,
      assets: [{ id: 'asset_p', name: 'a.png', kind: 'photo', path: '/a.png', sizeBytes: 1 }],
      clips: [clip({ id: 'clip_1', assetId: 'asset_p', durationMs: 0, startMs: -400 })],
    });
    expect(file.clips[0].durationMs).toBe(100);
    expect(file.clips[0].startMs).toBe(0);
  });

  it('clamps a lane volume into range', () => {
    const file = read({
      version: PROJECT_VERSION,
      assets: [{ id: 'asset_s', name: 's.mp3', kind: 'audio', path: '/s.mp3', sizeBytes: 1 }],
      audioTracks: [lane({ id: 'track_1', assetId: 'asset_s', volume: 9 })],
    });
    expect(file.audioTracks[0].volume).toBe(1);
  });
});
