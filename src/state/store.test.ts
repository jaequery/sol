/**
 * The film and replace-mode cut flows through the real store.
 *
 * Same two stubs as `App.test.tsx` and for the same reason: the Tauri bridge and
 * canvas/media decoding are the only things jsdom cannot provide. The store, `lib/film` and
 * `lib/timeline` underneath are the real thing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditor } from './store';
import { photoClip } from '../lib/timeline';
import { assembleFilm, defaultFilmPrompt, FILM_SEGMENT_DURATION_MS } from '../lib/film';
import { DEFAULT_MODEL_ID, type GenerateInput, type GenerationUpdate } from '../lib/backend';
import type { Clip, MediaAsset } from '../types/project';

const generateAnimation = vi.fn(async (_input: GenerateInput) => {});
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
  }),
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  importPaths: vi.fn(),
  generateAnimation: (input: GenerateInput) => generateAnimation(input),
  cancelGeneration: (id: string) => cancelGeneration(id),
  ffmpegAvailable: async () => true,
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
};

function photo(id: string): MediaAsset {
  return { id, name: `${id}.jpg`, kind: 'photo', path: `/photos/${id}.jpg`, src: `asset:///photos/${id}.jpg`, sizeBytes: 1024 };
}

const PHOTO_IDS = ['asset_a', 'asset_b', 'asset_c'];

beforeEach(() => {
  generateAnimation.mockClear();
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
    cutPrompts: {},
    cutModes: {},
    animateQueue: null,
    animateSubmittingId: null,
    importProblems: [],
    importing: 0,
    toasts: [],
    exportState: null,
    settings: CONNECTED,
    settingsOpen: false,
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
    expect(useEditor.getState().toasts[0]).toMatchObject({ tone: 'error', title: 'Connect Higgsfield first' });
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
      title: 'Transition finished, but its photos moved',
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
