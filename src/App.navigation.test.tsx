/**
 * The navigation and regression sweep: every button and menu in the app, clicked.
 *
 * `App.test.tsx` proves the product's *flows*. This file proves its *controls* — that
 * nothing is a dead click, that no button offers an edit its action will refuse, and that
 * every dialog has a way out. It is deliberately organised by surface rather than by
 * feature, so a control added to a panel has an obvious place to be covered.
 *
 * Every test also fails on a `console.error` or `console.warn`, which is what makes the
 * ticket's "no console errors" criterion falsifiable rather than a matter of opinion.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { useEditor } from './state/store';
import { resetEditor } from './test/harness';
import * as backend from './lib/backend';
import type { GenerateInput, GenerationUpdate } from './lib/backend';

const generateAnimation = vi.fn(async (_input: GenerateInput) => {});
let emitGenerationUpdate: (u: GenerationUpdate) => void = () => {};

const STORED_SETTINGS = {
  configured: true,
  cliPath: '/usr/local/bin/higgsfield',
  customModel: '',
};
let storedSettings = { ...STORED_SETTINGS };
/** Mutable so the browser-only branches are reachable, unlike the hard `true` next door. */
let desktop = true;
let ffmpegProbe: () => Promise<boolean> = async () => true;

// The real module's pure exports (the model registry above all) come through untouched;
// only the pieces that would reach for Tauri are stubbed.
vi.mock('./lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/backend')>()),
  isDesktop: () => desktop,
  assetSrc: (p: string) => `asset://${p}`,
  getSettings: async () => storedSettings,
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  importPaths: vi.fn(async () => ({ imported: [], rejected: [] })),
  // Persistence is desktop-only and every suite starts from a fresh, empty project.
  loadProject: vi.fn(async () => null),
  saveProject: vi.fn(async () => {}),
  generateAnimation: (input: GenerateInput) => generateAnimation(input),
  cancelGeneration: vi.fn(async () => {}),
  ffmpegAvailable: () => ffmpegProbe(),
  exportTimeline: vi.fn(),
  onGenerationUpdate: async (cb: (u: GenerationUpdate) => void) => {
    emitGenerationUpdate = cb;
    return () => {};
  },
  onExportProgress: async () => () => {},
  pickMediaFiles: vi.fn(),
  pickAudioFiles: vi.fn(),
  pickExportPath: vi.fn(),
  revealPath: vi.fn(),
}));

vi.mock('./lib/frames', () => ({
  FRAME_WIDTH: 1280,
  FRAME_HEIGHT: 720,
  renderPhotoJpeg: async (src: string) => `data:image/jpeg;base64,frame-of-${src}`,
  probeVideoDurationMs: async (_src: string, fallback: number) => fallback,
  probeAudioDurationMs: async (_src: string, fallback: number) => fallback,
}));

let consoleErrors: unknown[][] = [];

beforeEach(() => {
  generateAnimation.mockClear();
  storedSettings = { ...STORED_SETTINGS };
  desktop = true;
  ffmpegProbe = async () => true;
  resetEditor();

  consoleErrors = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => void consoleErrors.push(args));
  vi.spyOn(console, 'warn').mockImplementation((...args) => void consoleErrors.push(args));
});

afterEach(() => {
  // A control that logs on click is a broken control, whatever it renders.
  expect(consoleErrors).toEqual([]);
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------------------ helpers

function file(name: string, type: string): File {
  return new File(['binary'], name, { type });
}

async function mount() {
  render(<App />);
  await waitFor(() => expect(useEditor.getState().settings).not.toBeNull());
}

async function dropOnTimeline(files: File[]) {
  const track = screen.getByTestId('timeline-track');
  const dataTransfer = { files, items: files.map(() => ({})), types: ['Files'] };
  await act(async () => {
    fireEvent.dragOver(track, { dataTransfer, clientX: 0 });
    fireEvent.drop(track, { dataTransfer, clientX: 0 });
  });
}

/** Import through the file picker, which — unlike a drop — yields path-bearing assets. */
function mockPick(path: string, name: string, kind: 'photo' | 'video' | 'audio') {
  const picker = kind === 'audio' ? backend.pickAudioFiles : backend.pickMediaFiles;
  vi.mocked(picker).mockResolvedValue([path]);
  vi.mocked(backend.importPaths).mockResolvedValue({
    imported: [{ path, name, kind, sizeBytes: 2048 }],
    rejected: [],
  });
}

async function dropPhotoPair() {
  await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('cliff.png', 'image/png')]);
  await screen.findByRole('button', { name: 'sunset.jpg photo clip' });
}

