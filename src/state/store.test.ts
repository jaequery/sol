/**
 * The film and replace-mode cut flows through the real store, plus the inspector's typed
 * length — the one edit that reaches the timeline as an absolute value rather than a drag.
 *
 * Same two stubs as `App.test.tsx` and for the same reason: the Tauri bridge and
 * canvas/media decoding are the only things jsdom cannot provide. The store, `lib/film` and
 * `lib/timeline` underneath are the real thing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyImagePanel, useEditor } from './store';
import {
  audioTrack,
  bridgeableCuts,
  photoClip,
  resizeClipInList,
  videoClip,
} from '../lib/timeline';
import { assembleFilm, defaultFilmPrompt, FILM_SEGMENT_DURATION_MS } from '../lib/film';
import {
  DEFAULT_MODEL_ID,
  type GenerateImageInput,
  type GenerateInput,
  type GenerationUpdate,
} from '../lib/backend';
import { MIN_CLIP_DURATION_MS, type Clip, type MediaAsset } from '../types/project';

const generateAnimation = vi.fn(async (_input: GenerateInput) => {});
const generateImage = vi.fn(async (_input: GenerateImageInput) => {});
const cancelGeneration = vi.fn(async (_id: string) => {});

// The real module's pure exports (the model registry above all) come through untouched;
// only the pieces that would reach for Tauri are stubbed.
vi.mock('../lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/backend')>()),
  isDesktop: () => true,
  assetSrc: (p: string) => `asset://${p}`,
  getSettings: async () => ({
    configured: true,
    cliPath: '/usr/local/bin/higgsfield',
    customModel: '',
    hasApiKey: false,
    apiKeyIdHint: '',
  }),
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  testApiKey: vi.fn(),
  importPaths: vi.fn(async () => ({ imported: [], rejected: [] })),
  // Persistence is desktop-only and every suite starts from a fresh, empty project.
  loadProject: vi.fn(async () => null),
  saveProject: vi.fn(async () => {}),
  generateAnimation: (input: GenerateInput) => generateAnimation(input),
  generateImage: (input: GenerateImageInput) => generateImage(input),
  cancelGeneration: (id: string) => cancelGeneration(id),
  ffmpegAvailable: async () => true,
  // A video's anchor frame comes off ffmpeg on the Rust side; the stub keeps both the file
  // it was taken from and the moment it was taken at, which is the whole thing under test.
  captureVideoFrame: async (path: string, atMs: number) =>
    `data:image/jpeg;base64,grab-of-${path}@${atMs}`,
  exportTimeline: vi.fn(),
  onGenerationUpdate: async () => () => {},
  onExportProgress: async () => () => {},
  pickMediaFiles: vi.fn(),
  pickExportPath: vi.fn(),
  revealPath: vi.fn(),
}));

// The stub keeps each photo's still identifiable, which is the whole point of a cross-asset
// request: the two frames have to come from two *different* files.
vi.mock('../lib/frames', () => ({
  FRAME_WIDTH: 1280,
  FRAME_HEIGHT: 720,
  renderPhotoJpeg: async (src: string) => `data:image/jpeg;base64,still-of-${src}`,
  probeVideoDurationMs: async (_src: string, fallback: number) => fallback,
}));

const CONNECTED = {
  configured: true,
  cliPath: '/usr/local/bin/higgsfield',
  customModel: '',
  hasApiKey: false,
  apiKeyIdHint: '',
  // A Higgsfield-only machine, which is what every expectation below assumes. The suites
  // that exercise a local backend put one in themselves.
  agents: [],
};

function photo(id: string): MediaAsset {
  return { id, name: `${id}.jpg`, kind: 'photo', path: `/photos/${id}.jpg`, src: `asset:///photos/${id}.jpg`, sizeBytes: 1024 };
}

const PHOTO_IDS = ['asset_a', 'asset_b', 'asset_c'];

beforeEach(() => {
  generateAnimation.mockClear();
  generateImage.mockClear();
  cancelGeneration.mockClear();
  useEditor.setState({
    assets: Object.fromEntries(PHOTO_IDS.map((id) => [id, photo(id)])),
    clips: [],
    selection: { kind: 'none' },
    playheadMs: 0,
    playing: false,
    generations: {},
    modelId: DEFAULT_MODEL_ID,
    film: null,
    imagePanel: emptyImagePanel(),
    cutPrompts: {},
    cutModes: {},
    animateQueue: null,
    animateSubmittingId: null,
    animateRun: null,
    importProblems: [],
    importing: 0,
    draggingAssetId: null,
    toasts: [],
    exportState: null,
    settings: CONNECTED,
    settingsOpen: false,
    saveError: null,
  });
});

/** Deliver an update the way the Rust side's `generation:update` event would. */
function emit(update: GenerationUpdate) {
  useEditor.getState().applyGenerationUpdate(update);
}

/**
 * How many requests have reached the backend.
 *
 * A leg is recorded synchronously and its frames are rendered and submitted behind that,
 * so the request itself lands a tick or two after `startFilm` resolves.
 */
async function submitted(times: number): Promise<void> {
  await vi.waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(times));
}

function segmentGenerationId(index: number): string {
  const id = useEditor.getState().film?.segments[index].generationId;
  expect(id).toBeTruthy();
  return id as string;
}

