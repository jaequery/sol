/**
 * Framing a clip — zoom, crop, rotate, flip — driven through the real UI.
 *
 * Same two stubs as the other `App.*` suites and for the same reason: the Tauri bridge and
 * media decoding are the only things jsdom cannot provide. The store, the inspector, the
 * preview and `lib/transform` underneath are the real thing.
 *
 * What is deliberately asserted here rather than in `lib/transform.test.ts` is the *joins*:
 * that a control writes to the clip, that the clip reaches the preview's DOM as the
 * geometry the exporter will build the same picture from, and that it reaches the export
 * spec at all. The geometry itself — every percentage and every clamp — is a unit test
 * over the pure module, where it belongs.
 *
 * The Transform card and the crop tool are a new surface, so they carry the navigation
 * sweep's own standard here rather than only in `App.navigation.test.tsx`: every test in
 * this file fails on a `console.error` or `console.warn`, because a control that logs on
 * click is a broken control whatever it renders.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { buildExportSpec, useEditor } from './state/store';
import { resetEditor } from './test/harness';
import * as backend from './lib/backend';
import { photoClip, videoClip } from './lib/timeline';
import { IDENTITY_TRANSFORM, type Clip, type MediaAsset } from './types/project';

const STORED_SETTINGS: backend.SettingsView = {
  configured: true,
  cliPath: '/usr/local/bin/higgsfield',
  customModel: '',
  hasApiKey: false,
  apiKeyIdHint: '',
  agents: [],
};

vi.mock('./lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/backend')>()),
  isDesktop: () => true,
  assetSrc: (p: string) => `asset://${p}`,
  getSettings: async () => STORED_SETTINGS,
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  testApiKey: vi.fn(),
  importPaths: vi.fn(async () => ({ imported: [], rejected: [] })),
  loadProject: vi.fn(async () => null),
  readProject: vi.fn(async () => null),
  lastProjectPath: vi.fn(async () => null),
  recentProjects: vi.fn(async () => []),
  saveProject: vi.fn(async () => {}),
  generateAnimation: vi.fn(async () => {}),
  generateImage: vi.fn(async () => {}),
  generateVideo: vi.fn(async () => {}),
  cancelGeneration: vi.fn(async () => {}),
  ffmpegAvailable: async () => true,
  exportTimeline: vi.fn(),
  onGenerationUpdate: async () => () => {},
  onExportProgress: async () => () => {},
  pickMediaFiles: vi.fn(async () => []),
  pickAudioFiles: vi.fn(),
  pickExportPath: vi.fn(),
  revealPath: vi.fn(),
}));

vi.mock('./lib/frames', () => ({
  FRAME_WIDTH: 1280,
  FRAME_HEIGHT: 720,
  renderPhotoJpeg: async (src: string) => `data:image/jpeg;base64,frame-of-${src}`,
  probeVideoDurationMs: async () => 8000,
  probeAudioDurationMs: async (_src: string, fallback: number) => fallback,
}));

function asset(id: string, name: string, kind: 'photo' | 'video'): MediaAsset {
  const path = `/media/${name}`;
  return { id, name, kind, path, src: `asset://${path}`, sizeBytes: 1024, durationMs: 8000 };
}

const PHOTO = asset('a-photo', 'sunrise.jpg', 'photo');
const VIDEO = asset('a-video', 'surf.mp4', 'video');

/** One clip of each kind on the track, the photo first and selected. */
function seed(kind: 'photo' | 'video' = 'photo'): Clip {
  const photo = photoClip(PHOTO, 4000, 0);
  const video = videoClip(VIDEO, 4000, 4000);
  const clip = kind === 'photo' ? photo : video;
  useEditor.setState({
    assets: { [PHOTO.id]: PHOTO, [VIDEO.id]: VIDEO },
    clips: [photo, video],
    selection: { kind: 'clip', clipId: clip.id },
    playheadMs: clip.startMs + 100,
  });
  return clip;
}