// ------------------------------------------------------------------------------ title bar

describe('title bar', () => {
  it('every action opens what it names', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(
      screen.queryAllByRole('button', { name: '✦ New film from 3 photos' }),
      'the film panel is opened from the empty timeline, not from the bar',
    ).toHaveLength(1);

    vi.mocked(backend.pickMediaFiles).mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(backend.pickMediaFiles).toHaveBeenCalled();
  });

  it('Export MP4 is dark on an empty project and live once there is a clip', async () => {
    await mount();
    expect(screen.getByRole('button', { name: 'Export MP4' })).toBeDisabled();

    await dropOnTimeline([file('a.jpg', 'image/jpeg')]);
    await screen.findByRole('button', { name: 'a.jpg photo clip' });
    expect(screen.getByRole('button', { name: 'Export MP4' })).toBeEnabled();
  });
});

// ----------------------------------------------------------------------------- media bin

describe('media bin', () => {
  it('the empty state names a place that can actually take a drop', async () => {
    await mount();
    // It used to promise "anywhere", which was false in two directions: the track and the
    // film panel are the only drop targets, and audio is accepted too.
    expect(screen.getByText(/drop photos, videos and audio on the timeline/i)).toBeInTheDocument();
  });

  it('both import affordances reach the picker, and a failed import can be dismissed', async () => {
    const user = userEvent.setup();
    await mount();

    vi.mocked(backend.pickMediaFiles).mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: 'import' }));
    expect(backend.pickMediaFiles).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Import media' }));
    expect(backend.pickMediaFiles).toHaveBeenCalledTimes(2);

    await dropOnTimeline([file('notes.txt', 'text/plain')]);
    const problem = await screen.findByRole('alert');
    await user.click(within(problem).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a tile can be removed, and the bin returns to its first-run state', async () => {
    const user = userEvent.setup();
    await mount();
    await dropOnTimeline([file('a.jpg', 'image/jpeg')]);
    await screen.findByRole('button', { name: 'a.jpg photo clip' });

    await user.click(screen.getByRole('button', { name: 'Remove a.jpg' }));
    expect(useEditor.getState().clips).toHaveLength(0);
    expect(screen.getByText('No media yet')).toBeInTheDocument();
  });
});

// ----------------------------------------------------------------------------- transport