describe('a typed length', () => {
  /** Two photos back to back: a (0–5000) then b (5000–8000). */
  function pairOnTrack(): [Clip, Clip] {
    const a = photoClip({ id: 'asset_a', name: 'asset_a.jpg' }, 5000, 0);
    const b = photoClip({ id: 'asset_b', name: 'asset_b.jpg' }, 3000, 5000);
    useEditor.setState({ clips: [a, b], audioTracks: [] });
    return [a, b];
  }

  it('is the tail drag, to the clip — the two land on exactly the same timeline', () => {
    const [a] = pairOnTrack();
    const dragged = resizeClipInList(useEditor.getState().clips, a.id, 'end', 7000);

    useEditor.getState().setClipDuration(a.id, 12_000);
    expect(useEditor.getState().clips).toEqual(dragged);
  });

  it('grows the clip and pushes what is behind it along', () => {
    const [a, b] = pairOnTrack();
    useEditor.getState().setClipDuration(a.id, 12_000);

    const clips = useEditor.getState().clips;
    expect(clips.find((c) => c.id === a.id)?.durationMs).toBe(12_000);
    // Nothing overlaps: b starts where a now ends.
    expect(clips.find((c) => c.id === b.id)?.startMs).toBe(12_000);
  });

  it('leaves a gap when it shrinks, rather than pulling the track back', () => {
    const [a, b] = pairOnTrack();
    useEditor.getState().setClipDuration(a.id, 2000);

    const clips = useEditor.getState().clips;
    expect(clips.find((c) => c.id === a.id)?.durationMs).toBe(2000);
    expect(clips.find((c) => c.id === b.id)?.startMs).toBe(5000);
  });

  it('stops a video at the end of its source, and floors anything at 100 ms', () => {
    const clip = videoClip({ id: 'asset_v', name: 'surf.mp4' }, 4000, 0);
    useEditor.setState({
      assets: {
        asset_v: {
          id: 'asset_v',
          name: 'surf.mp4',
          kind: 'video',
          path: '/v/surf.mp4',
          src: 'asset:///v/surf.mp4',
          sizeBytes: 2048,
          durationMs: 4200,
        },
      },
      clips: [clip],
      audioTracks: [],
    });

    useEditor.getState().setClipDuration(clip.id, 30_000);
    expect(useEditor.getState().clips[0].durationMs).toBe(4200);

    useEditor.getState().setClipDuration(clip.id, 0);
    expect(useEditor.getState().clips[0].durationMs).toBe(MIN_CLIP_DURATION_MS);
  });

  it('does nothing at all when the length asked for is the one it already has', () => {
    const [a] = pairOnTrack();
    const before = useEditor.getState().clips;
    useEditor.getState().setClipDuration(a.id, 5000);
    // The same array, not merely an equal one: an edit that changes nothing must not write
    // the project file.
    expect(useEditor.getState().clips).toBe(before);
  });

  it('retimes a sound on its lane, clamped to the file behind it', () => {
    const track = audioTrack({ id: 'asset_m', name: 'theme.mp3' }, 2000, 5000);
    useEditor.setState({
      assets: {
        asset_m: {
          id: 'asset_m',
          name: 'theme.mp3',
          kind: 'audio',
          path: '/m/theme.mp3',
          src: 'asset:///m/theme.mp3',
          sizeBytes: 2048,
          durationMs: 8000,
        },
      },
      clips: [],
      audioTracks: [track],
    });

    useEditor.getState().setAudioDuration(track.id, 6500);
    expect(useEditor.getState().audioTracks[0].durationMs).toBe(6500);
    // The sound starts where it was put: a length is a tail edit, never a move.
    expect(useEditor.getState().audioTracks[0].startMs).toBe(2000);

    useEditor.getState().setAudioDuration(track.id, 30_000);
    expect(useEditor.getState().audioTracks[0].durationMs).toBe(8000);
  });

  it('is a no-op on an item that is no longer there', () => {
    pairOnTrack();
    const before = useEditor.getState().clips;
    useEditor.getState().setClipDuration('clip_gone', 9000);
    useEditor.getState().setAudioDuration('audio_gone', 9000);
    expect(useEditor.getState().clips).toBe(before);
  });
});

describe('a cross-asset generation', () => {
  it('sends one photo as the start frame and the other as the end frame', async () => {
    await useEditor.getState().startFilm(PHOTO_IDS, ['drift out to sea', 'rise over the cliff']);
    await submitted(2);

    const sent = generateAnimation.mock.calls.map(([input]) => input);
    const first = sent.find((s) => s.prompt === 'drift out to sea');
    const second = sent.find((s) => s.prompt === 'rise over the cliff');

    // Leg 1 animates photo A → photo B, leg 2 photo B → photo C.
    expect(first).toMatchObject({
      startFrame: 'data:image/jpeg;base64,still-of-asset:///photos/asset_a.jpg',
      endFrame: 'data:image/jpeg;base64,still-of-asset:///photos/asset_b.jpg',
    });
    expect(second).toMatchObject({
      startFrame: 'data:image/jpeg;base64,still-of-asset:///photos/asset_b.jpg',
      endFrame: 'data:image/jpeg;base64,still-of-asset:///photos/asset_c.jpg',
    });
    expect(first!.startFrame).not.toEqual(first!.endFrame);
    expect(first!.generationId).toBeTruthy();
  });

  it('defaults the prompts and takes an edit before the film is sent', async () => {
    useEditor.setState({ film: null });
    await useEditor.getState().startFilm(PHOTO_IDS);
    await submitted(2);

    expect(generateAnimation.mock.calls.map(([i]) => i.prompt).sort()).toEqual(
      [defaultFilmPrompt(0), defaultFilmPrompt(1)].sort(),
    );

    useEditor.getState().setFilmSegmentPrompt(1, 'orbit around the boat');
    expect(useEditor.getState().film?.segments[1].prompt).toBe('orbit around the boat');
  });

  it('refuses loudly with no Higgsfield credential, and sends nothing', async () => {
    useEditor.setState({ settings: { ...CONNECTED, configured: false } });

    await useEditor.getState().startFilm(PHOTO_IDS);

    expect(generateAnimation).not.toHaveBeenCalled();
    expect(useEditor.getState().film).toBeNull();
    // The same sentence every other render surface uses. It stopped being film-specific
    // when the film stopped being "nothing but Higgsfield transitions" — it renders with
    // whatever the Model selector shows, so it is refused for whatever that backend needs.
    expect(useEditor.getState().toasts[0]).toMatchObject({
      tone: 'error',
      title: 'Connect Higgsfield to generate',
    });
  });

  it('refuses a film whose photos are not in the bin', async () => {
    await useEditor.getState().startFilm(['asset_a', 'asset_b', 'asset_gone']);

    expect(generateAnimation).not.toHaveBeenCalled();
    expect(useEditor.getState().film).toBeNull();
    expect(useEditor.getState().toasts[0]).toMatchObject({ tone: 'error', title: 'Film could not start' });
  });
});

describe('a finished leg', () => {
  it('parks its output in film state and leaves the timeline alone', async () => {
    await useEditor.getState().startFilm(PHOTO_IDS);

    emit({
      generationId: segmentGenerationId(0),
      status: 'succeeded',
      progress: 1,
      elapsedSecs: 60,
      slow: false,
      outputPath: '/cache/first.mp4',
    });

    const state = useEditor.getState();
    expect(state.film?.segments[0]).toMatchObject({ status: 'succeeded', outputPath: '/cache/first.mp4' });
    // Nothing on the track, nothing in the bin: half a film is not an edit.
    expect(state.clips).toEqual([]);
    expect(Object.keys(state.assets).sort()).toEqual([...PHOTO_IDS].sort());
    expect(state.selection).toEqual({ kind: 'none' });
  });

  it('probes the file for the leg length, falling back when it cannot be read', async () => {
    await useEditor.getState().startFilm(PHOTO_IDS);
    emit({
      generationId: segmentGenerationId(1),
      status: 'succeeded',
      progress: 1,
      elapsedSecs: 60,
      slow: false,
      outputPath: '/cache/second.mp4',
    });

    // The probe is fired off without blocking the update; give it a turn to land.
    await vi.waitFor(() =>
      expect(useEditor.getState().film?.segments[1].durationMs).toBe(FILM_SEGMENT_DURATION_MS),
    );
  });

});

