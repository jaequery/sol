/**
 * What survives a restart, and what a bad project file is not allowed to do.
 *
 * Everything here is pure, so the rules are asserted rather than clicked: the schema, what
 * is deliberately left out of it, and the refusals — because the file outlives app
 * versions and is sitting in a directory the user can open and edit.
 */

import { describe, expect, it } from 'vitest';
import {
  hydrate,
  markMissing,
  PROJECT_VERSION,
  readProjectFile,
  toProjectFile,
  type ProjectDocument,
} from './project';
import type { AudioTrack, Clip, MediaAsset } from '../types/project';

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
  return { assets: {}, clips: [], audioTracks: [], cutPrompts: {}, cutModes: {}, ...over };
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

  /** A session's own state is not the project, and a restored generation would never finish. */
  it('stores nothing about the session that made it', () => {
    const raw = JSON.stringify(toProjectFile(doc));
    for (const ephemeral of ['generations', 'film', 'playing', 'selection', 'toasts', 'exportState']) {
      expect(raw).not.toContain(ephemeral);
    }
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