async function mount() {
  render(<App />);
  await waitFor(() => expect(useEditor.getState().settings).not.toBeNull());
}

/** The clip as the store holds it now — ids are stable, the objects are not. */
function live(id: string): Clip {
  const clip = useEditor.getState().clips.find((c) => c.id === id);
  if (!clip) throw new Error(`clip ${id} is gone`);
  return clip;
}

/** The Transform card, found by the one title only it has. */
function card(): HTMLElement {
  const title = screen.getByText('Transform');
  const el = title.closest('.card');
  if (!(el instanceof HTMLElement)) throw new Error('the Transform card is not on screen');
  return el;
}

/**
 * The media element the preview is showing right now.
 *
 * Found from the media outwards rather than by asking the canvas for its first layer: the
 * *next* clip is premounted in the same canvas, wearing its own set of layers, so the first
 * one in the DOM is regularly not the one on screen.
 */
function activeMedia(): HTMLElement {
  const video = screen.queryByTestId('preview-video');
  if (video) return video;
  const img = screen.getByTestId('preview-canvas').querySelector('img');
  if (!(img instanceof HTMLElement)) throw new Error('the preview is showing nothing');
  return img;
}

function layer(name: 'pic' | 'zoom'): HTMLElement {
  const el = activeMedia().closest(`.canvas__${name}`);
  if (!(el instanceof HTMLElement)) throw new Error(`the preview has no ${name} layer`);
  return el;
}

const picLayer = () => layer('pic');
const zoomLayer = () => layer('zoom');

/** What the card's Framing row reads — the phrase, not the slider that also says a number. */
function framing(): string {
  return within(card()).getByText('Framing').nextElementSibling?.textContent ?? '';
}

let consoleErrors: unknown[][] = [];

beforeEach(() => {
  resetEditor();
  vi.clearAllMocks();
  consoleErrors = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => void consoleErrors.push(args));
  vi.spyOn(console, 'warn').mockImplementation((...args) => void consoleErrors.push(args));
});

afterEach(() => {
  expect(consoleErrors).toEqual([]);
  vi.restoreAllMocks();
});