describe('the finished film onto the timeline', () => {
  /** Both legs home, out of order on purpose. Resolves once the film has landed. */
  async function finishFilm(paths: [string, string] = ['/cache/first.mp4', '/cache/second.mp4']) {
    const [firstId, secondId] = [segmentGenerationId(0), segmentGenerationId(1)];
    emit({ generationId: secondId, status: 'succeeded', progress: 1, elapsedSecs: 40, slow: false, outputPath: paths[1] });
    emit({ generationId: firstId, status: 'succeeded', progress: 1, elapsedSecs: 70, slow: false, outputPath: paths[0] });
    await vi.waitFor(() => expect(useEditor.getState().film?.assembledClipIds).toHaveLength(2));
  }

  it('lands by itself the moment the last leg has been measured', async () => {
    await useEditor.getState().startFilm(PHOTO_IDS, ['drift out to sea', 'rise over the cliff']);
    await finishFilm();

    const { clips, assets, selection, film, toasts } = useEditor.getState();
    // In segment order, whichever leg came back first, and nothing asked of the user.
    expect(clips.map((c) => assets[c.assetId].path)).toEqual(['/cache/first.mp4', '/cache/second.mp4']);
    expect(clips.map((c) => c.ai?.prompt)).toEqual(['drift out to sea', 'rise over the cliff']);
    expect(clips.every((c) => c.kind === 'video')).toBe(true);
    expect(film?.assembledClipIds).toEqual(clips.map((c) => c.id));
    expect(selection).toEqual({ kind: 'clip', clipId: clips[0].id });
    expect(toasts.at(-1)).toMatchObject({ tone: 'ok', title: 'Film on the timeline' });
  });

  it('appends at the end of whatever the user edited onto the track while it rendered', async () => {
    await useEditor.getState().startFilm(PHOTO_IDS);
    // The panel is not modal: this drop happens *during* the multi-minute render, so the
    // position the film lands at cannot have been decided when it was started.
    await useEditor.getState().addFiles([new File(['binary'], 'sunset.jpg', { type: 'image/jpeg' })]);

    await finishFilm();

    const { clips, assets } = useEditor.getState();
    expect(clips).toHaveLength(3);
    // The user's clip keeps the head of the track; the film goes after it, still in order.
    expect(clips[0].name).toBe('sunset.jpg');
    expect(clips.map((c) => assets[c.assetId].path)).toEqual([
      '',
      '/cache/first.mp4',
      '/cache/second.mp4',
    ]);
  });

  it('assembles once — a leg that completes again does not lay down a second copy', async () => {
    await useEditor.getState().startFilm(PHOTO_IDS);
    await finishFilm();
    const placed = useEditor.getState().clips;

    // Both the automatic path and the explicit one, on an already-assembled film.
    emit({ generationId: segmentGenerationId(0), status: 'succeeded', progress: 1, elapsedSecs: 70, slow: false, outputPath: '/cache/first.mp4' });
    useEditor.getState().placeFilmOnTimeline();
    await vi.waitFor(() => expect(useEditor.getState().clips).toEqual(placed));

    expect(useEditor.getState().toasts.filter((t) => t.title === 'Film on the timeline')).toHaveLength(1);
    expect(useEditor.getState().toasts.some((t) => t.tone === 'error')).toBe(false);
  });
});

describe('putting the film on the timeline by hand', () => {
  it('places both clips in segment order even when leg 2 finished first', async () => {
    await useEditor.getState().startFilm(PHOTO_IDS, ['drift out to sea', 'rise over the cliff']);

    const [firstId, secondId] = [segmentGenerationId(0), segmentGenerationId(1)];
    // Out of order on purpose: leg 2 comes back before leg 1.
    emit({ generationId: secondId, status: 'succeeded', progress: 1, elapsedSecs: 40, slow: false, outputPath: '/cache/second.mp4' });
    emit({ generationId: firstId, status: 'succeeded', progress: 1, elapsedSecs: 70, slow: false, outputPath: '/cache/first.mp4' });

    useEditor.getState().placeFilmOnTimeline();

    const { clips, assets, selection } = useEditor.getState();
    expect(clips.map((c) => assets[c.assetId].path)).toEqual(['/cache/first.mp4', '/cache/second.mp4']);
    expect(clips.map((c) => c.ai?.prompt)).toEqual(['drift out to sea', 'rise over the cliff']);
    expect(clips.every((c) => c.kind === 'video')).toBe(true);
    expect(selection).toEqual({ kind: 'clip', clipId: clips[0].id });
  });

  it('refuses while a leg is still missing, and says how far it got', async () => {
    await useEditor.getState().startFilm(PHOTO_IDS);
    emit({ generationId: segmentGenerationId(0), status: 'succeeded', progress: 1, elapsedSecs: 60, slow: false, outputPath: '/cache/first.mp4' });
    emit({
      generationId: segmentGenerationId(1),
      status: 'failed',
      progress: 0,
      elapsedSecs: 4,
      slow: false,
      error: { title: 'Rate limited', message: 'rate limited', retryable: true },
    });

    useEditor.getState().placeFilmOnTimeline();

    expect(useEditor.getState().clips).toEqual([]);
    expect(useEditor.getState().toasts.at(-1)).toMatchObject({ tone: 'error', title: 'The film is not finished' });
    expect(useEditor.getState().toasts.at(-1)?.detail).toContain('1 of 2 succeeded');
  });
});

describe('retry and cancel', () => {
  it('retries only the failed leg and finishes the film', async () => {
    await useEditor.getState().startFilm(PHOTO_IDS);
    emit({ generationId: segmentGenerationId(0), status: 'succeeded', progress: 1, elapsedSecs: 60, slow: false, outputPath: '/cache/first.mp4' });
    emit({
      generationId: segmentGenerationId(1),
      status: 'failed',
      progress: 0,
      elapsedSecs: 4,
      slow: false,
      error: { title: 'Rate limited', message: 'rate limited', retryable: true },
    });
    await submitted(2);

    await useEditor.getState().retryFilmSegment(1);

    // One more request, for the failed leg only — the leg that landed is not paid for twice.
    await submitted(3);
    expect(generateAnimation.mock.calls[2][0].endFrame).toContain('asset_c');
    expect(useEditor.getState().film?.segments[0]).toMatchObject({ status: 'succeeded', outputPath: '/cache/first.mp4' });

    emit({ generationId: segmentGenerationId(1), status: 'succeeded', progress: 1, elapsedSecs: 55, slow: false, outputPath: '/cache/second-retry.mp4' });

    expect(assembleFilm(useEditor.getState().film!)).not.toBeNull();
    useEditor.getState().placeFilmOnTimeline();
    const { clips, assets } = useEditor.getState();
    expect(clips.map((c) => assets[c.assetId].path)).toEqual(['/cache/first.mp4', '/cache/second-retry.mp4']);
  });

  it('will not double-run a leg that is already in flight', async () => {
    await useEditor.getState().startFilm(PHOTO_IDS);
    await submitted(2);
    await useEditor.getState().retryFilmSegment(0);

    expect(generateAnimation).toHaveBeenCalledTimes(2);
  });

  it('cancels the legs still running and reaches the backend for each', async () => {
    await useEditor.getState().startFilm(PHOTO_IDS);
    const stillRunning = segmentGenerationId(1);
    emit({ generationId: segmentGenerationId(0), status: 'succeeded', progress: 1, elapsedSecs: 60, slow: false, outputPath: '/cache/first.mp4' });

    await useEditor.getState().cancelFilm();

    const { film, generations } = useEditor.getState();
    expect(film?.segments.map((s) => s.status)).toEqual(['succeeded', 'cancelled']);
    expect(generations[stillRunning].status).toBe('cancelled');
    // Only the one still in flight: the finished leg has nothing to cancel.
    expect(cancelGeneration.mock.calls.map(([id]) => id)).toEqual([stillRunning]);
  });

  it('forgets the film when it is dismissed', async () => {
    await useEditor.getState().startFilm(PHOTO_IDS);
    useEditor.getState().dismissFilm();

    expect(useEditor.getState().film).toBeNull();
  });
});