describe('transport', () => {
  it('⏮ and ⏭ move the playhead to each end of the whole timeline', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();

    await user.click(screen.getByRole('button', { name: 'Go to end' }));
    expect(useEditor.getState().playheadMs).toBe(10000);

    await user.click(screen.getByRole('button', { name: 'Go to start' }));
    expect(useEditor.getState().playheadMs).toBe(0);
  });

  it('▶ toggles playback and becomes Pause', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();

    await user.click(screen.getByRole('button', { name: 'Play' }));
    expect(useEditor.getState().playing).toBe(true);
    // Driven by hand: the rAF clock's time origin differs from performance.now() here.
    await user.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(useEditor.getState().playing).toBe(false);
  });

  it('regression — ▶ is live on a project that is only a sound', async () => {
    const user = userEvent.setup();
    await mount();
    mockPick('/media/theme.mp3', 'theme.mp3', 'audio');
    await user.click(screen.getByRole('button', { name: 'Add audio track' }));
    await screen.findByRole('button', { name: 'theme.mp3 audio track' });

    // The button used to measure the visual track alone, so it sat dark over an audio-only
    // project that Space would happily play.
    expect(useEditor.getState().clips).toHaveLength(0);
    const play = screen.getByRole('button', { name: 'Play' });
    expect(play).toBeEnabled();
    await user.click(play);
    expect(useEditor.getState().playing).toBe(true);
  });

  it('regression — the duration readout counts a sound that outlasts the last clip', async () => {
    await mount();
    await dropOnTimeline([file('a.jpg', 'image/jpeg')]);
    await screen.findByRole('button', { name: 'a.jpg photo clip' });
    act(() => {
      useEditor.setState({
        audioTracks: [
          {
            id: 'track-long',
            assetId: Object.keys(useEditor.getState().assets)[0],
            name: 'theme.mp3',
            startMs: 0,
            durationMs: 20000,
            trimStartMs: 0,
            volume: 1,
            muted: false,
          },
        ],
      });
    });
    // 20s of sound under a 5s photo: the film is 20s long, and the readout must say so.
    expect(screen.getByText('00:20.00')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------- timeline toolbar

describe('timeline toolbar', () => {
  it('regression — the inert "Select tool" button is gone', async () => {
    await mount();
    // It carried no onClick and was hard-coded to look active. There is no second tool to
    // pick, so the honest fix was to remove it rather than invent a mode for it.
    expect(screen.queryByRole('button', { name: 'Select tool' })).not.toBeInTheDocument();
  });

  it('regression — ✂ is dark unless the playhead is actually inside a clip', async () => {
    await mount();
    await dropPhotoPair();
    const split = () => screen.getByRole('button', { name: 'Split at playhead' });

    // At 0:00 — where every project starts — the playhead is on a boundary, not inside.
    expect(split()).toBeDisabled();
    expect(split()).toHaveAttribute('title', 'Put the playhead inside a clip to split it');

    act(() => useEditor.getState().setPlayhead(2500));
    expect(split()).toBeEnabled();

    // The far end is a boundary too, and splitting there would make a zero-length clip.
    act(() => useEditor.getState().setPlayhead(10000));
    expect(split()).toBeDisabled();
  });

  it('✂ cuts the clip under the playhead in two', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();
    act(() => useEditor.getState().setPlayhead(2500));

    await user.click(screen.getByRole('button', { name: 'Split at playhead' }));
    expect(useEditor.getState().clips).toHaveLength(3);
  });

  it('regression — 🗑 is dark for a cut, which has nothing to delete', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();
    const bin = () => screen.getByRole('button', { name: 'Delete selection' });

    // An import selects what it just added, so the bin starts live — correctly.
    expect(bin()).toBeEnabled();

    await user.click(
      screen.getByRole('button', { name: 'Select the cut between sunset.jpg and cliff.png' }),
    );
    expect(useEditor.getState().selection.kind).toBe('cut');
    // A cut is a place, not a thing — the store refuses it, so the button must not offer it.
    expect(bin()).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'sunset.jpg photo clip' }));
    expect(bin()).toBeEnabled();
    await user.click(bin());
    expect(useEditor.getState().clips).toHaveLength(1);
  });

  it('Snap reports its own state and flips it', async () => {
    const user = userEvent.setup();
    await mount();
    const snap = () => screen.getByRole('button', { name: 'Snap to edges' });

    expect(snap()).toHaveAttribute('aria-pressed', 'true');
    await user.click(snap());
    expect(snap()).toHaveAttribute('aria-pressed', 'false');
    expect(useEditor.getState().snapping).toBe(false);
  });

  it('the zoom slider rescales the track', async () => {
    await mount();
    const zoom = screen.getByRole('slider', { name: 'Timeline zoom' });
    await act(async () => fireEvent.change(zoom, { target: { value: '12' } }));
    expect(useEditor.getState().pxPerSecond).toBe(12);
  });

  it('♪ Add audio puts a lane at the playhead', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();
    act(() => useEditor.getState().setPlayhead(3000));

    mockPick('/media/theme.mp3', 'theme.mp3', 'audio');
    await user.click(screen.getByRole('button', { name: 'Add audio track' }));
    await screen.findByRole('button', { name: 'theme.mp3 audio track' });
    expect(useEditor.getState().audioTracks[0].startMs).toBe(3000);
  });
});

// ----------------------------------------------------------------- timeline seeking

// The harness zoom is 100 px/s — one pixel is ten milliseconds — so a click at
// clientX N must land the playhead at exactly N × 10 ms (jsdom rects sit at zero).