describe('the Transform card', () => {
  it('stands on every selected clip, photo and video alike', async () => {
    const photo = seed('photo');
    await mount();

    expect(card()).toBeInTheDocument();
    for (const name of [
      'Rotate left',
      'Rotate right',
      'Flip across',
      'Flip down',
      'Crop',
      'Reset',
    ]) {
      expect(within(card()).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(card()).getByLabelText('Zoom')).toBeInTheDocument();

    // The video half of the ticket: the same card, on the other kind of clip.
    const video = useEditor.getState().clips.find((c) => c.id !== photo.id)!;
    act(() => useEditor.getState().select({ kind: 'clip', clipId: video.id }));
    expect(within(card()).getByRole('button', { name: 'Rotate right' })).toBeInTheDocument();
  });

  it('is not offered when nothing is selected', async () => {
    seed('photo');
    await mount();
    act(() => useEditor.getState().select({ kind: 'none' }));
    expect(screen.queryByText('Transform')).not.toBeInTheDocument();
  });

  it('reads back what has been done to the clip', async () => {
    const clip = seed('photo');
    await mount();
    expect(framing()).toBe('Original');

    const user = userEvent.setup();
    await user.click(within(card()).getByRole('button', { name: 'Rotate right' }));
    await user.click(within(card()).getByRole('button', { name: 'Flip across' }));
    expect(framing()).toBe('90° · flipped across');
    expect(live(clip.id).transform).toMatchObject({ rotation: 90, flipH: true });
  });
});

describe('rotating and flipping', () => {
  it('turns the picture in the preview, and the flip mirrors what is on screen', async () => {
    const clip = seed('photo');
    await mount();
    const user = userEvent.setup();

    // No transform at all until one is asked for: an untouched clip draws as it always did.
    expect(picLayer().style.transform).toBe('');

    await user.click(within(card()).getByRole('button', { name: 'Rotate right' }));
    await user.click(within(card()).getByRole('button', { name: 'Rotate right' }));
    await user.click(within(card()).getByRole('button', { name: 'Flip across' }));

    expect(live(clip.id).transform).toMatchObject({ rotation: 180, flipH: true });
    // Rightmost first: the turn, then the mirror over it.
    expect(picLayer().style.transform).toBe('scale(-1, 1) rotate(180deg)');
  });

  it('turns the other way round, and four turns come back to the start', async () => {
    const clip = seed('video');
    await mount();
    const user = userEvent.setup();

    await user.click(within(card()).getByRole('button', { name: 'Rotate left' }));
    expect(live(clip.id).transform).toMatchObject({ rotation: 270 });

    for (let i = 0; i < 3; i += 1) {
      await user.click(within(card()).getByRole('button', { name: 'Rotate left' }));
    }
    // Back where it started, so the clip carries no transform at all rather than a
    // record full of defaults.
    expect(live(clip.id).transform).toBeUndefined();
  });

  it('shows a flip as a toggle that is on, and turns it off again', async () => {
    const clip = seed('photo');
    await mount();
    const user = userEvent.setup();
    const down = () => within(card()).getByRole('button', { name: 'Flip down' });

    expect(down()).toHaveAttribute('aria-pressed', 'false');
    await user.click(down());
    expect(down()).toHaveAttribute('aria-pressed', 'true');
    expect(picLayer().style.transform).toBe('scale(1, -1) rotate(0deg)');

    await user.click(down());
    expect(down()).toHaveAttribute('aria-pressed', 'false');
    expect(live(clip.id).transform).toBeUndefined();
  });
});

describe('zooming', () => {
  it('pushes the frame into the picture, and offers the pan that makes', async () => {
    const clip = seed('video');
    await mount();

    // At 1× there is nowhere to pan to, so the sliders are not there to be moved.
    expect(within(card()).queryByLabelText('Pan X')).not.toBeInTheDocument();
    expect(zoomLayer().style.transform).toBe('');

    act(() => useEditor.getState().setClipZoom(clip.id, 2));
    expect(within(card()).getByLabelText('Pan X')).toBeInTheDocument();
    expect(zoomLayer().style.transform).toBe('translate(0%, 0%) scale(2)');

    act(() => useEditor.getState().setClipPan(clip.id, 1, -1));
    // +1 gives up the whole right-hand overhang, which means moving the picture left by it.
    expect(zoomLayer().style.transform).toBe('translate(-50%, 50%) scale(2)');
    expect(framing()).toBe('200%');
  });

  it('will not zoom further than the slider goes', async () => {
    const clip = seed('photo');
    await mount();
    act(() => useEditor.getState().setClipZoom(clip.id, 99));
    expect(live(clip.id).transform?.zoom).toBe(4);
    expect(within(card()).getByLabelText('Zoom')).toHaveAttribute('aria-valuetext', '400%');
    expect(framing()).toBe('400%');
  });
});

describe('the crop tool', () => {
  it('opens over the preview, crops by dragging, and closes on Done', async () => {
    const clip = seed('photo');
    await mount();
    const user = userEvent.setup();

    expect(screen.queryByTestId('crop-overlay')).not.toBeInTheDocument();
    await user.click(within(card()).getByRole('button', { name: 'Crop' }));
    expect(screen.getByTestId('crop-overlay')).toBeInTheDocument();
    expect(useEditor.getState().croppingClipId).toBe(clip.id);

    // The rectangle starts as the whole picture.
    expect(screen.getByTestId('crop-rect').style.width).toBe('100%');

    dragHandle('se', -160, -90);
    const cropped = live(clip.id).transform?.crop;
    expect(cropped).toMatchObject({ x: 0, y: 0 });
    expect(cropped!.width).toBeLessThan(1);
    expect(cropped!.height).toBeLessThan(1);
    expect(screen.getByTestId('crop-rect').style.width).toBe(`${cropped!.width * 100}%`);

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('crop-overlay')).not.toBeInTheDocument();
    // The crop it was closed on is the crop it keeps.
    expect(live(clip.id).transform?.crop).toEqual(cropped);
  });

  it('leaves on Escape without taking the crop back', async () => {
    const clip = seed('video');
    await mount();
    const user = userEvent.setup();

    await user.click(within(card()).getByRole('button', { name: 'Crop' }));
    dragHandle('nw', 80, 45);
    const cropped = live(clip.id).transform?.crop;
    expect(cropped!.x).toBeGreaterThan(0);

    await user.keyboard('{Escape}');
    expect(useEditor.getState().croppingClipId).toBeNull();
    expect(live(clip.id).transform?.crop).toEqual(cropped);
  });

  it('cues the playhead into the clip it is cropping', async () => {
    seed('photo');
    await mount();
    const video = useEditor.getState().clips[1];

    // Select the second clip while the playhead is still parked over the first.
    act(() => useEditor.getState().setPlayhead(0));
    act(() => useEditor.getState().beginCrop(video.id));
    expect(useEditor.getState().playheadMs).toBe(video.startMs);
    expect(screen.getByTestId('crop-overlay')).toBeInTheDocument();
  });

  it('closes when the selection moves to another clip', async () => {
    const clip = seed('photo');
    await mount();
    act(() => useEditor.getState().beginCrop(clip.id));
    act(() => useEditor.getState().select({ kind: 'clip', clipId: useEditor.getState().clips[1].id }));
    expect(useEditor.getState().croppingClipId).toBeNull();
  });
});