describe('replace-mode cut transitions', () => {
  /** Two photos side by side on the track: a (0–2000) then b (2000–5000). */
  function pairOnTrack(): [Clip, Clip] {
    const a = photoClip({ id: 'asset_a', name: 'asset_a.jpg' }, 2000, 0);
    const b = photoClip({ id: 'asset_b', name: 'asset_b.jpg' }, 3000, 2000);
    useEditor.setState({ clips: [a, b] });
    return [a, b];
  }

  /** A third photo appended at `startMs`, so a landing has something to ripple or dissolve. */
  function thirdPhoto(startMs: number): Clip {
    const c = photoClip({ id: 'asset_c', name: 'asset_c.jpg' }, 1000, startMs);
    useEditor.setState({ clips: [...useEditor.getState().clips, c] });
    return c;
  }

  function succeedCut(id: string, outputPath = '/cache/replace.mp4') {
    emit({ generationId: id, status: 'succeeded', progress: 1, elapsedSecs: 60, slow: false, outputPath });
  }

  it('lands the finished MP4 in place of both photos and prunes their cut state', () => {
    const [a, b] = pairOnTrack();
    thirdPhoto(6000);

    useEditor.setState({ selection: { kind: 'cut', afterClipId: a.id, beforeClipId: b.id } });
    useEditor.getState().setCutMode('replace');
    const id = useEditor.getState().startCutGeneration(a.id, b.id);
    expect(id).toBeTruthy();
    // The pick was stamped onto the target at launch.
    expect(useEditor.getState().generations[id!].target).toMatchObject({ kind: 'cut', mode: 'replace' });

    succeedCut(id!);

    const s = useEditor.getState();
    // The 5 s render covers the pair's 5 s span exactly, so c keeps its 1 s gap.
    expect(s.clips.map((x) => [x.kind, x.startMs])).toEqual([
      ['video', 0],
      ['photo', 6000],
    ]);
    const t = s.clips[0];
    expect(t.transition).toMatchObject({
      mode: 'replace',
      from: { assetId: 'asset_a' },
      to: { assetId: 'asset_b' },
    });
    expect(s.selection).toEqual({ kind: 'clip', clipId: t.id });
    // The mode pick went with its cut, and the photos stay in the bin to re-drag.
    expect(s.cutModes).toEqual({});
    expect(s.assets.asset_a).toBeTruthy();
    expect(s.assets.asset_b).toBeTruthy();
    expect(s.toasts.at(-1)).toMatchObject({ tone: 'ok', title: 'Transition ready' });
  });

  it('cancels a neighbouring render whose photo the landing consumed', () => {
    const [a, b] = pairOnTrack();
    const c = thirdPhoto(5000);

    const idAB = useEditor.getState().startCutGeneration(a.id, b.id, 'replace');
    const idBC = useEditor.getState().startCutGeneration(b.id, c.id);
    expect(idAB && idBC).toBeTruthy();

    succeedCut(idAB!);

    const s = useEditor.getState();
    // b went with the landing, so the b→c render has nothing left to land on.
    expect(s.generations[idBC!].status).toBe('cancelled');
    expect(cancelGeneration).toHaveBeenCalledWith(idBC);
    expect(s.clips.map((x) => x.kind)).toEqual(['video', 'photo']);
  });

  it('a failed replace render leaves the timeline exactly as it was', () => {
    const [a, b] = pairOnTrack();
    const before = useEditor.getState().clips;
    const id = useEditor.getState().startCutGeneration(a.id, b.id, 'replace');

    emit({
      generationId: id!,
      status: 'failed',
      progress: 0,
      elapsedSecs: 4,
      slow: false,
      error: { title: 'Rate limited', message: 'rate limited', retryable: true },
    });

    expect(useEditor.getState().clips).toEqual(before);
    expect(useEditor.getState().generations[id!].status).toBe('failed');
  });

  it('a pair edited mid-flight gets the toast — nothing placed, no asset minted', () => {
    const [a, b] = pairOnTrack();
    const c = thirdPhoto(8000);
    const id = useEditor.getState().startCutGeneration(a.id, b.id, 'replace');

    // c dragged onto the pair's shared edge while the render runs: no longer a cut.
    useEditor.getState().moveClipTo(c.id, 2000);
    const before = useEditor.getState().clips;
    const assetsBefore = Object.keys(useEditor.getState().assets).sort();

    succeedCut(id!);

    const s = useEditor.getState();
    expect(s.clips).toEqual(before);
    expect(Object.keys(s.assets).sort()).toEqual(assetsBefore);
    expect(s.toasts.at(-1)).toMatchObject({
      tone: 'error',
      title: 'Transition finished, but its clips moved',
    });
  });

  it('regenerates a replaced transition from its source assets, swapping in place', async () => {
    const [a, b] = pairOnTrack();
    const id = useEditor.getState().startCutGeneration(a.id, b.id, 'replace');
    await submitted(1);
    succeedCut(id!);
    const landed = useEditor.getState().clips[0];
    expect(landed.transition?.mode).toBe('replace');

    generateAnimation.mockClear();
    useEditor.getState().regenerateTransition(landed.id);
    await submitted(1);

    // The frames came from the bin assets — there are no neighbouring photos left to read.
    const sent = generateAnimation.mock.calls[0][0];
    expect(sent.startFrame).toBe('data:image/jpeg;base64,still-of-asset:///photos/asset_a.jpg');
    expect(sent.endFrame).toBe('data:image/jpeg;base64,still-of-asset:///photos/asset_b.jpg');

    const regen = Object.values(useEditor.getState().generations).find(
      (g) => g.status === 'queued' || g.status === 'running',
    )!;
    expect(regen.target).toMatchObject({ kind: 'cut', replacesClipId: landed.id, mode: 'replace' });
    succeedCut(regen.id, '/cache/replace-2.mp4');

    // Swapped over the same clip: id and position kept, new footage behind it.
    const s = useEditor.getState();
    expect(s.clips.map((x) => x.id)).toEqual([landed.id]);
    expect(s.clips[0].startMs).toBe(landed.startMs);
    expect(s.assets[s.clips[0].assetId].path).toBe('/cache/replace-2.mp4');
    expect(s.clips[0].transition).toMatchObject({ mode: 'replace' });
  });

  it('refuses to regenerate once a source asset has left the bin', async () => {
    const [a, b] = pairOnTrack();
    const id = useEditor.getState().startCutGeneration(a.id, b.id, 'replace');
    await submitted(1);
    succeedCut(id!);
    const landed = useEditor.getState().clips[0];

    const assets = { ...useEditor.getState().assets };
    delete assets.asset_a;
    useEditor.setState({ assets });

    generateAnimation.mockClear();
    useEditor.getState().regenerateTransition(landed.id);

    // Refused where it was asked: no record was even written, nothing was sent.
    expect(
      Object.values(useEditor.getState().generations).some((g) => g.status === 'queued'),
    ).toBe(false);
    expect(generateAnimation).not.toHaveBeenCalled();
  });
});