describe('click-to-seek', () => {
  it('clicking the track seeks the playhead to the clicked time', async () => {
    await mount();
    await dropPhotoPair();
    const before = useEditor.getState().selection;

    // The bare track below the clips, and the open stretch between them, both cue.
    await act(async () => {
      fireEvent.click(screen.getByTestId('timeline-track'), { clientX: 100 });
    });
    expect(useEditor.getState().playheadMs).toBe(1000);

    const gaps = screen.getByTestId('timeline-track').querySelector('.track__clips')!;
    await act(async () => {
      fireEvent.click(gaps, { clientX: 200 });
    });
    expect(useEditor.getState().playheadMs).toBe(2000);

    // Scrubbing is not deselecting (state 7): the import's selection stands untouched.
    expect(useEditor.getState().selection).toEqual(before);
  });

  it('clicking a clip selects it and cues playback at the clicked point', async () => {
    await mount();
    await dropPhotoPair();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'cliff.png photo clip' }), {
        detail: 1,
        clientX: 300,
      });
    });
    const s = useEditor.getState();
    expect(s.selection).toEqual({ kind: 'clip', clipId: s.clips[1].id });
    expect(s.playheadMs).toBe(3000);
  });

  it('a keyboard activation selects a clip without moving the playhead', async () => {
    await mount();
    await dropPhotoPair();
    act(() => useEditor.getState().setPlayhead(1234));

    // Enter on a focused button lands as a click with no coordinates and detail 0.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'cliff.png photo clip' }));
    });
    const s = useEditor.getState();
    expect(s.selection).toEqual({ kind: 'clip', clipId: s.clips[1].id });
    expect(s.playheadMs).toBe(1234);
  });

  it('the ruler is a click-and-drag seek surface', async () => {
    await mount();
    await dropPhotoPair();
    const ruler = screen.getByTestId('timeline-ruler');

    await act(async () => fireEvent.pointerDown(ruler, { button: 0, clientX: 100 }));
    expect(useEditor.getState().playheadMs).toBe(1000);

    // Held down, the pointer scrubs — and past the end it pins to the timeline's end.
    await act(async () => fireEvent.pointerMove(window, { clientX: 200 }));
    expect(useEditor.getState().playheadMs).toBe(2000);
    await act(async () => fireEvent.pointerMove(window, { clientX: 2000 }));
    expect(useEditor.getState().playheadMs).toBe(10000);

    // Released, the pointer is just a pointer again.
    await act(async () => fireEvent.pointerUp(window, { clientX: 2000 }));
    await act(async () => fireEvent.pointerMove(window, { clientX: 100 }));
    expect(useEditor.getState().playheadMs).toBe(10000);
  });

  it('a clip drag still never seeks on release', async () => {
    await mount();
    await dropPhotoPair();
    act(() => useEditor.getState().setPlayhead(1234));

    const clip = screen.getByRole('button', { name: 'sunset.jpg photo clip' });
    await act(async () => fireEvent.pointerDown(clip, { button: 0, clientX: 100 }));
    await act(async () => fireEvent.pointerMove(window, { clientX: 160 }));
    await act(async () => fireEvent.pointerUp(window, { clientX: 160 }));
    // The click the browser fires after a drag is the drag's tail, not a seek.
    await act(async () => {
      fireEvent.click(clip, { detail: 1, clientX: 160 });
    });
    expect(useEditor.getState().playheadMs).toBe(1234);
  });

  it('clicking a sound, or the open stretch of its lane, cues the playhead there', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();
    mockPick('/media/theme.mp3', 'theme.mp3', 'audio');
    await user.click(screen.getByRole('button', { name: 'Add audio track' }));
    const sound = await screen.findByRole('button', { name: 'theme.mp3 audio track' });

    await act(async () => {
      fireEvent.click(sound, { detail: 1, clientX: 300 });
    });
    let s = useEditor.getState();
    expect(s.selection).toEqual({ kind: 'audio', trackId: s.audioTracks[0].id });
    expect(s.playheadMs).toBe(3000);

    const lane = screen.getByTestId('audio-lanes').querySelector('.audio-lane')!;
    await act(async () => {
      fireEvent.click(lane, { clientX: 100 });
    });
    s = useEditor.getState();
    expect(s.playheadMs).toBe(1000);
    // The lane background is seek surface, not a deselect.
    expect(s.selection).toEqual({ kind: 'audio', trackId: s.audioTracks[0].id });
  });
});