describe('resetting', () => {
  it('takes every part of the framing back at once, and cannot be pressed before then', async () => {
    const clip = seed('photo');
    await mount();
    const user = userEvent.setup();
    expect(within(card()).getByRole('button', { name: 'Reset' })).toBeDisabled();

    await user.click(within(card()).getByRole('button', { name: 'Rotate right' }));
    act(() => useEditor.getState().setClipZoom(clip.id, 2.5));
    act(() => useEditor.getState().setClipCrop(clip.id, { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }));

    await user.click(within(card()).getByRole('button', { name: 'Reset' }));
    expect(live(clip.id).transform).toBeUndefined();
    expect(framing()).toBe('Original');
    expect(picLayer().style.transform).toBe('');
  });
});

describe('the export spec', () => {
  it('carries the framing of the clips that have one, and nothing for the clips that do not', async () => {
    const clip = seed('photo');
    await mount();

    act(() => useEditor.getState().rotateClip(clip.id, 1));
    act(() => useEditor.getState().setClipZoom(clip.id, 2));
    act(() => useEditor.getState().flipClip(clip.id, 'v'));

    const s = useEditor.getState();
    const spec = buildExportSpec(s.clips, s.assets, s.audioTracks);
    expect(spec.clips[0]).toMatchObject({
      kind: 'photo',
      transform: { ...IDENTITY_TRANSFORM, rotation: 90, zoom: 2, flipV: true },
    });
    expect(spec.clips[1]).not.toHaveProperty('transform');
  });
});

/**
 * Drag one of the rectangle's corners by a number of pixels.
 *
 * jsdom lays nothing out, so the box the drag is measured against reports a zero-sized
 * rect and the component would refuse to move — the size is stubbed here, once, and it is
 * the only fiction in this file. 640×360 is the frame's shape, so a pixel here is a pixel
 * on a real canvas of that size.
 */
function dragHandle(corner: 'nw' | 'ne' | 'sw' | 'se', dx: number, dy: number) {
  const box = screen.getByTestId('crop-rect').parentElement!;
  vi.spyOn(box, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 640,
    bottom: 360,
    width: 640,
    height: 360,
    toJSON: () => ({}),
  });
  const handle = screen.getByTestId(`crop-handle-${corner}`);
  act(() => {
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }));
  });
  act(() => {
    window.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 100 + dx, clientY: 100 + dy }),
    );
  });
  act(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
}