describe('transitions that involve video', () => {
  /** A video asset in the bin, with a real path for ffmpeg to be pointed at. */
  function videoAsset(id: string): MediaAsset {
    return {
      id,
      name: `${id}.mp4`,
      kind: 'video',
      path: `/footage/${id}.mp4`,
      src: `asset:///footage/${id}.mp4`,
      sizeBytes: 4096,
      durationMs: 12_000,
    };
  }

  function bin(...assets: MediaAsset[]): void {
    useEditor.setState({
      assets: { ...useEditor.getState().assets, ...Object.fromEntries(assets.map((a) => [a.id, a])) },
    });
  }

  function succeedCut(id: string, outputPath = '/cache/mixed.mp4') {
    emit({ generationId: id, status: 'succeeded', progress: 1, elapsedSecs: 60, slow: false, outputPath });
  }

  it('animates out of a video and into a photo, sending the frame at the cut', async () => {
    bin(videoAsset('asset_v'));
    // Trimmed to run 1000–4000 inside its source, so the motion leaves on the frame at
    // 4000 less one step — not at the head of the file, and not past what the clip shows.
    const v = { ...videoClip({ id: 'asset_v', name: 'asset_v.mp4' }, 3000, 0), trimStartMs: 1000 };
    const b = photoClip({ id: 'asset_b', name: 'asset_b.jpg' }, 3000, 3000);
    useEditor.setState({ clips: [v, b] });

    const id = useEditor.getState().startCutGeneration(v.id, b.id);
    expect(id).toBeTruthy();
    await submitted(1);

    const sent = generateAnimation.mock.calls[0][0];
    // The video side is grabbed off the file by path; the photo side is drawn as ever.
    expect(sent.startFrame).toBe('data:image/jpeg;base64,grab-of-/footage/asset_v.mp4@3967');
    expect(sent.endFrame).toBe('data:image/jpeg;base64,still-of-asset:///photos/asset_b.jpg');

    // And the moment is recorded, so the render can be repeated after the photo is gone.
    const target = useEditor.getState().generations[id!].target;
    expect(target).toMatchObject({
      kind: 'cut',
      from: { clipId: v.id, assetId: 'asset_v', atMs: 3967 },
      to: { clipId: b.id, assetId: 'asset_b' },
    });
    expect((target as { to: { atMs?: number } }).to.atMs).toBeUndefined();
  });

  it('animates into a video from its first shown frame, not from the head of the file', async () => {
    bin(videoAsset('asset_v'));
    const a = photoClip({ id: 'asset_a', name: 'asset_a.jpg' }, 2000, 0);
    const v = { ...videoClip({ id: 'asset_v', name: 'asset_v.mp4' }, 3000, 2000), trimStartMs: 2500 };
    useEditor.setState({ clips: [a, v] });

    useEditor.getState().startCutGeneration(a.id, v.id);
    await submitted(1);

    const sent = generateAnimation.mock.calls[0][0];
    expect(sent.startFrame).toBe('data:image/jpeg;base64,still-of-asset:///photos/asset_a.jpg');
    expect(sent.endFrame).toBe('data:image/jpeg;base64,grab-of-/footage/asset_v.mp4@2500');
  });

  it('a replace landing on a mixed pair takes the photo and leaves the footage alone', async () => {
    bin(videoAsset('asset_v'));
    const v = { ...videoClip({ id: 'asset_v', name: 'asset_v.mp4' }, 2000, 0), trimStartMs: 800 };
    const b = photoClip({ id: 'asset_b', name: 'asset_b.jpg' }, 3000, 2000);
    useEditor.setState({ clips: [v, b] });

    const id = useEditor.getState().startCutGeneration(v.id, b.id, 'replace');
    await submitted(1);
    succeedCut(id!);

    const s = useEditor.getState();
    // The video is still there, whole, with its trim — only the still gave up its span.
    expect(s.clips.map((c) => [c.id, c.startMs, c.durationMs])).toEqual([
      [v.id, 0, 2000],
      [s.clips[1].id, 2000, 5000],
    ]);
    expect(s.clips[0].trimStartMs).toBe(800);
    expect(s.clips[1].transition).toMatchObject({ mode: 'replace' });
    // And the photo is back in the bin to re-drag, exactly as a replaced pair leaves both.
    expect(s.assets.asset_b).toBeDefined();
  });

  it('a video-to-video cut cannot be told to replace — there is no still to stand in for', async () => {
    bin(videoAsset('asset_v1'), videoAsset('asset_v2'));
    const v1 = videoClip({ id: 'asset_v1', name: 'asset_v1.mp4' }, 2000, 0);
    const v2 = videoClip({ id: 'asset_v2', name: 'asset_v2.mp4' }, 3000, 2000);
    useEditor.setState({
      clips: [v1, v2],
      selection: { kind: 'cut', afterClipId: v1.id, beforeClipId: v2.id },
    });

    // The action refuses the pick, not just the card that offers it.
    useEditor.getState().setCutMode('replace');
    expect(useEditor.getState().cutModes[`${v1.id}:${v2.id}`]).toBeUndefined();

    // Even a mode forced past the store lands as an insert: both videos keep their spans.
    const id = useEditor.getState().startCutGeneration(v1.id, v2.id, 'replace');
    await submitted(1);
    expect(useEditor.getState().generations[id!].target).toMatchObject({ mode: 'insert' });

    succeedCut(id!, '/cache/between.mp4');
    const s = useEditor.getState();
    expect(s.clips.map((c) => [c.id, c.startMs])).toEqual([
      [v1.id, 0],
      [s.clips[1].id, 2000],
      [v2.id, 7000],
    ]);
  });

  it('regenerating a mixed replace re-reads the video as it stands now, not as it was', async () => {
    bin(videoAsset('asset_v'));
    const v = videoClip({ id: 'asset_v', name: 'asset_v.mp4' }, 4000, 0);
    const b = photoClip({ id: 'asset_b', name: 'asset_b.jpg' }, 3000, 4000);
    useEditor.setState({ clips: [v, b] });

    const id = useEditor.getState().startCutGeneration(v.id, b.id, 'replace');
    await submitted(1);
    succeedCut(id!);
    const landed = useEditor.getState().clips.find((c) => c.transition)!;

    // The video the landing left alone is trimmed shorter, so the frame the motion was
    // rendered from is no longer the one it runs out of.
    useEditor.setState({
      clips: useEditor.getState().clips.map((c) => (c.id === v.id ? { ...c, durationMs: 2000 } : c)),
    });

    generateAnimation.mockClear();
    useEditor.getState().regenerateTransition(landed.id);
    await submitted(1);
    const sent = generateAnimation.mock.calls[0][0];
    expect(sent.startFrame).toBe('data:image/jpeg;base64,grab-of-/footage/asset_v.mp4@1967');
  });

  it('leaves video cuts out of Animate all, however many chips stand on them', () => {
    bin(videoAsset('asset_v1'), videoAsset('asset_v2'));
    const a = photoClip({ id: 'asset_a', name: 'asset_a.jpg' }, 2000, 0);
    const b = photoClip({ id: 'asset_b', name: 'asset_b.jpg' }, 2000, 2000);
    const v1 = videoClip({ id: 'asset_v1', name: 'asset_v1.mp4' }, 2000, 4000);
    const v2 = videoClip({ id: 'asset_v2', name: 'asset_v2.mp4' }, 2000, 6000);
    useEditor.setState({ clips: [a, b, v1, v2] });

    // Four clips, three cuts, all of them chipped — but one tap must not spend on footage.
    expect(bridgeableCuts(useEditor.getState().clips)).toHaveLength(3);
    useEditor.getState().animateAll();
    expect(useEditor.getState().animateRun!.legs).toHaveLength(1);
    expect(useEditor.getState().animateRun!.legs[0]).toMatchObject({
      afterClipId: a.id,
      beforeClipId: b.id,
    });
  });
});

