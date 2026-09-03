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
 *
 * One surface deliberately lives elsewhere: the inspector's **Transform** card and the crop
 * rectangle it opens over the preview are swept in `App.framing.test.tsx`, under the same
 * console gate. They are covered there rather than duplicated here because every one of
 * their controls is only meaningful next to the geometry it produces.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { flushSync } from 'react-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { useEditor } from './state/store';
import { ASPECT_RATIOS } from './lib/aspect';
import { MAX_PHOTO_DURATION_MS } from './types/project';
import { resetEditor } from './test/harness';
import * as backend from './lib/backend';
import type { GenerateInput, GenerationUpdate } from './lib/backend';

const generateAnimation = vi.fn(async (_input: GenerateInput) => {});
const generateImage = vi.fn(async (_input: backend.GenerateImageInput) => {});
let emitGenerationUpdate: (u: GenerationUpdate) => void = () => {};

// Typed, so a test can reach the states the shape allows — `cliPath: null` on a machine
// with no CLI — rather than only the ones this literal happens to inhabit.
const STORED_SETTINGS: backend.SettingsView = {
  configured: true,
  cliPath: '/usr/local/bin/higgsfield',
  customModel: '',
  hasApiKey: false,
  apiKeyIdHint: '',
  // No coding-agent CLI on the imaginary machine these suites run on, so every existing
  // expectation still describes a Higgsfield-only install. Tests that need one add it.
  agents: [],
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
  testApiKey: vi.fn(),
  importPaths: vi.fn(async () => ({ imported: [], rejected: [] })),
  // Persistence is desktop-only and every suite starts from a fresh, empty project.
  loadProject: vi.fn(async () => null),
  readProject: vi.fn(async () => null),
  lastProjectPath: vi.fn(async () => null),
  recentProjects: vi.fn(async () => []),
  newProjectPath: vi.fn(async (name: string) => `/docs/${name}.solcut`),
  createProject: vi.fn(async () => {}),
  saveProject: vi.fn(async () => {}),
  pickProjectSavePath: vi.fn(async () => null),
  pickProjectFile: vi.fn(async () => null),
  generateAnimation: (input: GenerateInput) => generateAnimation(input),
  generateImage: (input: backend.GenerateImageInput) => generateImage(input),
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

/**
 * Press a bin tile the way a browser presses one.
 *
 * A browser reaches a microtask checkpoint after every listener it calls, and that is where
 * React commits the discrete update the press just made — passive effects flushed with it,
 * because the commit is on a sync lane. So the window listeners the track installs for the
 * drag are already in place while the press is still on its way up to `window`, and anything
 * among them that answers `pointerdown` answers the very press that armed the drag. That is
 * SOL-OB53U2: the drag died on arrival in every browser and no test could see it.
 *
 * jsdom runs a whole dispatch in one stack frame and reaches no such checkpoint, so the
 * flush has to be put back by hand. `document` is the one place it can go: below React's
 * container listener, which is what runs the tile's `onPointerDown`, and above the window
 * listeners that press installs. Verified against React 19.2 — it leans on that scheduling,
 * so if this stops discriminating a broken build, suspect a React upgrade first.
 */
async function pressTile(tile: HTMLElement) {
  const flush = () => flushSync(() => {});
  document.addEventListener('pointerdown', flush);
  try {
    await act(async () => fireEvent.pointerDown(tile, { button: 0, clientX: 0, buttons: 1 }));
  } finally {
    document.removeEventListener('pointerdown', flush);
  }
}

/**
 * Carry a bin tile onto the track and let go of it there.
 *
 * The move and the release are dispatched on the track, not on `window` as the other pointer
 * drags in this file are: a bin drag is hit-tested by the pointer's own target, which is the
 * only hit test a harness with no layout can answer. `clientX` is where it is let go.
 */
async function dragTileToTrack(name: string, clientX = 0) {
  const tile = screen.getByLabelText(`Add ${name} to the timeline`);
  const track = screen.getByTestId('timeline-track');
  // One act per event, as the ruler and clip drags in this file are written: the press is
  // what puts the track in charge of the drag, and it has to land before the release does.
  await pressTile(tile);
  // `buttons: 1` is not decoration: a move with nothing held is how the track recognises a
  // release it never saw, and a drag that does not hold the button down is not a drag.
  await act(async () => fireEvent.pointerMove(track, { clientX, buttons: 1 }));
  await act(async () => fireEvent.pointerUp(track, { clientX }));
}

/** A photo in the bin with nothing of it on the track — the state deleting a clip leaves. */
async function binnedPhoto() {
  await dropOnTimeline([file('sunset.jpg', 'image/jpeg')]);
  await screen.findByRole('button', { name: 'sunset.jpg photo clip' });
  act(() => useEditor.getState().deleteSelection());
  expect(useEditor.getState().clips).toHaveLength(0);
}

// ------------------------------------------------------------------------------ title bar

describe('title bar', () => {
  it('every action opens what it names', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('offers no Import of its own — media intake belongs to the bin', async () => {
    await mount();

    // Scoped to the bar and case-blind on purpose: the bin's own affordances are named
    // "Import media" and "import", and this must not start passing by that coincidence.
    const bar = document.querySelector('.titlebar') as HTMLElement;
    // Proves the scope is the real bar and not an empty element, which would make the
    // assertion below pass for the wrong reason.
    expect(within(bar).getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(
      within(bar).queryByRole('button', { name: /import/i }),
      'the bin head keeps a + Import whatever the bin holds — a second copy up here was the redundancy',
    ).toBeNull();

    expect(screen.getByRole('button', { name: 'Import media' })).toBeInTheDocument();
  });

  it('Export MP4 is dark on an empty project and live once there is a clip', async () => {
    await mount();
    expect(screen.getByRole('button', { name: 'Export MP4' })).toBeDisabled();

    await dropOnTimeline([file('a.jpg', 'image/jpeg')]);
    await screen.findByRole('button', { name: 'a.jpg photo clip' });
    expect(screen.getByRole('button', { name: 'Export MP4' })).toBeEnabled();
  });
});

// -------------------------------------------------------------------------- project menu

describe('the project menu', () => {
  it('opens off the project name and offers the three project actions', async () => {
    const user = userEvent.setup();
    await mount();

    const name = screen.getByRole('button', { name: 'Untitled project' });
    expect(name).toHaveAttribute('aria-expanded', 'false');

    await user.click(name);
    const menu = screen.getByRole('group', { name: 'Project' });
    expect(name).toHaveAttribute('aria-expanded', 'true');
    expect(within(menu).getByRole('button', { name: 'New project…' })).toBeEnabled();
    expect(within(menu).getByRole('button', { name: 'Open project…' })).toBeEnabled();
    expect(within(menu).getByRole('button', { name: 'Save as…' })).toBeEnabled();
  });

  it('the name follows the project once it has a file', async () => {
    await mount();
    act(() => useEditor.setState({ projectPath: '/x/beach.solcut' }));

    expect(screen.getByRole('button', { name: 'beach' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Untitled project' })).toBeNull();
  });

  it('closes on Escape, and on the next click landing anywhere else', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(screen.getByRole('button', { name: 'Untitled project' }));
    await act(async () => fireEvent.keyDown(document.body, { key: 'Escape' }));
    expect(screen.queryByRole('group', { name: 'Project' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Untitled project' }));
    await user.click(screen.getByTestId('timeline-track'));
    expect(screen.queryByRole('group', { name: 'Project' })).toBeNull();
  });

  it('regression — a menu item is not a second Import: intake still belongs to the bin', async () => {
    const user = userEvent.setup();
    await mount();

    // The bar's negative test is scoped and case-blind, and the menu renders inside it.
    await user.click(screen.getByRole('button', { name: 'Untitled project' }));
    const bar = document.querySelector('.titlebar') as HTMLElement;
    expect(within(bar).queryByRole('button', { name: /import/i })).toBeNull();
  });
});

// ------------------------------------------------------------------- switch confirmation

describe('the switch confirmation', () => {
  /** Untitled with work on the track: the one state a switch has to ask about. */
  async function askToSwitch(user: ReturnType<typeof userEvent.setup>) {
    await mount();
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg')]);
    await screen.findByRole('button', { name: 'sunset.jpg photo clip' });

    await user.click(screen.getByRole('button', { name: 'Untitled project' }));
    await user.click(screen.getByRole('button', { name: 'New project…' }));
    // Naming it is what starts the switch now: a project is created with a name or not at all.
    await user.type(await screen.findByLabelText('New project'), 'reel');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    return screen.findByRole('dialog', { name: 'Save this project first?' });
  }

  it('every button in it is live, and Cancel leaves the project alone', async () => {
    const user = userEvent.setup();
    const dialog = await askToSwitch(user);

    expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Save as…' })).toBeEnabled();
    await user.click(
      within(dialog).getByRole('button', { name: 'Cancel — keep this project open' }),
    );

    expect(screen.queryByRole('dialog', { name: 'Save this project first?' })).toBeNull();
    expect(useEditor.getState().clips).toHaveLength(1);
  });

  it('regression — Escape is its Cancel too, and closes only it', async () => {
    const user = userEvent.setup();
    await askToSwitch(user);

    await act(async () => fireEvent.keyDown(document.body, { key: 'Escape' }));
    expect(screen.queryByRole('dialog', { name: 'Save this project first?' })).toBeNull();
    expect(useEditor.getState().clips).toHaveLength(1);
  });

  it('regression — the timeline behind it does not hear the keyboard', async () => {
    const user = userEvent.setup();
    await askToSwitch(user);
    const clipId = useEditor.getState().clips[0].id;
    act(() => useEditor.getState().select({ kind: 'clip', clipId }));

    await act(async () => fireEvent.keyDown(document.body, { key: 'Backspace' }));
    expect(useEditor.getState().clips).toHaveLength(1);
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

  it('the press that arms a drag does not also cancel it', async () => {
    await mount();
    await binnedPhoto();
    const assetId = Object.keys(useEditor.getState().assets)[0];

    // The bin arms the drag on the press; the track answers by installing the window
    // listeners that carry it. In a browser both happen inside that one press, in that
    // order — so anything up there that ends a drag on `pointerdown` ends the drag the
    // press just started, and no tile can ever leave the bin (SOL-OB53U2).
    await pressTile(screen.getByLabelText('Add sunset.jpg to the timeline'));

    expect(
      useEditor.getState().draggingAssetId,
      'the press that armed the drag also killed it',
    ).toBe(assetId);
  });

  it('a stray press elsewhere does not cancel a drag already under way', async () => {
    await mount();
    await binnedPhoto();
    const assetId = Object.keys(useEditor.getState().assets)[0];
    const track = screen.getByTestId('timeline-track');

    await pressTile(screen.getByLabelText('Add sunset.jpg to the timeline'));
    await act(async () => fireEvent.pointerMove(track, { clientX: 40, buttons: 1 }));
    // Whatever else a second press means, it is not "throw away what is in the user's hand".
    await act(async () => fireEvent.pointerDown(window, { button: 0 }));

    expect(useEditor.getState().draggingAssetId).toBe(assetId);
  });

  it('a drag that loses its release ends, and drops nothing on the next click', async () => {
    await mount();
    await binnedPhoto();
    const assetId = Object.keys(useEditor.getState().assets)[0];
    const track = screen.getByTestId('timeline-track');

    await pressTile(screen.getByLabelText('Add sunset.jpg to the timeline'));
    await act(async () => fireEvent.pointerMove(track, { clientX: 40, buttons: 1 }));
    // A live drag first, or the rest of this test is satisfied by one that never started.
    expect(useEditor.getState().draggingAssetId).toBe(assetId);
    // The release went missing — let go outside the window, say. The next move carries no
    // held button, which is the only evidence there is that the drag is over.
    await act(async () => fireEvent.pointerMove(track, { clientX: 60, buttons: 0 }));

    expect(useEditor.getState().draggingAssetId).toBeNull();

    // And the click that follows is a click, not the drop of a tile let go minutes ago.
    // There is no undo in this store, so a stale drop would be unrecoverable.
    await act(async () => fireEvent.pointerUp(track, { clientX: 60 }));
    expect(useEditor.getState().clips).toHaveLength(0);
  });

  it('a tile dragged onto the track lands there as a clip', async () => {
    await mount();
    // Deleting a clip used to be a one-way door: the asset stayed in the bin with no way
    // back onto the timeline (QA sweep R6). Dragging it out is that way back.
    await binnedPhoto();

    await dragTileToTrack('sunset.jpg');

    expect(useEditor.getState().clips).toHaveLength(1);
    await screen.findByRole('button', { name: 'sunset.jpg photo clip' });
  });

  it('it lands where it was let go, not on the end of the track', async () => {
    await mount();
    await dropPhotoPair();

    // The one place this suite has to stub geometry: jsdom lays nothing out, so the track
    // reports a zero-width rect and every drop would read as "past the last clip".
    const track = screen.getByTestId('timeline-track');
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 96, width: 1000, height: 96,
      toJSON: () => ({}),
    });

    // A tenth of the way along a 10 s timeline is inside the first clip's front half, so the
    // boundary nearest the pointer is the one before it.
    await dragTileToTrack('cliff.png', 100);

    expect(useEditor.getState().clips.map((c) => c.name)).toEqual([
      'cliff.png',
      'sunset.jpg',
      'cliff.png',
    ]);
  });

  it('a tile let go anywhere but the track adds nothing', async () => {
    await mount();
    await binnedPhoto();
    const assetId = Object.keys(useEditor.getState().assets)[0];
    const tile = screen.getByLabelText('Add sunset.jpg to the timeline');
    const track = screen.getByTestId('timeline-track');

    // Out over the track and back again: changing your mind has to be possible, and a press
    // that never leaves the bin is not a drop either.
    await pressTile(tile);
    // Said out loud, because "nothing landed" is also what a drag that never started looks
    // like: this test has to be watching a live drag change its mind, not a dead one.
    expect(useEditor.getState().draggingAssetId).toBe(assetId);
    await act(async () => fireEvent.pointerMove(track, { clientX: 100, buttons: 1 }));
    await act(async () => fireEvent.pointerMove(tile, { clientX: 0, buttons: 1 }));
    await act(async () => fireEvent.pointerUp(tile, { clientX: 0 }));

    expect(useEditor.getState().clips).toHaveLength(0);
    expect(useEditor.getState().draggingAssetId).toBeNull();
  });

  it('the same tile can be dragged out again — the bin is a source, not a stack', async () => {
    await mount();
    await binnedPhoto();
    const assetId = Object.keys(useEditor.getState().assets)[0];

    await dragTileToTrack('sunset.jpg');
    await dragTileToTrack('sunset.jpg');

    const { clips } = useEditor.getState();
    expect(clips).toHaveLength(2);
    expect(clips.map((c) => c.assetId)).toEqual([assetId, assetId]);
    expect(clips[0].id).not.toBe(clips[1].id);
  });

  it('a sound dragged out lands on its own lane where it was let go', async () => {
    const user = userEvent.setup();
    await mount();
    // Clips first: the drop time is measured off them, and an empty track has no such box.
    await dropPhotoPair();

    mockPick('/media/theme.mp3', 'theme.mp3', 'audio');
    await user.click(screen.getByRole('button', { name: 'Add audio track' }));
    await screen.findByRole('button', { name: 'theme.mp3 audio track' });

    await dragTileToTrack('theme.mp3', 300);

    const { audioTracks } = useEditor.getState();
    expect(audioTracks).toHaveLength(2);
    expect(audioTracks[1].startMs).toBe(3000);
  });

  it('Enter on a focused tile adds it at the playhead', async () => {
    await mount();
    await dropPhotoPair();
    act(() => useEditor.getState().setPlayhead(6000));

    // No pointer anywhere in this test: the drag is a mouse affordance and this is the way
    // through it without one.
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('Add sunset.jpg to the timeline'), {
        key: 'Enter',
      });
    });

    expect(useEditor.getState().clips.map((c) => c.name)).toEqual([
      'sunset.jpg',
      'sunset.jpg',
      'cliff.png',
    ]);
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

// ------------------------------------------------------------------------ compose panel

describe('the create sheet', () => {
  const PROMPT = 'Describe the photo to generate';

  async function open(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Generate a photo or video' }));
    return screen.getByLabelText(PROMPT);
  }

  it('the bin head carries both ways media gets in, and each opens what it names', async () => {
    const user = userEvent.setup();
    await mount();

    vi.mocked(backend.pickMediaFiles).mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: 'Import media' }));
    expect(backend.pickMediaFiles).toHaveBeenCalledTimes(1);

    await open(user);
    expect(screen.getByRole('dialog', { name: 'Generate a photo or video' })).toBeInTheDocument();
  });

  it('the close button and Escape both close it, and neither costs the draft', async () => {
    const user = userEvent.setup();
    await mount();

    const prompt = await open(user);
    await user.type(prompt, 'a lighthouse');
    await user.click(screen.getByRole('button', { name: 'Close the generate panel' }));
    expect(screen.queryByLabelText(PROMPT)).not.toBeInTheDocument();

    await open(user);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByLabelText(PROMPT)).not.toBeInTheDocument();

    await open(user);
    expect(screen.getByLabelText(PROMPT)).toHaveValue('a lighthouse');
  });

  it('Escape closes the innermost layer first, so the panel outlives a dialog', async () => {
    const user = userEvent.setup();
    await mount();

    await open(user);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.getByLabelText(PROMPT)).toBeInTheDocument();
  });

  it('Options discloses two controls and hides them again', async () => {
    const user = userEvent.setup();
    await mount();
    await open(user);

    const toggle = () => screen.getByRole('button', { name: /options/i });
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Image model')).toBeInTheDocument();
    expect(screen.getByLabelText('Aspect ratio')).toBeInTheDocument();

    await user.click(toggle());
    expect(screen.queryByLabelText('Image model')).not.toBeInTheDocument();
  });

  /**
   * The image picker is labelled "Image model" precisely so it can share the screen with
   * the transition picker, which is queried as "Model" by four tests in the flow suite.
   */
  it('its model picker does not answer to the transition picker’s name', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();
    await user.click(
      screen.getByRole('button', { name: 'Select the cut between sunset.jpg and cliff.png' }),
    );
    await open(user);
    await user.click(screen.getByRole('button', { name: /options/i }));

    // Both on screen at once, and each still reachable by its own label.
    expect(screen.getByLabelText('Model')).toBeInTheDocument();
    expect(screen.getByLabelText('Image model')).toBeInTheDocument();
  });

  it('Generate offers nothing it would refuse: empty prompt, or no CLI', async () => {
    const user = userEvent.setup();
    await mount();

    const prompt = await open(user);
    expect(screen.getByRole('button', { name: /generate photo/i })).toBeDisabled();
    await user.type(prompt, 'a lighthouse');
    expect(screen.getByRole('button', { name: /generate photo/i })).toBeEnabled();

    // The same control, on a machine with no CLI, offers nothing.
    await user.click(screen.getByRole('button', { name: 'Close the generate panel' }));
    storedSettings = { ...STORED_SETTINGS, configured: false, cliPath: null };
    await act(async () => {
      await useEditor.getState().loadSettings();
    });
    await open(user);
    expect(screen.getByRole('button', { name: /generate photo/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Open settings →' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });

  /**
   * While the panel is open a photo tile is a toggle, so its remove button has to go:
   * a `<button>` inside a `<button>` is invalid DOM, and the console gate above is what
   * makes that falsifiable rather than a matter of opinion.
   */
  it('a tile is a reference toggle while composing, and its remove button stands down', async () => {
    const user = userEvent.setup();
    await mount();
    mockPick('/photos/a.jpg', 'a.jpg', 'photo');
    await user.click(screen.getByRole('button', { name: 'Import media' }));
    await screen.findByRole('button', { name: 'Remove a.jpg' });

    await open(user);
    expect(screen.queryByRole('button', { name: 'Remove a.jpg' })).not.toBeInTheDocument();
    const tile = screen.getByRole('button', { name: 'Use a.jpg as a reference' });
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    await user.click(tile);
    expect(screen.getByRole('button', { name: 'Use a.jpg as a reference' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Closing hands the tile back its remove button.
    await user.click(screen.getByRole('button', { name: 'Close the generate panel' }));
    expect(screen.getByRole('button', { name: 'Remove a.jpg' })).toBeInTheDocument();
  });
});

// ----------------------------------------------------------------------------- transport

describe('the frame’s shape', () => {
  it('is a live control in the preview’s panel head, offering every ratio', async () => {
    const user = userEvent.setup();
    await mount();
    // The frame only draws itself once there is something in it; empty, the stage shows
    // the drop prompt instead.
    await dropPhotoPair();

    const picker = screen.getByLabelText('Frame aspect ratio');
    expect(picker).toHaveValue('16:9');
    expect(within(picker).getAllByRole('option')).toHaveLength(ASPECT_RATIOS.length);

    await user.selectOptions(picker, '9:16');
    expect(useEditor.getState().aspectRatio).toBe('9:16');
    expect(screen.getByTestId('preview-canvas')).toHaveAttribute('data-aspect', '9:16');
  });

  /**
   * Two controls named "Aspect ratio" could be on screen at once — the create sheet floats
   * over this very panel — and one of them shapes the project while the other shapes a
   * photo being generated. They are named apart so neither answers to the other's name.
   */
  it('does not answer to the create sheet’s aspect control’s name', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole('button', { name: 'Generate a photo or video' }));
    await user.click(screen.getByRole('button', { name: /options/i }));

    expect(screen.getByLabelText('Aspect ratio')).toBe(
      document.getElementById('create-image-aspect'),
    );
    expect(screen.getByLabelText('Frame aspect ratio')).toBe(
      document.getElementById('frame-aspect'),
    );
  });
});

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

  it('takes a typed length on a clip and pushes what is behind it along', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();
    await user.click(screen.getByRole('button', { name: 'sunset.jpg photo clip' }));

    const box = screen.getByLabelText(/duration/i);
    expect(box).toHaveValue('5.0');
    await user.clear(box);
    await user.type(box, '12{Enter}');

    const clips = useEditor.getState().clips;
    expect(clips[0].durationMs).toBe(12_000);
    // One track cannot show two clips at once, so the photo behind it moved out of the way.
    expect(clips[1].startMs).toBe(12_000);
    expect(box).toHaveValue('12.0');
  });

  it('clamps a typed length the timeline will not give, and says what stopped it', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();
    await user.click(screen.getByRole('button', { name: 'sunset.jpg photo clip' }));

    const box = screen.getByLabelText(/duration/i);
    await user.clear(box);
    await user.type(box, '900{Enter}');

    expect(useEditor.getState().clips[0].durationMs).toBe(MAX_PHOTO_DURATION_MS);
    expect(box).toHaveValue('600.0');
    expect(screen.getByText(/at most 10 minutes/i)).toBeInTheDocument();
  });

  it('will not take a typed length past the end of a video’s source', async () => {
    const user = userEvent.setup();
    await mount();
    await dropOnTimeline([file('surf.mp4', 'video/mp4')]);
    const clip = await screen.findByRole('button', { name: 'surf.mp4 video clip' });
    // The source length arrives from the probe a moment after the import.
    await waitFor(() =>
      expect(Object.values(useEditor.getState().assets)[0].durationMs).toBe(5000),
    );
    await user.click(clip);

    const box = screen.getByLabelText(/duration/i);
    await user.clear(box);
    await user.type(box, '30{Enter}');

    expect(useEditor.getState().clips[0].durationMs).toBe(5000);
    expect(box).toHaveValue('5.0');
    expect(screen.getByText(/surf\.mp4 runs 5\.0s from here/i)).toBeInTheDocument();
  });

  it('refuses a typed length that is not a length, and puts the box back', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();
    await user.click(screen.getByRole('button', { name: 'sunset.jpg photo clip' }));

    const box = screen.getByLabelText(/duration/i);
    await user.clear(box);
    await user.type(box, 'abc{Enter}');
    expect(useEditor.getState().clips[0].durationMs).toBe(5000);
    expect(box).toHaveValue('5.0');

    // An empty box is the dangerous one — `Number('')` is 0, which would floor the clip.
    await user.clear(box);
    await user.type(box, '{Enter}');
    expect(useEditor.getState().clips[0].durationMs).toBe(5000);
    expect(box).toHaveValue('5.0');
  });

  it('commits a typed length when the box is left, and carries it to no other clip', async () => {
    const user = userEvent.setup();
    await mount();
    await dropPhotoPair();
    await user.click(screen.getByRole('button', { name: 'sunset.jpg photo clip' }));

    const box = screen.getByLabelText(/duration/i);
    await user.clear(box);
    await user.type(box, '9');
    // No Enter: selecting the other photo is what leaves the box.
    await user.click(screen.getByRole('button', { name: 'cliff.png photo clip' }));

    const clips = useEditor.getState().clips;
    expect(clips[0].durationMs).toBe(9000);
    expect(clips[1].durationMs).toBe(5000);
    expect(screen.getByLabelText(/duration/i)).toHaveValue('5.0');
  });

  it('takes a typed length on an audio lane too, without moving the sound', async () => {
    const user = userEvent.setup();
    await mount();
    mockPick('/media/theme.mp3', 'theme.mp3', 'audio');
    await user.click(screen.getByRole('button', { name: 'Add audio track' }));
    await user.click(await screen.findByRole('button', { name: 'theme.mp3 audio track' }));

    const box = screen.getByLabelText(/duration/i);
    await user.clear(box);
    await user.type(box, '3{Enter}');

    const [track] = useEditor.getState().audioTracks;
    expect(track.durationMs).toBe(3000);
    expect(track.startMs).toBe(0);
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

// ------------------------------------------------------- a typed length, on every element

/**
 * Every element type the timeline gives edge handles to, and what it takes to put one on
 * screen and select it.
 *
 * The promise is that a length can be *typed* on any element that can be *dragged* to a
 * length — not on a subset — so this table, rather than one sampled clip, is what the box is
 * proven against. `covers every element the timeline gives edge handles` below fails if an
 * element type grows handles without being added here, and every case in the loop then has
 * to pass for it.
 */
const RESIZABLE = [
  {
    what: 'a clip on the visual track',
    /** What its handles are labelled after: `Resize the end of <subject>`. */
    subject: 'sunset.jpg',
    async place(user: ReturnType<typeof userEvent.setup>) {
      await dropOnTimeline([file('sunset.jpg', 'image/jpeg')]);
      await user.click(await screen.findByRole('button', { name: 'sunset.jpg photo clip' }));
    },
    lengthMs: () => useEditor.getState().clips[0].durationMs,
    /** A length this kind of element will not give, and the wall it answers with. */
    tooLong: { typed: '900', landsMs: MAX_PHOTO_DURATION_MS, wall: /at most 10 minutes/i },
  },
  {
    what: 'a sound on an audio lane',
    subject: 'theme.mp3 audio',
    async place(user: ReturnType<typeof userEvent.setup>) {
      mockPick('/media/theme.mp3', 'theme.mp3', 'audio');
      await user.click(screen.getByRole('button', { name: 'Add audio track' }));
      await user.click(await screen.findByRole('button', { name: 'theme.mp3 audio track' }));
      // The wall is the file's own length, which arrives from the probe just after the
      // import. Found by name, not by index: a case may have put other media on the track.
      await waitFor(() =>
        expect(
          Object.values(useEditor.getState().assets).find((a) => a.name === 'theme.mp3')
            ?.durationMs,
        ).toBe(5000),
      );
    },
    lengthMs: () => useEditor.getState().audioTracks[0].durationMs,
    tooLong: { typed: '30', landsMs: 5000, wall: /theme\.mp3 runs 5\.0s from here/i },
  },
];

/** Drag an edge handle: the track draws at 10 ms per pixel, so 100 px is one second. */
async function dragFromTo(target: Element, fromX: number, toX: number) {
  await act(async () => fireEvent.pointerDown(target, { button: 0, clientX: fromX }));
  await act(async () => fireEvent.pointerMove(window, { clientX: toX }));
  await act(async () => fireEvent.pointerUp(window, { clientX: toX }));
}

describe('a typed length', () => {
  it('covers every element the timeline gives edge handles', async () => {
    const user = userEvent.setup();
    await mount();
    for (const element of RESIZABLE) await element.place(user);

    // Whatever wears a resize handle is something a length can be dragged onto, and this
    // file only proves the box for what `RESIZABLE` lists. The two sets being equal is what
    // makes "any element type, not a subset" a claim that can fail.
    const handled = screen
      .getAllByRole('button', { name: /^Resize the (start|end) of / })
      .map((b) => (b.getAttribute('aria-label') ?? '').replace(/^Resize the (start|end) of /, ''));

    expect(new Set(handled)).toEqual(new Set(RESIZABLE.map((e) => e.subject)));
  });

  describe.each(RESIZABLE)('on $what', (element) => {
    async function selected() {
      const user = userEvent.setup();
      await mount();
      await element.place(user);
      return { user, box: screen.getByLabelText(/duration/i) };
    }

    it('takes the length exactly as typed', async () => {
      const { user, box } = await selected();

      await user.clear(box);
      await user.type(box, '3.25{Enter}');

      // Exactly 3.25 s — not rounded to a tenth, and not snapped to anything nearby.
      expect(element.lengthMs()).toBe(3250);
      expect(box).toHaveValue('3.25');
    });

    it('lands where dragging the end handle lands, from the other side', async () => {
      const { user, box } = await selected();
      const handle = screen.getByRole('button', { name: `Resize the end of ${element.subject}` });

      // Shortening, because it is the one direction every element type has room for: a
      // sound already runs the whole of its file, so there is nothing past its tail to give.
      await dragFromTo(handle, 500, 300);
      const dragged = element.lengthMs();
      expect(dragged).toBe(3000);

      // Back to where it started, then the same length again — typed this time.
      await user.clear(box);
      await user.type(box, '5{Enter}');
      expect(element.lengthMs()).toBe(5000);
      await user.clear(box);
      await user.type(box, '3{Enter}');

      expect(element.lengthMs()).toBe(dragged);
      // And the handle went with it: the box and the drag are one length, not two.
      expect(box).toHaveValue('3.0');
    });

    it('clamps a length it will not give, and retires the note once that length changes', async () => {
      const { user, box } = await selected();

      await user.clear(box);
      await user.type(box, `${element.tooLong.typed}{Enter}`);
      expect(element.lengthMs()).toBe(element.tooLong.landsMs);
      expect(screen.getByText(element.tooLong.wall)).toBeInTheDocument();

      // The note is about the entry that was refused, not about where the element stands
      // now: dragging the handle answers the user, so the wall stops being on screen.
      const handle = screen.getByRole('button', { name: `Resize the end of ${element.subject}` });
      await dragFromTo(handle, 500, 400);
      expect(element.lengthMs()).toBe(element.tooLong.landsMs - 1000);
      expect(screen.queryByText(element.tooLong.wall)).toBeNull();
    });

    it('refuses an entry that is not a length, says so, and leaves the timing alone', async () => {
      const { user, box } = await selected();
      const before = element.lengthMs();

      for (const bad of ['abc', '-3', '0x10']) {
        await user.clear(box);
        await user.type(box, `${bad}{Enter}`);
        expect(element.lengthMs()).toBe(before);
        expect(screen.getByText(`“${bad}” is not a length — type seconds, like 4.5.`))
          .toBeInTheDocument();
      }

      // An empty box is the dangerous one — `Number('')` is 0, which would floor the element
      // — and the one with no entry to quote back.
      await user.clear(box);
      await user.type(box, '{Enter}');
      expect(element.lengthMs()).toBe(before);
      expect(screen.getByText('Type a length in seconds, like 4.5.')).toBeInTheDocument();

      // Typing again is the user answering: the complaint goes as soon as it might be wrong.
      await user.type(box, '2');
      expect(screen.queryByText(/is not a length/)).toBeNull();
      expect(screen.queryByText('Type a length in seconds, like 4.5.')).toBeNull();
    });
  });
});

// ------------------------------------------------------------------------ settings dialog

describe('settings dialog', () => {
  it('opens focused on its first field, takes an edit, and Cancel closes it', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    // The credential is the first thing the dialog asks for, as it was before generation
    // moved to the CLI — the custom model below it is the escape hatch, not the headline.
    expect(screen.getByLabelText('API key ID')).toHaveFocus();

    const field = screen.getByLabelText('Custom model');
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
    expect(within(dialog).getByText('Export blocked')).toBeInTheDocument();
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

  // No button opens the panel any more — the empty timeline's call to action is gone — so
  // this is the store action that button called, the same one the film flow reopens it with.
  async function openWizard() {
    await act(async () => useEditor.getState().openFilmWizard());
    return screen.getByRole('dialog', { name: 'New film from 3 photos' });
  }

  it('photos can be reordered and removed before generating', async () => {
    const user = userEvent.setup();
    await mount();
    await openWizard();
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
    await openWizard();
    vi.mocked(backend.pickMediaFiles).mockResolvedValue([]);

    await user.click(screen.getByRole('button', { name: 'Choose photos' }));
    expect(backend.pickMediaFiles).toHaveBeenCalled();
  });

  it('a refused file is named, and the notice can be dismissed', async () => {
    const user = userEvent.setup();
    await mount();
    await openWizard();
    await dropOnWizard([file('clip.mp4', 'video/mp4')]);

    const notice = await screen.findByRole('alert');
    expect(within(notice).getByText(/clip\.mp4/)).toBeInTheDocument();
    await user.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('the footer Close leaves the panel, and the film keeps its state', async () => {
    const user = userEvent.setup();
    await mount();
    await openWizard();
    await dropOnWizard(photos());

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'New film from 3 photos' })).not.toBeInTheDocument();

    await openWizard();
    // The user's own three photos survive a close; only the last run's complaints do not.
    expect(screen.getByRole('button', { name: 'Generate film' })).toBeEnabled();
  });

  it('regression — reopening after a failure does not show the stale error', async () => {
    const user = userEvent.setup();
    await mount();
    await openWizard();
    // Through the picker rather than a drop: only a path-bearing pick reaches the importer,
    // which is the step being made to fail.
    vi.mocked(backend.pickMediaFiles).mockResolvedValue(['/p/one.jpg', '/p/two.jpg', '/p/three.jpg']);
    await user.click(screen.getByRole('button', { name: 'Choose photos' }));
    await screen.findByRole('button', { name: 'Remove one.jpg' });
    vi.mocked(backend.importPaths).mockRejectedValue(new Error('the disk went away'));

    await user.click(screen.getByRole('button', { name: 'Generate film' }));
    expect(await screen.findByText(/the film could not start/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close the film panel' }));
    await openWizard();
    // The panel is hidden by an early return rather than unmounted, so this used to be the
    // previous attempt's error box, sitting there as if it had just happened.
    expect(screen.queryByText(/the film could not start/i)).not.toBeInTheDocument();
  });

  it('regression — Export film is gone once the film is no longer on the timeline', async () => {
    const user = userEvent.setup();
    await mount();
    await openWizard();
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
    await openWizard();
    await dropOnWizard(photos());
    await user.click(screen.getByRole('button', { name: 'Generate film' }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(2));

    await user.click(await screen.findByRole('button', { name: 'Cancel film' }));
    await waitFor(() => expect(backend.cancelGeneration).toHaveBeenCalled());
  });

  it('Start over clears the run and returns to the picker', async () => {
    const user = userEvent.setup();
    await mount();
    await openWizard();
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
    await act(async () => useEditor.getState().openFilmWizard());
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