// ----------------------------------------------------------------------------- inspector

describe('inspector', () => {
  it('says so when nothing is selected', async () => {
    await mount();
    expect(screen.getByText('Nothing selected')).toBeInTheDocument();
  });

  it('the cut card takes a typed prompt and appends a suggestion', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();
    await user.click(
      screen.getByRole('button', { name: 'Select the cut between sunset.jpg and cliff.png' }),
    );

    const box = screen.getByLabelText(/describe the transition/i);
    await user.clear(box);
    await user.type(box, 'slow dolly in');
    expect(box).toHaveValue('slow dolly in');

    await user.click(screen.getByRole('button', { name: '+ whip pan' }));
    expect(box).toHaveValue('slow dolly in, whip pan');

    await user.click(screen.getByRole('button', { name: /generate transition/i }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalled());
    expect(generateAnimation.mock.calls[0][0].prompt).toBe('slow dolly in, whip pan');
  });

  it('an audio lane can be levelled and muted from the inspector', async () => {
    const user = userEvent.setup();
    await mount();
    mockPick('/media/theme.mp3', 'theme.mp3', 'audio');
    await user.click(screen.getByRole('button', { name: 'Add audio track' }));
    await user.click(await screen.findByRole('button', { name: 'theme.mp3 audio track' }));

    const volume = screen.getByRole('slider', { name: /volume/i });
    await act(async () => fireEvent.change(volume, { target: { value: '0.25' } }));
    expect(useEditor.getState().audioTracks[0].volume).toBeCloseTo(0.25);

    await user.click(screen.getByRole('button', { name: /mute track/i }));
    expect(useEditor.getState().audioTracks[0].muted).toBe(true);
    await user.click(screen.getByRole('button', { name: /unmute track/i }));
    expect(useEditor.getState().audioTracks[0].muted).toBe(false);
  });

  it('a running generation can be cancelled, and a failed one dismissed', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();
    await user.click(
      screen.getByRole('button', { name: 'Select the cut between sunset.jpg and cliff.png' }),
    );
    await user.click(await screen.findByRole('button', { name: /generate transition/i }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalled());
    const id = Object.keys(useEditor.getState().generations)[0];

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(backend.cancelGeneration).toHaveBeenCalledWith(id);

    await act(async () => {
      emitGenerationUpdate({
        generationId: id,
        status: 'failed',
        progress: 0,
        elapsedSecs: 4,
        slow: false,
        error: { title: 'It broke', message: 'the far end said no', retryable: true },
      });
    });
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(useEditor.getState().generations[id]).toBeUndefined();
  });
});

// ------------------------------------------------------------------------ settings dialog