describe('the animate-all run and its terminal collapse', () => {
  /** The named photos in the bin and on the track, 5 s each, laid end to end. */
  function photosOnTrack(ids: string[]) {
    useEditor.setState({
      assets: Object.fromEntries(ids.map((id) => [id, photo(id)])),
      clips: ids.map((id, i) => photoClip({ id, name: `${id}.jpg` }, 5000, i * 5000)),
    });
  }

  /**
   * Start the run and accept every submission in turn — the next cut only launches once
   * the previous one holds a `jobId` — so the queue drains fully and every leg is live.
   * Returns the legs' generation ids in launch order.
   */
  function runAnimateAll(): string[] {
    useEditor.getState().animateAll();
    const ids: string[] = [];
    while (useEditor.getState().animateSubmittingId) {
      const id = useEditor.getState().animateSubmittingId!;
      ids.push(id);
      emit({ generationId: id, status: 'queued', progress: 0, jobId: `job-${ids.length}`, elapsedSecs: 1, slow: false });
    }
    return ids;
  }

  function succeed(id: string, outputPath: string) {
    emit({ generationId: id, status: 'succeeded', progress: 1, elapsedSecs: 60, slow: false, outputPath });
  }

  function fail(id: string) {
    emit({
      generationId: id,
      status: 'failed',
      progress: 0,
      elapsedSecs: 4,
      slow: false,
      error: { title: 'Rate limited', message: 'rate limited', retryable: true },
    });
  }

  it('collapses to pure motion once every leg lands: photos out, clips flush, stamped replace', () => {
    photosOnTrack(['asset_a', 'asset_b', 'asset_c']);
    const [g1, g2] = runAnimateAll();
    expect(useEditor.getState().animateQueue).toBeNull();
    expect(useEditor.getState().animateRun?.legs).toHaveLength(2);

    succeed(g1, '/cache/t1.mp4');
    // Mid-run the landing is an insert: the photos are still on the track, visibly.
    expect(useEditor.getState().clips.map((c) => c.kind)).toEqual(['photo', 'video', 'photo', 'photo']);
    expect(useEditor.getState().animateRun).not.toBeNull();

    succeed(g2, '/cache/t2.mp4');

    const s = useEditor.getState();
    // Two 5 s legs back to back — the reel is the animation and nothing else.
    expect(s.clips.map((c) => [c.kind, c.startMs])).toEqual([
      ['video', 0],
      ['video', 5000],
    ]);
    expect(s.clips.map((c) => s.assets[c.assetId].path)).toEqual(['/cache/t1.mp4', '/cache/t2.mp4']);
    expect(s.clips.every((c) => c.transition?.mode === 'replace')).toBe(true);
    // The photos stay in the media bin to re-drag.
    expect(s.assets.asset_a && s.assets.asset_b && s.assets.asset_c).toBeTruthy();
    expect(s.animateRun).toBeNull();
    expect(s.toasts.at(-1)).toMatchObject({ tone: 'ok', title: '2 transitions — pure motion' });
  });

  it('a failed leg keeps its photos and the rest still collapses around them', () => {
    photosOnTrack(['asset_a', 'asset_b', 'asset_c', 'asset_d']);
    const [g1, g2, g3] = runAnimateAll();

    succeed(g1, '/cache/t1.mp4');
    fail(g2);
    succeed(g3, '/cache/t3.mp4');

    const s = useEditor.getState();
    // a and d were wholly stood in for and left; b and c stay for the failed middle leg.
    expect(s.clips.map((c) => [c.kind, c.startMs])).toEqual([
      ['video', 0],
      ['photo', 5000],
      ['photo', 10_000],
      ['video', 15_000],
    ]);
    expect(s.clips[0].transition?.mode).toBe('replace');
    expect(s.clips[3].transition?.mode).toBe('replace');
    expect(s.animateRun).toBeNull();
    expect(s.toasts.at(-1)).toMatchObject({ tone: 'ok', title: '2 of 3 transitions in' });
    // The failed record survives the collapse — its cut still stands, chip and card intact.
    expect(s.generations[g2].status).toBe('failed');
  });

  it('a landing deleted mid-run keeps the photos it covered', () => {
    photosOnTrack(['asset_a', 'asset_b', 'asset_c']);
    const [g1, g2] = runAnimateAll();

    succeed(g1, '/cache/t1.mp4');
    const t1 = useEditor.getState().clips.find((c) => c.transition)!;
    useEditor.setState({ selection: { kind: 'clip', clipId: t1.id } });
    useEditor.getState().deleteSelection();

    succeed(g2, '/cache/t2.mp4');

    const s = useEditor.getState();
    // The conservative rule: motion gone means its stills stay — only c leaves.
    expect(s.clips.map((c) => [c.kind, c.startMs])).toEqual([
      ['photo', 0],
      ['photo', 10_000],
      ['video', 15_000],
    ]);
    expect(s.clips[2].transition?.mode).toBe('replace');
    expect(s.animateRun).toBeNull();
    expect(s.toasts.at(-1)).toMatchObject({ tone: 'ok', title: '1 of 2 transitions in' });
  });

  it('a landing split mid-run severed its identity, so its photos stay too', () => {
    photosOnTrack(['asset_a', 'asset_b', 'asset_c']);
    const [g1, g2] = runAnimateAll();
    succeed(g1, '/cache/t1.mp4');

    // Split the landed clip (5–10 s): both halves keep `ai` but drop `transition`.
    useEditor.getState().setPlayhead(7500);
    useEditor.getState().splitAtPlayhead();

    succeed(g2, '/cache/t2.mp4');

    const s = useEditor.getState();
    expect(s.clips.map((c) => c.kind)).toEqual(['photo', 'video', 'video', 'photo', 'video']);
    expect(s.clips[4].transition?.mode).toBe('replace');
    expect(s.animateRun).toBeNull();
  });

  it('clamps the playhead to the collapsed reel', () => {
    photosOnTrack(['asset_a', 'asset_b']);
    const [g1] = runAnimateAll();

    useEditor.setState({ playheadMs: 9000 });
    succeed(g1, '/cache/t1.mp4');

    const s = useEditor.getState();
    expect(s.clips.map((c) => [c.kind, c.startMs])).toEqual([['video', 0]]);
    expect(s.playheadMs).toBe(5000);
    // The landing selected the clip that survived, so nothing dangles.
    expect(s.selection).toEqual({ kind: 'clip', clipId: s.clips[0].id });
    expect(s.toasts.at(-1)).toMatchObject({ tone: 'ok', title: '1 transition — pure motion' });
  });

  it('resets a selection standing on a photo the collapse consumed', () => {
    photosOnTrack(['asset_a', 'asset_b', 'asset_c']);
    const [g1, g2] = runAnimateAll();
    const a = useEditor.getState().clips[0];

    succeed(g1, '/cache/t1.mp4');
    useEditor.setState({ selection: { kind: 'clip', clipId: a.id } });
    fail(g2);

    // a left with the collapse (its leg landed); the selection cannot point at a ghost.
    expect(useEditor.getState().clips.some((c) => c.id === a.id)).toBe(false);
    expect(useEditor.getState().selection).toEqual({ kind: 'none' });
  });

  it('resets a cut selection whose pair the collapse consumed', () => {
    photosOnTrack(['asset_a', 'asset_b', 'asset_c']);
    const [g1, g2] = runAnimateAll();
    const [a, b] = useEditor.getState().clips;

    succeed(g1, '/cache/t1.mp4');
    useEditor.setState({ selection: { kind: 'cut', afterClipId: a.id, beforeClipId: b.id } });
    fail(g2);

    expect(useEditor.getState().selection).toEqual({ kind: 'none' });
  });

  it('refuses to start a second run while one is live', () => {
    photosOnTrack(['asset_a', 'asset_b', 'asset_c']);
    runAnimateAll();
    expect(Object.keys(useEditor.getState().generations)).toHaveLength(2);

    useEditor.getState().animateAll();

    // Nothing new was recorded or queued — the run in flight owns the board.
    expect(Object.keys(useEditor.getState().generations)).toHaveLength(2);
    expect(useEditor.getState().animateRun?.legs).toHaveLength(2);
    expect(useEditor.getState().animateQueue).toBeNull();
  });

  it('holds the collapse until the queue has fully drained, not merely emptied', () => {
    photosOnTrack(['asset_a', 'asset_b', 'asset_c']);
    const [g1, g2] = runAnimateAll();
    // Restore the window the queue really passes through: after the last launch it lingers
    // as [] until the next advance nulls it. Every leg going terminal inside that window
    // must not collapse the run early.
    useEditor.setState({ animateQueue: [] });

    succeed(g1, '/cache/t1.mp4');
    fail(g2);

    let s = useEditor.getState();
    expect(s.animateRun).not.toBeNull();
    expect(s.clips.filter((c) => c.kind === 'photo')).toHaveLength(3);

    // The drain itself is then the run's final event.
    useEditor.getState().advanceAnimateQueue();

    s = useEditor.getState();
    expect(s.animateRun).toBeNull();
    expect(s.clips.map((c) => [c.kind, c.startMs])).toEqual([
      ['video', 0],
      ['photo', 5000],
      ['photo', 10_000],
    ]);
  });

  it('a live leg swept by removing its photo still lets the run resolve', () => {
    photosOnTrack(['asset_a', 'asset_b', 'asset_c']);
    const [g1, g2] = runAnimateAll();
    succeed(g1, '/cache/t1.mp4');

    // c leaves the bin while its render runs: the record is deleted outright, so no
    // update will ever arrive for it — the run must resolve rather than stall forever.
    useEditor.getState().removeAsset('asset_c');

    const s = useEditor.getState();
    expect(s.generations[g2]).toBeUndefined();
    expect(cancelGeneration).toHaveBeenCalledWith(g2);
    expect(s.animateRun).toBeNull();
    expect(s.clips.map((c) => [c.kind, c.startMs])).toEqual([
      ['video', 0],
      ['photo', 5000],
    ]);
    expect(s.clips[0].transition?.mode).toBe('replace');
    expect(s.toasts.at(-1)).toMatchObject({ tone: 'ok', title: '1 of 2 transitions in' });
  });

  it('Retry of a failed leg re-registers it as insert, and the collapse waits for it', () => {
    photosOnTrack(['asset_a', 'asset_b', 'asset_c', 'asset_d']);
    const [g1, g2, g3] = runAnimateAll();
    fail(g1);
    succeed(g2, '/cache/t2.mp4');

    // The third leg is still rendering, so the run is open; retry the failed first one.
    useEditor.getState().retryGeneration(g1);
    const retried = useEditor.getState().animateRun!.legs[0].generationId;
    expect(retried).not.toBe(g1);
    expect(useEditor.getState().generations[retried].target).toMatchObject({
      kind: 'cut',
      mode: 'insert',
    });

    succeed(g3, '/cache/t3.mp4');
    // Still open: the retried leg has not landed yet.
    expect(useEditor.getState().animateRun).not.toBeNull();

    succeed(retried, '/cache/t1-retry.mp4');

    const s = useEditor.getState();
    expect(s.clips.map((c) => [c.kind, c.startMs])).toEqual([
      ['video', 0],
      ['video', 5000],
      ['video', 10_000],
    ]);
    expect(s.clips.every((c) => c.transition?.mode === 'replace')).toBe(true);
    expect(s.toasts.at(-1)).toMatchObject({ tone: 'ok', title: '3 transitions — pure motion' });
  });

  it('a retry whose cut is gone resolves the leg by absence instead of stalling', () => {
    photosOnTrack(['asset_a', 'asset_b', 'asset_c']);
    const [g1, g2] = runAnimateAll();
    fail(g1);

    // A video wedges itself between a and b while the retry is being considered — direct
    // state surgery, so the failed record is still there to retry.
    const [a, b, c] = useEditor.getState().clips;
    useEditor.setState({
      clips: [
        a,
        videoClip({ id: 'asset_w', name: 'w.mp4' }, 1000, 5000),
        { ...b, startMs: 6000 },
        { ...c, startMs: 11_000 },
      ],
    });

    useEditor.getState().retryGeneration(g1);
    // Nothing launched and the leg was not swapped: its dismissed record resolves it.
    expect(useEditor.getState().animateRun!.legs[0].generationId).toBe(g1);
    expect(useEditor.getState().generations[g1]).toBeUndefined();

    succeed(g2, '/cache/t2.mp4');

    const s = useEditor.getState();
    expect(s.animateRun).toBeNull();
    // Only c, wholly stood in for by the leg that landed, left the track.
    expect(s.clips.map((x) => [x.kind, x.startMs])).toEqual([
      ['photo', 0],
      ['video', 5000],
      ['photo', 6000],
      ['video', 11_000],
    ]);
    expect(s.toasts.at(-1)).toMatchObject({ tone: 'ok', title: '1 of 2 transitions in' });
  });

  it('a manual mode-less Generate mid-run falls back to insert, never replace', () => {
    photosOnTrack(['asset_a', 'asset_b', 'asset_c', 'asset_d']);
    useEditor.getState().animateAll();

    // Only a|b has launched; c|d is still waiting in the queue when the user generates.
    const clips = useEditor.getState().clips;
    const manual = useEditor.getState().startCutGeneration(clips[2].id, clips[3].id);
    expect(manual).toBeTruthy();
    expect(useEditor.getState().generations[manual!].target).toMatchObject({ mode: 'insert' });
  });

  it('after the run resolves, a fresh cut launch is back on replace', () => {
    photosOnTrack(['asset_a', 'asset_b']);
    const [g1] = runAnimateAll();
    fail(g1);
    expect(useEditor.getState().animateRun).toBeNull();
    expect(useEditor.getState().toasts.at(-1)).toMatchObject({ tone: 'error', title: 'No transitions landed' });

    const [a, b] = useEditor.getState().clips;
    const healed = useEditor.getState().startCutGeneration(a.id, b.id);
    expect(useEditor.getState().generations[healed!].target).toMatchObject({ mode: 'replace' });
  });

  it('an explicit mid-run replace lands, cancels the legs it consumed, and the run resolves', () => {
    photosOnTrack(['asset_a', 'asset_b', 'asset_c']);
    const [g1, g2] = runAnimateAll();
    fail(g1);

    // The user deliberately picks replace for the freed cut and generates by hand.
    const [a, b] = useEditor.getState().clips;
    useEditor.setState({ selection: { kind: 'cut', afterClipId: a.id, beforeClipId: b.id } });
    useEditor.getState().setCutMode('replace');
    const manual = useEditor.getState().startCutGeneration(a.id, b.id);
    expect(useEditor.getState().generations[manual!].target).toMatchObject({ mode: 'replace' });

    succeed(manual!, '/cache/manual.mp4');

    const s = useEditor.getState();
    // The landing consumed a and b, cancelling the b|c leg out from under the run…
    expect(s.generations[g2].status).toBe('cancelled');
    expect(cancelGeneration).toHaveBeenCalledWith(g2);
    // …and the run still resolved, the consumed photos no-ops in its collapse.
    expect(s.animateRun).toBeNull();
    expect(s.clips.map((c) => [c.kind, c.startMs])).toEqual([
      ['video', 0],
      ['photo', 5000],
    ]);
    expect(s.clips[0].transition).toMatchObject({ mode: 'replace' });
  });

  it('a leg whose landing no-oped still counts terminal and keeps its photos', () => {
    photosOnTrack(['asset_a', 'asset_b', 'asset_c']);
    const [g1, g2] = runAnimateAll();

    // a wanders off mid-render, so the a|b cut no longer stands when its render comes home.
    const a = useEditor.getState().clips[0];
    useEditor.getState().moveClipTo(a.id, 30_000);

    succeed(g1, '/cache/t1.mp4');
    expect(useEditor.getState().toasts.at(-1)).toMatchObject({
      title: 'Transition finished, but its clips moved',
    });

    succeed(g2, '/cache/t2.mp4');

    const s = useEditor.getState();
    expect(s.animateRun).toBeNull();
    // Only c, wholly animated, left; a and b both stay — the no-op leg holds them.
    expect(s.clips.map((c) => [c.kind, c.startMs])).toEqual([
      ['photo', 5000],
      ['video', 10_000],
      ['photo', 30_000],
    ]);
    expect(s.clips[1].transition?.mode).toBe('replace');
    expect(s.toasts.at(-1)).toMatchObject({ tone: 'ok', title: '1 of 2 transitions in' });
  });

  it('a run whose every cut was skipped clears silently', async () => {
    // Defensive: unreachable through the UI today, but the collapse must not stall on it.
    useEditor.setState({ animateRun: { legs: [] }, animateQueue: null });
    const before = useEditor.getState().toasts.length;

    await useEditor.getState().cancelGeneration('gen_missing');

    expect(useEditor.getState().animateRun).toBeNull();
    expect(useEditor.getState().toasts).toHaveLength(before);
  });
});

// ------------------------------------------------- placing an asset already in the bin

describe('an asset placed from the bin', () => {
  /** Two photos side by side on the track: a (0–2000) then b (2000–5000). */
  function binPairOnTrack(): [Clip, Clip] {
    const a = photoClip({ id: 'asset_a', name: 'asset_a.jpg' }, 2000, 0);
    const b = photoClip({ id: 'asset_b', name: 'asset_b.jpg' }, 3000, 2000);
    useEditor.setState({ clips: [a, b] });
    return [a, b];
  }

  it('a video placed from the bin lands at its probed length', () => {
    // A length the importer never guesses: the asset carries it because the file was probed
    // once, and nothing would ever correct this clip afterwards — `probeDurations` only
    // patches the clip its own import created.
    useEditor.setState({
      assets: {
        ...useEditor.getState().assets,
        asset_v: {
          id: 'asset_v',
          name: 'walk.mp4',
          kind: 'video',
          path: '/media/walk.mp4',
          src: 'asset:///media/walk.mp4',
          sizeBytes: 4096,
          durationMs: 31_500,
        },
      },
    });

    useEditor.getState().placeAssetOnTimeline('asset_v');

    const [clip] = useEditor.getState().clips;
    expect(clip.durationMs).toBe(31_500);
    expect(clip.name).toBe('walk.mp4');
  });

  it('an insertion between two photos takes their failed generation with it', () => {
    const [a, b] = binPairOnTrack();
    const id = useEditor.getState().startCutGeneration(a.id, b.id);
    emit({
      generationId: id!,
      status: 'failed',
      progress: 0,
      elapsedSecs: 4,
      slow: false,
      error: { title: 'Rate limited', message: 'rate limited', retryable: true },
    });
    expect(useEditor.getState().generations[id!].status).toBe('failed');

    // A third photo landing between them: a→b is no longer a cut, so its chip and its card
    // are gone and a failed render kept on that key would be state with no way out.
    useEditor.getState().placeAssetOnTimeline('asset_c', 1);

    const s = useEditor.getState();
    expect(s.clips.map((c) => c.assetId)).toEqual(['asset_a', 'asset_c', 'asset_b']);
    expect(s.generations[id!]).toBeUndefined();
  });

  it('an id that is not in the bin, or whose file has gone, places nothing', () => {
    binPairOnTrack();
    useEditor.getState().placeAssetOnTimeline('asset_gone');

    // A clip on a missing file could only render as "media offline" and would block the
    // export — the same refusal a generation makes.
    useEditor.setState({
      assets: {
        ...useEditor.getState().assets,
        asset_c: { ...useEditor.getState().assets.asset_c, missing: true },
      },
    });
    useEditor.getState().placeAssetOnTimeline('asset_c');

    expect(useEditor.getState().clips).toHaveLength(2);
  });
});