describe('settings dialog', () => {
  it('opens focused on its first field, takes an edit, and Cancel closes it', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    const field = screen.getByLabelText('Custom model');
    expect(field).toHaveFocus();

    await user.type(field, 'wan2_7');
    expect(field).toHaveValue('wan2_7');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('Test connection reports back without saving', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    vi.mocked(backend.testConnection).mockResolvedValue('Connected as ••••7fa2');

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connected as ••••7fa2')).toBeInTheDocument();
    expect(backend.saveSettings).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------- export dialog

describe('export dialog', () => {
  /** Put a path-bearing clip on the track, which is what export requires. */
  async function importablePhoto(user: ReturnType<typeof userEvent.setup>) {
    mockPick('/media/a.jpg', 'a.jpg', 'photo');
    await user.click(screen.getByRole('button', { name: 'Import media' }));
    await screen.findByRole('button', { name: 'a.jpg photo clip' });
  }

  it('regression — the offline block offers no Try again, because retrying cannot help', async () => {
    const user = userEvent.setup();
    await mount();
    // A dropped file has no path on disk, which is exactly the case export refuses.
    await dropOnTimeline([file('a.jpg', 'image/jpeg')]);
    await screen.findByRole('button', { name: 'a.jpg photo clip' });

    await user.click(screen.getByRole('button', { name: 'Export MP4' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export' });
    // Nothing rendered, so it must not claim a render failed.
    expect(within(dialog).getByText('✕ Export blocked')).toBeInTheDocument();
    expect(within(dialog).queryByText(/render did not finish/i)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/has no file on disk/)).toBeInTheDocument();
    // Try again would re-run the same pre-check and re-render the same message.
    expect(within(dialog).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(backend.pickExportPath).not.toHaveBeenCalled();
  });

  it('a render that dies mid-encode does offer Try again', async () => {
    const user = userEvent.setup();
    await mount();
    await importablePhoto(user);
    vi.mocked(backend.pickExportPath).mockResolvedValue('/out/film.mp4');
    vi.mocked(backend.exportTimeline).mockRejectedValue(new Error('encoder gave up'));

    await user.click(screen.getByRole('button', { name: 'Export MP4' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export' });
    expect(await within(dialog).findByRole('button', { name: 'Try again' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Export' })).not.toBeInTheDocument();
  });

  it('regression — dismissing a running render does not let a second one start', async () => {
    const user = userEvent.setup();
    await mount();
    await importablePhoto(user);
    vi.mocked(backend.pickExportPath).mockResolvedValue('/out/film.mp4');
    // Never resolves: the first render is still going when the dialog is dismissed.
    vi.mocked(backend.exportTimeline).mockImplementation(() => new Promise(() => {}));

    await user.click(screen.getByRole('button', { name: 'Export MP4' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));

    // The dialog is gone but ffmpeg is not, so the button must say so rather than start a
    // second encode of the same timeline over a second save dialog.
    const button = screen.getByRole('button', { name: 'Exporting…' });
    expect(button).toBeDisabled();
    expect(backend.pickExportPath).toHaveBeenCalledTimes(1);
  });
});

// --------------------------------------------------------------------------- film wizard

describe('film wizard', () => {
  const photos = () => [
    file('one.jpg', 'image/jpeg'),
    file('two.jpg', 'image/jpeg'),
    file('three.jpg', 'image/jpeg'),
  ];

  async function dropOnWizard(files: File[]) {
    const zone = screen.getByTestId('film-wizard-dropzone');
    const dataTransfer = { files, items: files.map(() => ({})), types: ['Files'] };
    await act(async () => {
      fireEvent.dragOver(zone, { dataTransfer });
      fireEvent.drop(zone, { dataTransfer });
    });
  }

  async function openWizard(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: '✦ New film from 3 photos' }));
    return screen.getByRole('dialog', { name: 'New film from 3 photos' });
  }

  it('photos can be reordered and removed before generating', async () => {
    const user = userEvent.setup();
    await mount();
    await openWizard(user);
    await dropOnWizard(photos());

    await user.click(await screen.findByRole('button', { name: 'Move three.jpg earlier' }));
    await user.click(screen.getByRole('button', { name: 'Move one.jpg later' }));
    await user.click(screen.getByRole('button', { name: 'Remove two.jpg' }));

    expect(screen.getByRole('button', { name: 'Generate film' })).toBeDisabled();
    expect(screen.getByText(/2 of 3 photos chosen/i)).toBeInTheDocument();
  });

  it('Choose photos reaches the desktop picker', async () => {
    const user = userEvent.setup();
    await mount();
    await openWizard(user);
    vi.mocked(backend.pickMediaFiles).mockResolvedValue([]);

    await user.click(screen.getByRole('button', { name: 'Choose photos' }));
    expect(backend.pickMediaFiles).toHaveBeenCalled();
  });

  it('a refused file is named, and the notice can be dismissed', async () => {
    const user = userEvent.setup();
    await mount();
    await openWizard(user);
    await dropOnWizard([file('clip.mp4', 'video/mp4')]);

    const notice = await screen.findByRole('alert');
    expect(within(notice).getByText(/clip\.mp4/)).toBeInTheDocument();
    await user.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('the footer Close leaves the panel, and the film keeps its state', async () => {
    const user = userEvent.setup();
    await mount();
    await openWizard(user);
    await dropOnWizard(photos());

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'New film from 3 photos' })).not.toBeInTheDocument();

    await openWizard(user);
    // The user's own three photos survive a close; only the last run's complaints do not.
    expect(screen.getByRole('button', { name: 'Generate film' })).toBeEnabled();
  });

  it('regression — reopening after a failure does not show the stale error', async () => {
    const user = userEvent.setup();
    await mount();
    await openWizard(user);
    // Through the picker rather than a drop: only a path-bearing pick reaches the importer,
    // which is the step being made to fail.
    vi.mocked(backend.pickMediaFiles).mockResolvedValue(['/p/one.jpg', '/p/two.jpg', '/p/three.jpg']);
    await user.click(screen.getByRole('button', { name: 'Choose photos' }));
    await screen.findByRole('button', { name: 'Remove one.jpg' });
    vi.mocked(backend.importPaths).mockRejectedValue(new Error('the disk went away'));

    await user.click(screen.getByRole('button', { name: 'Generate film' }));
    expect(await screen.findByText(/the film could not start/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close the film panel' }));
    await openWizard(user);
    // The panel is hidden by an early return rather than unmounted, so this used to be the
    // previous attempt's error box, sitting there as if it had just happened.
    expect(screen.queryByText(/the film could not start/i)).not.toBeInTheDocument();
  });

  it('regression — Export film is gone once the film is no longer on the timeline', async () => {
    const user = userEvent.setup();
    await mount();
    await openWizard(user);
    await dropOnWizard(photos());
    await user.click(screen.getByRole('button', { name: 'Generate film' }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(2));

    const ids = Object.keys(useEditor.getState().generations);
    for (const [i, id] of ids.entries()) {
      await act(async () => {
        emitGenerationUpdate({
          generationId: id,
          status: 'succeeded',
          progress: 1,
          elapsedSecs: 30,
          slow: false,
          outputPath: `/cache/leg-${i}.mp4`,
        });
      });
    }

    expect(await screen.findByRole('button', { name: 'Export film' })).toBeInTheDocument();
    expect(screen.getByText(/on the timeline — 2 transitions/i)).toBeInTheDocument();

    // Delete the film's own clips. `assembledClipIds` is written once and never cleared, so
    // the panel used to keep offering an export of a timeline that no longer held the film
    // — a click that reached runExport and returned immediately, showing nothing at all.
    act(() => useEditor.setState({ clips: [] }));

    expect(screen.queryByRole('button', { name: 'Export film' })).not.toBeInTheDocument();
    expect(screen.queryByText(/on the timeline — 0 transitions/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no longer on the timeline/i)).toBeInTheDocument();
  });

  it('a running film can be cancelled from the panel', async () => {
    const user = userEvent.setup();
    await mount();
    await openWizard(user);
    await dropOnWizard(photos());
    await user.click(screen.getByRole('button', { name: 'Generate film' }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(2));

    await user.click(await screen.findByRole('button', { name: 'Cancel film' }));
    await waitFor(() => expect(backend.cancelGeneration).toHaveBeenCalled());
  });

  it('Start over clears the run and returns to the picker', async () => {
    const user = userEvent.setup();
    await mount();
    await openWizard(user);
    await dropOnWizard(photos());
    await user.click(screen.getByRole('button', { name: 'Generate film' }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(2));

    // Both legs have to reach a terminal state: while either is still running the footer
    // offers Cancel film instead.
    for (const id of Object.keys(useEditor.getState().generations)) {
      await act(async () => {
        emitGenerationUpdate({
          generationId: id,
          status: 'failed',
          progress: 0,
          elapsedSecs: 3,
          slow: false,
          error: { title: 'Leg failed', message: 'no', retryable: true },
        });
      });
    }

    await user.click(await screen.findByRole('button', { name: 'Start over' }));
    expect(useEditor.getState().film).toBeNull();
  });
});

// --------------------------------------------------------------------------------- toasts

describe('toasts', () => {
  it('Reveal opens the file and Dismiss clears the notice', async () => {
    const user = userEvent.setup();
    await mount();

    act(() =>
      useEditor.getState().pushToast({
        tone: 'ok',
        title: 'Export complete',
        detail: '/out/film.mp4',
        action: { label: 'Reveal', path: '/out/film.mp4' },
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(backend.revealPath).toHaveBeenCalledWith('/out/film.mp4');
    expect(screen.queryByText('Export complete')).not.toBeInTheDocument();

    act(() => useEditor.getState().pushToast({ tone: 'error', title: 'Something failed' }));
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Something failed')).not.toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------- keyboard

describe('keyboard', () => {
  it('regression — Space activates a focused button instead of the playhead', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();
    vi.mocked(backend.pickAudioFiles).mockResolvedValue([]);

    // The shortcut used to preventDefault Space for every target that was not a field,
    // which suppresses a button's own activation — all 53 buttons, dead under keyboard.
    screen.getByRole('button', { name: 'Add audio track' }).focus();
    await user.keyboard(' ');

    expect(backend.pickAudioFiles).toHaveBeenCalled();
    expect(useEditor.getState().playing).toBe(false);
  });

  it('Space still plays when the focus is not on a control', async () => {
    await mount();
    await dropPhotoPair();

    await act(async () => fireEvent.keyDown(document.body, { code: 'Space' }));
    expect(useEditor.getState().playing).toBe(true);
    await act(async () => fireEvent.keyDown(document.body, { code: 'Space' }));
    expect(useEditor.getState().playing).toBe(false);
  });

  it('Delete removes the selected clip', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();
    await user.click(screen.getByRole('button', { name: 'sunset.jpg photo clip' }));

    await act(async () => fireEvent.keyDown(document.body, { key: 'Delete' }));
    expect(useEditor.getState().clips).toHaveLength(1);
  });

  it('regression — Escape closes the settings dialog from inside one of its fields', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const field = screen.getByLabelText('Custom model');
    await user.click(field);

    // The typing guard used to return before the Escape branch, so Escape did nothing in
    // exactly the place it was needed — with the cursor in a dialog's own field.
    await act(async () => fireEvent.keyDown(field, { key: 'Escape' }));
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('regression — Escape closes one layer at a time, innermost first', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole('button', { name: '✦ New film from 3 photos' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    await act(async () => fireEvent.keyDown(document.body, { key: 'Escape' }));
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
    // The panel underneath is still open: one press, one layer.
    expect(screen.getByRole('dialog', { name: 'New film from 3 photos' })).toBeInTheDocument();

    await act(async () => fireEvent.keyDown(document.body, { key: 'Escape' }));
    expect(screen.queryByRole('dialog', { name: 'New film from 3 photos' })).not.toBeInTheDocument();
  });

  it('regression — Escape is a way out of the export dialog', async () => {
    const user = userEvent.setup();
    await mount();
    await dropOnTimeline([file('a.jpg', 'image/jpeg')]);
    await screen.findByRole('button', { name: 'a.jpg photo clip' });
    await user.click(screen.getByRole('button', { name: 'Export MP4' }));
    await screen.findByRole('dialog', { name: 'Export' });

    await act(async () => fireEvent.keyDown(document.body, { key: 'Escape' }));
    expect(screen.queryByRole('dialog', { name: 'Export' })).not.toBeInTheDocument();
  });

  it('regression — Backspace behind a modal does not delete the clip underneath', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();
    await user.click(screen.getByRole('button', { name: 'sunset.jpg photo clip' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    // With a scrim over the app, the timeline underneath is not what the user is typing at.
    await act(async () => fireEvent.keyDown(document.body, { key: 'Backspace' }));
    expect(useEditor.getState().clips).toHaveLength(2);
  });

  it('the film panel is non-modal, so the editor keeps its shortcuts', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();
    await user.click(screen.getByRole('button', { name: 'sunset.jpg photo clip' }));
    // With clips down, the empty timeline's call to action is gone, so the panel is opened
    // the way the film flow itself reopens it.
    await act(async () => useEditor.getState().openFilmWizard());
    expect(screen.getByRole('dialog', { name: 'New film from 3 photos' })).toBeInTheDocument();

    await act(async () => fireEvent.keyDown(document.body, { key: 'Delete' }));
    expect(useEditor.getState().clips).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------ settings loading

describe('settings loading', () => {
  it('regression — a failed ffmpeg probe does not report a configured app as unconfigured', async () => {
    ffmpegProbe = async () => {
      throw new Error('which: no ffmpeg');
    };
    // Both awaits used to sit in one `set()`, so a rejected probe threw the settings away
    // with it: the app reported a configured machine as unconfigured and every generate
    // path gated off. (The title bar no longer shows credential state — the Settings
    // dialog and the generate-path callouts do — so the store is what to assert on.)
    await mount();

    expect(useEditor.getState().settings?.configured).toBe(true);
    expect(useEditor.getState().ffmpegAvailable).toBe(false);
  });
});
