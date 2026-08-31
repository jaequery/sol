/**
 * The ticket's acceptance checks, driven through the real UI.
 *
 * Only the two genuinely non-UI edges are stubbed: the Tauri bridge (`lib/backend`) and
 * canvas/media decoding (`lib/frames`), neither of which jsdom provides. Everything in
 * between — the store, the timeline, the inspector, the cut maths — is the real thing.
 * The Rust side of the same flow is covered by `cargo test -p solcut-higgsfield`.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { buildExportSpec, useEditor } from './state/store';
import { layout } from './lib/timeline';
import { defaultFilmPrompt } from './lib/film';
import { DEFAULT_TRANSITION_PROMPT } from './types/project';
import * as backend from './lib/backend';
import type { GenerateInput, GenerationUpdate } from './lib/backend';

const generateAnimation = vi.fn(async (_input: GenerateInput) => {});
let emitGenerationUpdate: (u: GenerationUpdate) => void = () => {};

/** What the backend reports it has stored. Reset per test; a few of them change it. */
const STORED_SETTINGS: backend.SettingsView = {
  configured: true,
  cliPath: '/usr/local/bin/higgsfield',
  customModel: '',
  hasApiKey: false,
  apiKeyIdHint: '',
};
let storedSettings = { ...STORED_SETTINGS };

// The real module's pure exports (the model registry above all) come through untouched;
// only the pieces that would reach for Tauri are stubbed.
vi.mock('./lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/backend')>()),
  isDesktop: () => true,
  assetSrc: (p: string) => `asset://${p}`,
  getSettings: async () => storedSettings,
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  testApiKey: vi.fn(),
  importPaths: vi.fn(),
  generateAnimation: (input: GenerateInput) => generateAnimation(input),
  cancelGeneration: vi.fn(async () => {}),
  ffmpegAvailable: async () => true,
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

// Canvas rendering and media probing are browser capabilities jsdom lacks. The stub keeps
// the two stills distinguishable so the request can be asserted on.
vi.mock('./lib/frames', () => ({
  FRAME_WIDTH: 1280,
  FRAME_HEIGHT: 720,
  renderPhotoJpeg: async (src: string) => `data:image/jpeg;base64,frame-of-${src}`,
  probeVideoDurationMs: async (_src: string, fallback: number) => fallback,
  probeAudioDurationMs: async (_src: string, fallback: number) => fallback,
}));

function file(name: string, type: string): File {
  return new File(['binary'], name, { type });
}

async function dropOnTimeline(files: File[]) {
  const track = screen.getByTestId('timeline-track');
  const dataTransfer = { files, items: files.map(() => ({})), types: ['Files'] };
  await act(async () => {
    fireEvent.dragOver(track, { dataTransfer, clientX: 0 });
    fireEvent.drop(track, { dataTransfer, clientX: 0 });
  });
}

beforeEach(() => {
  generateAnimation.mockClear();
  storedSettings = { ...STORED_SETTINGS };
  useEditor.setState({
    settings: null,
    connectionMessage: null,
    assets: {},
    clips: [],
    audioTracks: [],
    selection: { kind: 'none' },
    playheadMs: 0,
    playing: false,
    generations: {},
    modelId: backend.DEFAULT_MODEL_ID,
    cutPrompts: {},
    cutModes: {},
    animateQueue: null,
    animateSubmittingId: null,
    film: null,
    filmWizardOpen: false,
    importProblems: [],
    importing: 0,
    toasts: [],
    exportState: null,
    settingsOpen: false,
    snapping: true,
    // 100 px per second makes every drag below exactly 10 ms to the pixel.
    pxPerSecond: 100,
  });
});

describe('acceptance', () => {
  it('1 — a photo and a video dropped on the single timeline both become clips', async () => {
    render(<App />);
    expect(screen.getByText('Drop photos, videos and audio here')).toBeInTheDocument();

    await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('surf.mp4', 'video/mp4')]);

    const photo = await screen.findByRole('button', { name: 'sunset.jpg photo clip' });
    const video = await screen.findByRole('button', { name: 'surf.mp4 video clip' });
    expect(photo).toBeInTheDocument();
    expect(video).toBeInTheDocument();

    // One track: the clips are laid end to end, not stacked on separate lanes.
    const clips = useEditor.getState().clips;
    expect(clips.map((c) => c.kind)).toEqual(['photo', 'video']);
    expect(screen.queryByText('Drop photos, videos and audio here')).not.toBeInTheDocument();
  });

  it('an unsupported file is named and does not stop the rest of the drop', async () => {
    render(<App />);
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('notes.tiff', '')]);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/notes\.tiff/)).toBeInTheDocument();
    expect(useEditor.getState().clips).toHaveLength(1);
  });

});

describe('AI transitions between photos', () => {
  it('1 — dropping two photos grows a ✦ chip on the cut between them', async () => {
    render(<App />);
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('cliff.png', 'image/png')]);

    expect(await screen.findByRole('button', { name: CUT_CHIP })).toBeInTheDocument();
    expect(useEditor.getState().clips.map((c) => c.kind)).toEqual(['photo', 'photo']);
  });

  it('2 — a chip tap only selects; Generate sends A then B with the default prompt', async () => {
    const user = userEvent.setup();
    render(<App />);
    await dropPhotoPair();

    await user.click(screen.getByRole('button', { name: CUT_CHIP }));
    // Selecting is free: nothing is sent until the big button.
    expect(generateAnimation).not.toHaveBeenCalled();
    expect(useEditor.getState().selection.kind).toBe('cut');

    await user.click(await screen.findByRole('button', { name: /generate transition/i }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    const sent = generateAnimation.mock.calls[0][0];
    expect(sent.prompt).toBe(DEFAULT_TRANSITION_PROMPT);
    // Each side of the cut goes out as its own photo's still.
    const srcOf = (name: string) =>
      Object.values(useEditor.getState().assets).find((a) => a.name === name)?.src;
    expect(sent.startFrame).toBe(`data:image/jpeg;base64,frame-of-${srcOf('sunset.jpg')}`);
    expect(sent.endFrame).toBe(`data:image/jpeg;base64,frame-of-${srcOf('cliff.png')}`);

    // The cut has no width on the track, so the chip itself is the progress surface.
    const id = Object.keys(useEditor.getState().generations)[0];
    await act(async () => {
      emitGenerationUpdate({ generationId: id, status: 'running', progress: 0.46, elapsedSecs: 12, slow: false });
    });
    expect(await screen.findByText('◐ 46%')).toBeInTheDocument();
  });

  it('3 — success inserts the transition at the cut as an editable AI video clip', async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await runCutGeneration(user);
    await succeed(id, '/home/u/.cache/solcut/generated/out.mp4');

    const generated = await screen.findByRole('button', { name: /ai-.*\.mp4 video clip/i });
    expect(within(generated).getByText('✦ AI')).toBeInTheDocument();

    const clips = useEditor.getState().clips;
    expect(clips.map((c) => c.kind)).toEqual(['photo', 'video', 'photo']);
    expect(clips[1].transition).toBeTruthy();
    // The cut had no width, so the reel grows by the transition's length.
    expect(clips.reduce((sum, c) => sum + c.durationMs, 0)).toBe(15_000);
    // Its chip is gone — that boundary is no longer photo→photo…
    expect(screen.queryByRole('button', { name: CUT_CHIP })).not.toBeInTheDocument();
    // …and the preview plays the new clip where the cut was.
    act(() => useEditor.getState().setPlayhead(6000));
    expect(await screen.findByTestId('preview-video')).toHaveAttribute(
      'src',
      'asset:///home/u/.cache/solcut/generated/out.mp4',
    );
    // The export spec reads photo, video, photo — the pipeline needs nothing new.
    const spec = buildExportSpec(clips, useEditor.getState().assets);
    expect(spec.clips.map((c) => c.kind)).toEqual(['photo', 'video', 'photo']);
  });

  it('3b — a gap dragged open between the pair keeps its ✦ chip, and the render fills the gap', async () => {
    const user = userEvent.setup();
    render(<App />);
    await dropPhotoPair();

    // The ticket's gesture: the second photo dragged 2 s into the future opens a gap.
    await dragFromTo(
      screen.getByRole('button', { name: 'cliff.png photo clip' }),
      700,
      900,
    );
    expect(useEditor.getState().clips.map((c) => [c.name, c.startMs])).toEqual([
      ['sunset.jpg', 0],
      ['cliff.png', 7000],
    ]);

    // The gap did not kill the affordance: the chip stands, centred in the gap.
    const chip = screen.getByRole('button', { name: CUT_CHIP });
    expect(chip.style.left).toBe('600px');

    await user.click(chip);
    await user.click(await screen.findByRole('button', { name: /generate transition/i }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    // The frames sent are still the pair's own stills — the gap changes nothing upstream.
    const srcOf = (name: string) =>
      Object.values(useEditor.getState().assets).find((a) => a.name === name)?.src;
    expect(generateAnimation.mock.calls[0][0].startFrame).toContain(`frame-of-${srcOf('sunset.jpg')}`);
    expect(generateAnimation.mock.calls[0][0].endFrame).toContain(`frame-of-${srcOf('cliff.png')}`);

    await succeed(Object.keys(useEditor.getState().generations)[0]);

    // The 5 s render starts where sunset.jpg ends, consumes the 2 s gap, and cliff.png
    // comes to rest flush against its tail — continuous film, no black left behind.
    const clips = useEditor.getState().clips;
    expect(clips.map((c) => [c.kind, c.startMs])).toEqual([
      ['photo', 0],
      ['video', 5000],
      ['photo', 10_000],
    ]);
    expect(clips[1].transition).toBeTruthy();
    expect(screen.queryByRole('button', { name: CUT_CHIP })).not.toBeInTheDocument();
  });

  it('4 — a failure turns the chip rose and Retry resubmits the same cut', async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await runCutGeneration(user);

    await act(async () => {
      emitGenerationUpdate({
        generationId: id,
        status: 'failed',
        progress: 0,
        elapsedSecs: 4,
        slow: false,
        error: { title: 'Rate limited', message: 'rate limited', retryable: true, build: '0.1.0+abc123def' },
      });
    });

    expect(await screen.findByText('✕ FAILED')).toBeInTheDocument();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Rate limited')).toBeInTheDocument();
    // The report names the backend build that produced it — a failure from a stale
    // process must not read as one from the current build.
    expect(within(alert).getByText('SolCut backend 0.1.0+abc123def')).toBeInTheDocument();

    generateAnimation.mockClear();
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    expect(generateAnimation.mock.calls[0][0].prompt).toBe(DEFAULT_TRANSITION_PROMPT);

    // Retry rebuilt the same target — the failed record itself was dismissed.
    const s = useEditor.getState();
    const gens = Object.values(s.generations);
    expect(gens).toHaveLength(1);
    expect(gens[0].target).toMatchObject({
      kind: 'cut',
      afterClipId: s.clips[0].id,
      beforeClipId: s.clips[1].id,
    });
  });

  it('5 — Animate all fills every cut, one submission at a time', async () => {
    const user = userEvent.setup();
    render(<App />);
    await dropOnTimeline(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].map((n) => file(n, 'image/jpeg')));
    await screen.findByRole('button', { name: 'a.jpg photo clip' });
    await waitFor(() => expect(useEditor.getState().settings?.configured).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Animate all cuts' }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    // The next cut waits until the first submission has been accepted by the API.
    await act(async () => {});
    expect(generateAnimation).toHaveBeenCalledTimes(1);

    const [first] = Object.values(useEditor.getState().generations);
    await act(async () => {
      emitGenerationUpdate({ generationId: first.id, status: 'queued', progress: 0, jobId: 'job-1', elapsedSecs: 1, slow: false });
    });
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(2));

    const second = Object.values(useEditor.getState().generations).find((g) => g.id !== first.id)!;
    await act(async () => {
      emitGenerationUpdate({ generationId: second.id, status: 'queued', progress: 0, jobId: 'job-2', elapsedSecs: 1, slow: false });
    });
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(3));

    const targets = Object.values(useEditor.getState().generations).map((g) => g.target);
    expect(targets).toHaveLength(3);
    expect(targets.every((t) => t.kind === 'cut')).toBe(true);
  });

  it('6a — a submission that fails to start does not stall the queue', async () => {
    const user = userEvent.setup();
    generateAnimation.mockImplementationOnce(async () => {
      throw new Error('the backend refused');
    });
    render(<App />);
    await dropOnTimeline(['a.jpg', 'b.jpg', 'c.jpg'].map((n) => file(n, 'image/jpeg')));
    await screen.findByRole('button', { name: 'a.jpg photo clip' });
    await waitFor(() => expect(useEditor.getState().settings?.configured).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Animate all cuts' }));

    // Cut 1's submit blew up before any backend event could exist; cut 2 still goes out.
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(2));
    const statuses = Object.values(useEditor.getState().generations).map((g) => g.status);
    expect(statuses.sort()).toEqual(['failed', 'queued']);
  });

  it('6b — a cut that went ineligible while queued is skipped, not stalled on', async () => {
    const user = userEvent.setup();
    render(<App />);
    await dropOnTimeline(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'].map((n) => file(n, 'image/jpeg')));
    await screen.findByRole('button', { name: 'a.jpg photo clip' });
    await waitFor(() => expect(useEditor.getState().settings?.configured).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Animate all cuts' }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    const [first] = Object.values(useEditor.getState().generations);

    // c.jpg vanishes while a→b submits, invalidating the queued b|c and c|d cuts.
    act(() => {
      const s = useEditor.getState();
      const c = s.clips.find((x) => x.name === 'c.jpg')!;
      useEditor.setState({ selection: { kind: 'clip', clipId: c.id } });
      s.deleteSelection();
    });

    await act(async () => {
      emitGenerationUpdate({ generationId: first.id, status: 'queued', progress: 0, jobId: 'job-1', elapsedSecs: 1, slow: false });
    });
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(2));

    const s = useEditor.getState();
    const d = s.clips.find((x) => x.name === 'd.jpg')!;
    const e = s.clips.find((x) => x.name === 'e.jpg')!;
    const second = Object.values(s.generations).find((g) => g.id !== first.id)!;
    expect(second.target).toMatchObject({ kind: 'cut', afterClipId: d.id, beforeClipId: e.id });
  });

  it('7 — a replaced neighbour marks it stale; Regenerate uses the current neighbours', async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await runCutGeneration(user);
    await succeed(id);

    // The right photo is swapped for a different clip after the render landed — a split,
    // a re-import, or a reorder all read the same way: not the clip it was made from.
    act(() => {
      const s = useEditor.getState();
      const b = s.clips[2];
      useEditor.setState({
        clips: s.clips.map((c) => (c.id === b.id ? { ...c, id: 'clip_replacement' } : c)),
      });
    });
    expect(await screen.findByText('⟳ SOURCES CHANGED')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /ai-.*\.mp4 video clip/i }));
    generateAnimation.mockClear();
    await user.click(await screen.findByRole('button', { name: /regenerate transition/i }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    // The still of whatever stands there NOW went out.
    const srcOf = (name: string) =>
      Object.values(useEditor.getState().assets).find((a) => a.name === name)?.src;
    expect(generateAnimation.mock.calls[0][0].endFrame).toBe(
      `data:image/jpeg;base64,frame-of-${srcOf('cliff.png')}`,
    );

    const regen = Object.values(useEditor.getState().generations).find((g) => g.status === 'queued')!;
    await succeed(regen.id, '/home/u/.cache/solcut/generated/tr2.mp4');

    // Swapped in place: same shape, and the staleness tag is gone.
    expect(useEditor.getState().clips.map((c) => c.kind)).toEqual(['photo', 'video', 'photo']);
    expect(screen.queryByText('⟳ SOURCES CHANGED')).not.toBeInTheDocument();
  });

  it('a long-running generation says so instead of leaving the user guessing', async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await runCutGeneration(user);

    act(() =>
      emitGenerationUpdate({
        generationId: id,
        status: 'running',
        progress: 0.62,
        elapsedSecs: 107,
        slow: true,
      }),
    );

    expect(await screen.findByText('Taking longer than usual')).toBeInTheDocument();
  });

  it('8 — removing a neighbour photo mid-flight cancels the render', async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await runCutGeneration(user);

    const cancelGeneration = vi.mocked(backend.cancelGeneration);
    cancelGeneration.mockClear();
    await user.click(screen.getByRole('button', { name: 'Remove cliff.png' }));

    await waitFor(() => expect(cancelGeneration).toHaveBeenCalledWith(id));
    expect(useEditor.getState().generations[id]).toBeUndefined();
  });

  it('9 — a timeline reordered mid-render gets a toast, never a misplaced clip', async () => {
    const user = userEvent.setup();
    render(<App />);
    await dropOnTimeline(['a.jpg', 'b.jpg', 'c.jpg'].map((n) => file(n, 'image/jpeg')));
    await screen.findByRole('button', { name: 'a.jpg photo clip' });

    await user.click(screen.getByRole('button', { name: 'Select the cut between a.jpg and b.jpg' }));
    await user.click(await screen.findByRole('button', { name: /generate transition/i }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    const id = Object.keys(useEditor.getState().generations)[0];

    // While it renders, c.jpg is dragged onto the pair's shared edge, pushing b.jpg away.
    act(() => {
      const s = useEditor.getState();
      s.moveClipTo(s.clips[2].id, 5000);
    });
    await succeed(id);

    const s = useEditor.getState();
    expect(s.clips).toHaveLength(3);
    expect(s.clips.every((c) => c.kind === 'photo')).toBe(true);
    expect(await screen.findByText('Transition finished, but its photos moved')).toBeInTheDocument();
  });

  it('10 — a chip press never scrubs, reorders, or spends', async () => {
    render(<App />);
    await dropPhotoPair();
    act(() => useEditor.getState().setPlayhead(1234));

    const chip = screen.getByRole('button', { name: CUT_CHIP });
    await act(async () => {
      fireEvent.pointerDown(chip, { button: 0, clientX: 300 });
      fireEvent.pointerMove(window, { clientX: 340 });
      fireEvent.pointerUp(window, { clientX: 340 });
    });
    await act(async () => {
      fireEvent.click(chip);
    });

    const s = useEditor.getState();
    expect(s.playheadMs).toBe(1234);
    expect(s.clips.map((c) => c.name)).toEqual(['sunset.jpg', 'cliff.png']);
    expect(s.selection).toEqual({
      kind: 'cut',
      afterClipId: s.clips[0].id,
      beforeClipId: s.clips[1].id,
    });
    expect(generateAnimation).not.toHaveBeenCalled();
  });

  it('11 — with no Higgsfield CLI the cut card explains and nothing is sent', async () => {
    const user = userEvent.setup();
    storedSettings = { ...STORED_SETTINGS, configured: false, cliPath: null };
    render(<App />);
    await dropPhotoPair();

    await user.click(screen.getByRole('button', { name: CUT_CHIP }));
    expect(await screen.findByText('Connect Higgsfield to generate')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /generate transition/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Animate all cuts' })).toBeDisabled();
    expect(generateAnimation).not.toHaveBeenCalled();
  });

  it('12 — a chip whose photo is offline is disabled with the reason', async () => {
    render(<App />);
    await dropPhotoPair();

    act(() => {
      const s = useEditor.getState();
      const cliff = Object.values(s.assets).find((a) => a.name === 'cliff.png')!;
      useEditor.setState({ assets: { ...s.assets, [cliff.id]: { ...cliff, missing: true } } });
    });

    const chip = screen.getByRole('button', { name: CUT_CHIP });
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute('title', expect.stringContaining('re-import'));
  });

  it('13 — splitting a transition keeps AI footage but severs its transition identity', async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await runCutGeneration(user);
    await succeed(id);

    act(() => {
      const s = useEditor.getState();
      s.setPlayhead(7500); // inside the 5s transition sitting at 5000–10000
      s.splitAtPlayhead();
    });

    const clips = useEditor.getState().clips;
    expect(clips).toHaveLength(4);
    expect(clips[1].ai).toBeTruthy();
    expect(clips[2].ai).toBeTruthy();
    expect(clips[1].transition).toBeUndefined();
    expect(clips[2].transition).toBeUndefined();
  });
});

describe('replace-mode transitions', () => {
  /** Select the pair's cut, pick replace, and press Generate. Returns the generation id. */
  async function runReplaceGeneration(user: ReturnType<typeof userEvent.setup>): Promise<string> {
    await dropPhotoPair();
    await user.click(screen.getByRole('button', { name: CUT_CHIP }));
    await user.click(await screen.findByRole('radio', { name: 'Replace the photos' }));
    await user.click(screen.getByRole('button', { name: /generate transition/i }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalled());
    return Object.keys(useEditor.getState().generations)[0];
  }

  it('the cut card offers the choice, defaults to insert, and remembers the pick per cut', async () => {
    const user = userEvent.setup();
    render(<App />);
    await dropPhotoPair();

    await user.click(screen.getByRole('button', { name: CUT_CHIP }));
    const replace = await screen.findByRole('radio', { name: 'Replace the photos' });
    expect(screen.getByRole('radio', { name: 'Insert between photos' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(replace).toHaveAttribute('aria-checked', 'false');

    await user.click(replace);
    expect(replace).toHaveAttribute('aria-checked', 'true');

    // Away to a clip and back: the pick is remembered per cut, like its prompt.
    await user.click(screen.getByRole('button', { name: 'sunset.jpg photo clip' }));
    await user.click(screen.getByRole('button', { name: CUT_CHIP }));
    expect(await screen.findByRole('radio', { name: 'Replace the photos' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Choosing spends nothing.
    expect(generateAnimation).not.toHaveBeenCalled();
  });

  it('success lands the MP4 in place of both photos, wearing both source thumbnails', async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await runReplaceGeneration(user);
    await succeed(id, '/home/u/.cache/solcut/generated/replace.mp4');

    // The two stills left the track; the animated clip holds their whole span.
    const clips = useEditor.getState().clips;
    expect(clips.map((c) => [c.kind, c.startMs])).toEqual([['video', 0]]);
    expect(clips[0].transition).toMatchObject({ mode: 'replace' });
    expect(screen.queryByRole('button', { name: 'sunset.jpg photo clip' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'cliff.png photo clip' })).not.toBeInTheDocument();
    // The photos stay in the media bin to re-drag.
    expect(screen.getByRole('button', { name: 'Remove sunset.jpg' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove cliff.png' })).toBeInTheDocument();

    // Its timeline face: the two source stills side by side, the ✦ AI tag, no video frame.
    const generated = await screen.findByRole('button', { name: /ai-.*\.mp4 video clip/i });
    expect(within(generated).getByText('✦ AI')).toBeInTheDocument();
    const face = screen.getByTestId(`clip-pair-${clips[0].id}`);
    const stills = face.querySelectorAll('img');
    const srcOf = (name: string) =>
      Object.values(useEditor.getState().assets).find((a) => a.name === name)?.src;
    expect(stills).toHaveLength(2);
    expect(stills[0].getAttribute('src')).toBe(srcOf('sunset.jpg'));
    expect(stills[1].getAttribute('src')).toBe(srcOf('cliff.png'));
    expect(generated.querySelector('video')).toBeNull();
    // Both sources stand in the bin, so nothing is worn beyond the tag.
    expect(within(generated).queryByText(/SOURCE/)).not.toBeInTheDocument();
  });

  it('its inspector card shows From/To and regenerates from the bin assets, in place', async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await runReplaceGeneration(user);
    await succeed(id, '/home/u/.cache/solcut/generated/replace.mp4');
    const landed = useEditor.getState().clips[0];

    // The landed clip is selected, so its card is showing: From/To read the bin assets.
    expect(screen.getByText('From').parentElement).toHaveTextContent('sunset.jpg');
    expect(screen.getByText('To').parentElement).toHaveTextContent('cliff.png');

    generateAnimation.mockClear();
    await user.click(await screen.findByRole('button', { name: /regenerate transition/i }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    const srcOf = (name: string) =>
      Object.values(useEditor.getState().assets).find((a) => a.name === name)?.src;
    expect(generateAnimation.mock.calls[0][0].startFrame).toBe(
      `data:image/jpeg;base64,frame-of-${srcOf('sunset.jpg')}`,
    );
    expect(generateAnimation.mock.calls[0][0].endFrame).toBe(
      `data:image/jpeg;base64,frame-of-${srcOf('cliff.png')}`,
    );

    const regen = Object.values(useEditor.getState().generations).find(
      (g) => g.status === 'queued',
    )!;
    await succeed(regen.id, '/home/u/.cache/solcut/generated/replace-2.mp4');

    // Swapped over the same clip: id and position kept, new footage behind it.
    const s = useEditor.getState();
    expect(s.clips.map((c) => c.id)).toEqual([landed.id]);
    expect(s.clips[0].startMs).toBe(landed.startMs);
    expect(s.assets[s.clips[0].assetId].path).toBe('/home/u/.cache/solcut/generated/replace-2.mp4');
    expect(s.clips[0].transition).toMatchObject({ mode: 'replace' });
  });
});

describe('the Higgsfield API key', () => {
  /** The stored-credential state the backend reports once a key has been saved. */
  const WITH_KEY = { ...STORED_SETTINGS, hasApiKey: true, apiKeyIdHint: '••••7fa2' };

  it('the dialog asks for both halves of the key, beside the custom model', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));

    expect(screen.getByLabelText('API key ID')).toBeInTheDocument();
    expect(screen.getByLabelText('API key secret')).toBeInTheDocument();
    // Coexisting, not replacing: the custom model box is still there.
    expect(screen.getByLabelText('Custom model')).toBeInTheDocument();
  });

  it('Save sends both halves, and the boxes never show what is stored', async () => {
    const user = userEvent.setup();
    const saveSettings = vi.mocked(backend.saveSettings);
    saveSettings.mockClear();
    storedSettings = { ...WITH_KEY };

    render(<App />);
    await waitFor(() => expect(useEditor.getState().settings?.hasApiKey).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    // A stored key shows only as a mask on the placeholder — never as a value, because
    // the secret does not come back to this window at all.
    const id = screen.getByLabelText('API key ID');
    expect(id).toHaveValue('');
    expect(id).toHaveAttribute('placeholder', '••••7fa2');
    expect(screen.getByLabelText('API key secret')).toHaveAttribute('placeholder', '•••• stored');

    await user.type(id, 'hf-key-id');
    await user.type(screen.getByLabelText('API key secret'), 'hf-key-secret');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyId: 'hf-key-id', apiKeySecret: 'hf-key-secret' }),
    );
  });

  it('Test key proves the credential in the boxes, and reports under its own heading', async () => {
    const user = userEvent.setup();
    const testApiKey = vi.mocked(backend.testApiKey);
    testApiKey.mockClear();
    vi.mocked(backend.saveSettings).mockClear();
    testApiKey.mockResolvedValue({
      ok: true,
      title: 'API key accepted',
      text: 'Higgsfield authenticated the key (210 ms).',
    });

    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    await user.type(screen.getByLabelText('API key ID'), 'typed-id');
    await user.type(screen.getByLabelText('API key secret'), 'typed-secret');
    await user.click(screen.getByRole('button', { name: 'Test key' }));

    // It proves what is in the boxes, not what is on disk — so a key can be checked
    // before it is saved.
    await waitFor(() =>
      expect(testApiKey).toHaveBeenCalledWith(
        expect.objectContaining({ apiKeyId: 'typed-id', apiKeySecret: 'typed-secret' }),
      ),
    );
    expect(await screen.findByText('API key accepted')).toBeInTheDocument();
    expect(vi.mocked(backend.saveSettings)).not.toHaveBeenCalled();
  });

  /** A rejected key is the key's problem, and must not be dressed up as a CLI outage. */
  it('a rejected key says so, and never claims the connection is down', async () => {
    const user = userEvent.setup();
    const testApiKey = vi.mocked(backend.testApiKey);
    testApiKey.mockClear();
    testApiKey.mockResolvedValue({
      ok: false,
      title: 'API key rejected',
      text: 'Higgsfield did not accept this key id and secret: Invalid credentials.',
    });

    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Test key' }));

    expect(await screen.findByText('API key rejected')).toBeInTheDocument();
    expect(screen.getByText(/Invalid credentials/)).toBeInTheDocument();
    expect(screen.queryByText('Could not connect')).not.toBeInTheDocument();
  });

  /** Blank-means-keep would make a stored key permanent; Forget is the way out. */
  it('Forget key offers itself only when one is stored, and removes it on Save', async () => {
    const user = userEvent.setup();
    const saveSettings = vi.mocked(backend.saveSettings);
    saveSettings.mockClear();

    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(screen.queryByRole('button', { name: 'Forget key' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    storedSettings = { ...WITH_KEY };
    act(() => useEditor.setState({ settings: { ...WITH_KEY } }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Forget key' }));

    // Armed, not done: it says what Save will do, and offers itself no more.
    expect(screen.getByText(/removed on/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Forget key' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ forgetApiKey: true }));
  });

  it('typing a new key disarms a pending forget, so the two can never both apply', async () => {
    const user = userEvent.setup();
    const saveSettings = vi.mocked(backend.saveSettings);
    saveSettings.mockClear();
    storedSettings = { ...WITH_KEY };

    render(<App />);
    await waitFor(() => expect(useEditor.getState().settings?.hasApiKey).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Forget key' }));
    await user.type(screen.getByLabelText('API key ID'), 'replacement:secret');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyId: 'replacement:secret', forgetApiKey: false }),
    );
  });

  /** A 30-second round trip behind a button that looks idle reads as a dead control. */
  it('Test key says it is working while the check is in flight', async () => {
    const user = userEvent.setup();
    const testApiKey = vi.mocked(backend.testApiKey);
    testApiKey.mockClear();
    let answer: (check: backend.KeyCheck) => void = () => {};
    testApiKey.mockReturnValue(new Promise((resolve) => (answer = resolve)));

    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Test key' }));

    const working = await screen.findByRole('button', { name: 'Testing…' });
    expect(working).toBeDisabled();

    await act(async () => {
      answer({ ok: true, title: 'API key accepted', text: 'done' });
    });
    expect(await screen.findByRole('button', { name: 'Test key' })).toBeEnabled();
  });

  /** The key renders nothing — the CLI does. A stored key must not unlock generation. */
  it('a stored key does not stand in for the CLI', async () => {
    const user = userEvent.setup();
    storedSettings = { ...WITH_KEY, configured: false, cliPath: null };

    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));

    expect(screen.getByText(backend.CLI_INSTALL)).toBeInTheDocument();
    expect(useEditor.getState().settings?.configured).toBe(false);
  });
});

describe('the Higgsfield connection', () => {
  it('Test connection proves the CLI sign-in and reports it', async () => {
    const user = userEvent.setup();
    const testConnection = vi.mocked(backend.testConnection);
    testConnection.mockClear();
    testConnection.mockResolvedValue(
      'Signed in through the Higgsfield CLI — 22 video models available (91 ms).',
    );

    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(testConnection).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Connection OK')).toBeInTheDocument();
    expect(screen.getByText(/22 video models/)).toBeInTheDocument();
  });

  it("a CLI refusal is reported as a failure, in the CLI's own words", async () => {
    const user = userEvent.setup();
    const testConnection = vi.mocked(backend.testConnection);
    testConnection.mockClear();
    testConnection.mockRejectedValue('No workspace selected. Hint: Run: hf workspace set <workspace_id>');

    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText('Could not connect')).toBeInTheDocument();
    expect(screen.getByText(/workspace set/)).toBeInTheDocument();
  });

  it('with no CLI on the machine the dialog shows the setup commands', async () => {
    const user = userEvent.setup();
    storedSettings = { ...STORED_SETTINGS, configured: false, cliPath: null };

    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));

    expect(screen.getByText(backend.CLI_INSTALL)).toBeInTheDocument();
    expect(screen.getByText(backend.CLI_LOGIN)).toBeInTheDocument();
  });

  it('reopening the dialog shows the custom model that is stored, not a default', async () => {
    const user = userEvent.setup();
    const saveSettings = vi.mocked(backend.saveSettings);
    saveSettings.mockClear();

    // What the backend reports after the user pointed at another catalog model.
    storedSettings = { ...STORED_SETTINGS, customModel: 'wan2_7' };

    render(<App />);
    await waitFor(() => expect(useEditor.getState().settings?.customModel).toBe('wan2_7'));
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    // Seeded once at mount, the field would still read blank — and saving would
    // silently clear the stored model.
    expect(screen.getByLabelText('Custom model')).toHaveValue('wan2_7');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ customModel: 'wan2_7' }));
  });
});

describe('media bin', () => {
  it('a media item can be removed, taking its timeline clips with it', async () => {
    const user = userEvent.setup();
    render(<App />);
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('surf.mp4', 'video/mp4')]);

    expect(await screen.findByRole('button', { name: 'Remove sunset.jpg' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove surf.mp4' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove sunset.jpg' }));

    // Gone from the bin, and gone from the single track it was sitting on.
    expect(screen.queryByRole('button', { name: 'Remove sunset.jpg' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'sunset.jpg photo clip' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'surf.mp4 video clip' })).toBeInTheDocument();

    const state = useEditor.getState();
    expect(Object.values(state.assets).map((a) => a.name)).toEqual(['surf.mp4']);
    expect(state.clips.map((c) => c.name)).toEqual(['surf.mp4']);
    expect(state.selection).toEqual({ kind: 'none' });
    // Nothing failed on the way out.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('emptying the bin returns it to its first-run state', async () => {
    const user = userEvent.setup();
    render(<App />);
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg')]);

    await user.click(await screen.findByRole('button', { name: 'Remove sunset.jpg' }));

    expect(screen.getByText('No media yet')).toBeInTheDocument();
    expect(screen.getByText('Drop photos, videos and audio here')).toBeInTheDocument();
    expect(useEditor.getState().playheadMs).toBe(0);
  });

  it('the import button survives the first import and works on every cycle', async () => {
    const user = userEvent.setup();
    vi.mocked(backend.pickMediaFiles).mockClear();
    render(<App />);

    // Present on an empty bin…
    expect(screen.getByRole('button', { name: 'Import media' })).toBeInTheDocument();

    for (const name of ['take-1.jpg', 'take-2.jpg']) {
      vi.mocked(backend.pickMediaFiles).mockResolvedValue([`/media/${name}`]);
      vi.mocked(backend.importPaths).mockResolvedValue({
        imported: [{ path: `/media/${name}`, name, kind: 'photo', sizeBytes: 1024 }],
        rejected: [],
      });

      await user.click(screen.getByRole('button', { name: 'Import media' }));

      expect(await screen.findByRole('button', { name: `Remove ${name}` })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: `${name} photo clip` })).toBeInTheDocument();
      // …and still present now that the bin has something in it.
      expect(screen.getByRole('button', { name: 'Import media' })).toBeEnabled();

      await user.click(screen.getByRole('button', { name: `Remove ${name}` }));
      expect(screen.queryByRole('button', { name: `Remove ${name}` })).not.toBeInTheDocument();
    }

    expect(backend.pickMediaFiles).toHaveBeenCalledTimes(2);
    expect(useEditor.getState().clips).toEqual([]);
    expect(screen.getByRole('button', { name: 'Import media' })).toBeInTheDocument();
  });
});

describe('direct manipulation on the track', () => {
  it('a clip is dropped anywhere on the track, leaving a gap behind it', async () => {
    render(<App />);
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('surf.mp4', 'video/mp4')]);
    const surf = await screen.findByRole('button', { name: 'surf.mp4 video clip' });

    // Grabbed at 8 s and let go 3 s further along, where there is nothing at all.
    await dragFromTo(surf, 800, 1100);

    const state = useEditor.getState();
    // It landed exactly where it was released, not against the photo's edge.
    expect(state.clips.map((c) => [c.name, c.startMs])).toEqual([
      ['sunset.jpg', 0],
      ['surf.mp4', 8000],
    ]);
    // Nothing else moved and nothing was stretched: the 3 s between them is empty track.
    expect(state.clips.map((c) => c.durationMs)).toEqual([5000, 5000]);
    expect(state.selection).toEqual({ kind: 'clip', clipId: state.clips[1].id });

    // And the preview reads that hole as black rather than as an empty timeline.
    act(() => useEditor.getState().setPlayhead(6500));
    expect(await screen.findByTestId('preview-gap')).toBeInTheDocument();
  });

  it('the snapping aid nudges a drop onto a nearby edge, and can be switched off', async () => {
    const user = userEvent.setup();
    render(<App />);
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('surf.mp4', 'video/mp4')]);
    act(() => useEditor.getState().setPlayhead(8000));

    const surf = await screen.findByRole('button', { name: 'surf.mp4 video clip' });
    // Let go 40 ms past the playhead: near enough that the aid lines it up exactly.
    await dragFromTo(surf, 800, 1104);
    expect(surfClip().startMs).toBe(8000);

    await user.click(screen.getByRole('button', { name: 'Snap to edges' }));

    // The very same 40 ms nudge, with the aid off, lands where it was let go.
    await dragFromTo(
      await screen.findByRole('button', { name: 'surf.mp4 video clip' }),
      800,
      804,
    );
    expect(surfClip().startMs).toBe(8040);
  });

  it('a clip dropped on top of another pushes it aside rather than stacking', async () => {
    render(<App />);
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('surf.mp4', 'video/mp4')]);
    const surf = await screen.findByRole('button', { name: 'surf.mp4 video clip' });

    // Grabbed at 7 s — inside the video — and let go over the first half of the photo.
    await dragFromTo(surf, 700, 100);

    const state = useEditor.getState();
    // One track cannot show two clips at once, so the photo slid clear of the drop.
    expect(state.clips.map((c) => [c.name, c.startMs])).toEqual([
      ['surf.mp4', 0],
      ['sunset.jpg', 5000],
    ]);
    // Nothing changed how long anything is, only where it sits.
    expect(state.clips.map((c) => c.durationMs)).toEqual([5000, 5000]);
    expect(state.selection).toEqual({ kind: 'clip', clipId: state.clips[0].id });
  });

  it('a press that does not travel is still a click, not a reorder', async () => {
    render(<App />);
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('surf.mp4', 'video/mp4')]);
    const surf = await screen.findByRole('button', { name: 'surf.mp4 video clip' });

    await dragFromTo(surf, 700, 702);
    await act(async () => fireEvent.click(surf));

    const state = useEditor.getState();
    expect(state.clips.map((c) => c.name)).toEqual(['sunset.jpg', 'surf.mp4']);
    expect(state.selection).toEqual({ kind: 'clip', clipId: state.clips[1].id });
  });

  it("dragging a clip's end handle restretches it and slides the clips after it", async () => {
    render(<App />);
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('surf.mp4', 'video/mp4')]);
    const handle = await screen.findByRole('button', { name: 'Resize the end of sunset.jpg' });

    await dragFromTo(handle, 500, 700);

    const clips = useEditor.getState().clips;
    expect(clips[0].durationMs).toBe(7000);
    const photo = screen.getByRole('button', { name: 'sunset.jpg photo clip' });
    expect(within(photo).getByText('7.0s')).toBeInTheDocument();
    // Single track, no gaps: the video starts where the photo now ends.
    expect(layout(clips)[1].startMs).toBe(7000);
  });

  it("a video's head handle moves its in-point, and neither edge escapes the source", async () => {
    render(<App />);
    await dropOnTimeline([file('surf.mp4', 'video/mp4')]);
    // The probe put the source's real length on the asset; that is the wall.
    await waitFor(() =>
      expect(Object.values(useEditor.getState().assets)[0].durationMs).toBe(5000),
    );

    const head = await screen.findByRole('button', { name: 'Resize the start of surf.mp4' });
    await dragFromTo(head, 100, 250);

    let clip = useEditor.getState().clips[0];
    expect([clip.trimStartMs, clip.durationMs]).toEqual([1500, 3500]);

    // There are no frames past the end of the file, so pulling the tail does nothing.
    const tail = screen.getByRole('button', { name: 'Resize the end of surf.mp4' });
    await dragFromTo(tail, 100, 600);
    clip = useEditor.getState().clips[0];
    expect([clip.trimStartMs, clip.durationMs]).toEqual([1500, 3500]);

    // Arrow keys do the same job for anyone not using a mouse.
    await act(async () => fireEvent.keyDown(head, { key: 'ArrowLeft', shiftKey: true }));
    clip = useEditor.getState().clips[0];
    expect([clip.trimStartMs, clip.durationMs]).toEqual([500, 4500]);
  });

  it('both edits survive the round trip into the export spec', async () => {
    render(<App />);
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('surf.mp4', 'video/mp4')]);
    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(2));

    await dragFromTo(await screen.findByRole('button', { name: 'Resize the end of sunset.jpg' }), 0, 200);
    await dragFromTo(screen.getByRole('button', { name: 'Resize the start of surf.mp4' }), 0, 150);
    await dragFromTo(screen.getByRole('button', { name: 'surf.mp4 video clip' }), 800, 100);

    const { clips, assets } = useEditor.getState();
    const spec = buildExportSpec(clips, assets);

    // Moved, and both length edits are in the spec ffmpeg is driven from — as is the
    // 1.5 s of empty track the move left in front of the film.
    expect(spec.clips.map((c) => [c.name, c.kind, c.startMs, c.durationMs])).toEqual([
      ['surf.mp4', 'video', 1500, 3500],
      ['sunset.jpg', 'photo', 5000, 7000],
    ]);
    expect(spec.clips[0]).toMatchObject({ trimStartMs: 1500 });
  });
});

describe('audio tracks', () => {
  /** One picker round through the mocked backend: the user chose `path`. */
  function mockAudioPick(path: string, name: string) {
    vi.mocked(backend.pickAudioFiles).mockResolvedValue([path]);
    vi.mocked(backend.importPaths).mockResolvedValue({
      imported: [{ path, name, kind: 'audio', sizeBytes: 2048 }],
      rejected: [],
    });
  }

  it('acceptance — "Add audio track" puts a new lane on the timeline, starting at the playhead', async () => {
    const user = userEvent.setup();
    render(<App />);

    mockAudioPick('/media/theme.mp3', 'theme.mp3');
    await user.click(screen.getByRole('button', { name: 'Add audio track' }));

    // The lane is on screen…
    expect(await screen.findByRole('button', { name: 'theme.mp3 audio track' })).toBeInTheDocument();
    expect(screen.getByTestId('audio-lanes')).toBeInTheDocument();
    // …and it is real state, not just pixels.
    const tracks = useEditor.getState().audioTracks;
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ name: 'theme.mp3', startMs: 0, trimStartMs: 0, muted: false });
    // The sound lands in the media bin like any other import.
    expect(screen.getByRole('button', { name: 'Remove theme.mp3' })).toBeInTheDocument();
  });

  it('a second sound gets a second lane, placed at the playhead', async () => {
    const user = userEvent.setup();
    render(<App />);

    mockAudioPick('/media/theme.mp3', 'theme.mp3');
    await user.click(screen.getByRole('button', { name: 'Add audio track' }));
    await screen.findByRole('button', { name: 'theme.mp3 audio track' });

    act(() => useEditor.setState({ playheadMs: 2000 }));
    mockAudioPick('/media/beat.wav', 'beat.wav');
    await user.click(screen.getByRole('button', { name: 'Add audio track' }));

    expect(await screen.findByRole('button', { name: 'beat.wav audio track' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'theme.mp3 audio track' })).toBeInTheDocument();
    const tracks = useEditor.getState().audioTracks;
    expect(tracks.map((t) => [t.name, t.startMs])).toEqual([
      ['theme.mp3', 0],
      ['beat.wav', 2000],
    ]);
  });

  it('a sound dropped on the timeline gets a lane instead of a place in the clip order', async () => {
    render(<App />);
    await dropOnTimeline([file('theme.mp3', 'audio/mpeg')]);

    expect(await screen.findByRole('button', { name: 'theme.mp3 audio track' })).toBeInTheDocument();
    const state = useEditor.getState();
    expect(state.audioTracks).toHaveLength(1);
    expect(state.clips).toHaveLength(0);
  });

  it('acceptance — an unsupported file type is refused with a named reason, not a crash', async () => {
    const user = userEvent.setup();
    render(<App />);

    vi.mocked(backend.pickAudioFiles).mockResolvedValue(['/media/riff.aiff']);
    vi.mocked(backend.importPaths).mockResolvedValue({
      imported: [],
      rejected: [
        {
          path: '/media/riff.aiff',
          name: 'riff.aiff',
          reason: 'unsupported format. Supported: jpg, mp4, mp3, wav, ogg, flac, aac, m4a',
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Add audio track' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/riff\.aiff/)).toBeInTheDocument();
    expect(within(alert).getByText(/unsupported format/)).toBeInTheDocument();
    expect(useEditor.getState().audioTracks).toHaveLength(0);
    expect(screen.queryByTestId('audio-lanes')).not.toBeInTheDocument();
  });

  it('a selected lane is deleted from the timeline; its media stays in the bin', async () => {
    const user = userEvent.setup();
    render(<App />);
    mockAudioPick('/media/theme.mp3', 'theme.mp3');
    await user.click(screen.getByRole('button', { name: 'Add audio track' }));

    await user.click(await screen.findByRole('button', { name: 'theme.mp3 audio track' }));
    await user.click(screen.getByRole('button', { name: 'Delete selection' }));

    expect(useEditor.getState().audioTracks).toHaveLength(0);
    expect(screen.queryByTestId('audio-lanes')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove theme.mp3' })).toBeInTheDocument();
  });

  it('removing the sound from the bin takes its lane with it', async () => {
    const user = userEvent.setup();
    render(<App />);
    mockAudioPick('/media/theme.mp3', 'theme.mp3');
    await user.click(screen.getByRole('button', { name: 'Add audio track' }));
    await screen.findByRole('button', { name: 'theme.mp3 audio track' });

    await user.click(screen.getByRole('button', { name: 'Remove theme.mp3' }));

    expect(useEditor.getState().audioTracks).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'theme.mp3 audio track' })).not.toBeInTheDocument();
  });

  it('the lane reaches the export spec — and a muted lane stays out of it', async () => {
    const user = userEvent.setup();
    render(<App />);
    mockAudioPick('/media/theme.mp3', 'theme.mp3');
    await user.click(screen.getByRole('button', { name: 'Add audio track' }));
    await screen.findByRole('button', { name: 'theme.mp3 audio track' });

    let s = useEditor.getState();
    expect(buildExportSpec(s.clips, s.assets, s.audioTracks).audio).toEqual([
      { path: '/media/theme.mp3', startMs: 0, trimStartMs: 0, durationMs: 5000, volume: 1 },
    ]);

    await user.click(screen.getByRole('button', { name: 'Mute theme.mp3' }));
    s = useEditor.getState();
    expect(buildExportSpec(s.clips, s.assets, s.audioTracks).audio).toEqual([]);
  });
});

// ---------------------------------------------------------------- helpers

/**
 * A pointer drag. The clip drag listens on the window so it survives the cursor leaving the
 * clip, which is exactly how the events are delivered here.
 */
/** The video clip on the track, whichever place it has been dragged to. */
function surfClip() {
  const clip = useEditor.getState().clips.find((c) => c.name === 'surf.mp4');
  if (!clip) throw new Error('surf.mp4 is not on the timeline');
  return clip;
}

async function dragFromTo(target: Element, fromX: number, toX: number) {
  await act(async () => fireEvent.pointerDown(target, { button: 0, clientX: fromX }));
  await act(async () => fireEvent.pointerMove(window, { clientX: toX }));
  await act(async () => fireEvent.pointerUp(window, { clientX: toX }));
}

describe('the 3-photo film wizard', () => {
  const NO_CLI = {
    configured: false,
    cliPath: null,
    customModel: '',
    hasApiKey: false,
    apiKeyIdHint: '',
  };

  /** The one way in: the empty timeline's own call to action. */
  const entryPoint = () => screen.getByRole('button', { name: '✦ New film from 3 photos' });

  /** Open the panel and wait for the settings load to have landed. */
  async function openWizard(user: ReturnType<typeof userEvent.setup>) {
    render(<App />);
    await waitFor(() => expect(useEditor.getState().settings).not.toBeNull());
    await user.click(entryPoint());
    return screen.getByRole('dialog', { name: 'New film from 3 photos' });
  }

  async function dropOnWizard(files: File[]) {
    const zone = screen.getByTestId('film-wizard-dropzone');
    const dataTransfer = { files, items: files.map(() => ({})), types: ['Files'] };
    await act(async () => {
      fireEvent.dragOver(zone, { dataTransfer });
      fireEvent.drop(zone, { dataTransfer });
    });
  }

  const generateFilm = () => screen.getByRole('button', { name: 'Generate film' });

  /** The still the frame stub makes of one photo, found by the name it was imported under. */
  function stillOf(name: string): string {
    const asset = Object.values(useEditor.getState().assets).find((a) => a.name === name);
    expect(asset, `${name} is in the media bin`).toBeTruthy();
    return `frame-of-${asset?.src}`;
  }

  /** The request that answers for one leg — never arrival order, which is a race. */
  function payloadForLeg(index: number): GenerateInput {
    const id = useEditor.getState().film?.segments[index].generationId;
    const call = generateAnimation.mock.calls.find(([input]) => input.generationId === id);
    expect(call, `leg ${index} was sent`).toBeTruthy();
    return (call as [GenerateInput])[0];
  }

  it('opens from the empty timeline, the one place a first run meets it', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(useEditor.getState().settings).not.toBeNull());
    expect(screen.getAllByRole('button', { name: '✦ New film from 3 photos' })).toHaveLength(1);

    await user.click(entryPoint());
    expect(screen.getByRole('dialog', { name: 'New film from 3 photos' })).toBeInTheDocument();

    // Closing only hides the panel — it is a way out, not a cancel.
    await user.click(screen.getByRole('button', { name: 'Close the film panel' }));
    expect(screen.queryByRole('dialog', { name: 'New film from 3 photos' })).not.toBeInTheDocument();
  });

  it('two photos are not a film, and it says how many are still missing', async () => {
    const user = userEvent.setup();
    await openWizard(user);

    await dropOnWizard([file('one.jpg', 'image/jpeg'), file('two.jpg', 'image/jpeg')]);

    expect(screen.getByText('2 of 3 photos chosen — add 1 more.')).toBeInTheDocument();
    expect(generateFilm()).toBeDisabled();
    expect(generateAnimation).not.toHaveBeenCalled();
  });

  it('a fourth photo is left out, and named with the reason', async () => {
    const user = userEvent.setup();
    await openWizard(user);

    await dropOnWizard([
      file('one.jpg', 'image/jpeg'),
      file('two.jpg', 'image/jpeg'),
      file('three.jpg', 'image/jpeg'),
      file('four.jpg', 'image/jpeg'),
    ]);

    expect(
      screen.getByText('four.jpg — a film takes exactly 3 photos, and three are already chosen'),
    ).toBeInTheDocument();
    // The three that fit are still a film.
    expect(generateFilm()).toBeEnabled();
  });

  it('a video cannot be one of the three photos, and is told so', async () => {
    const user = userEvent.setup();
    await openWizard(user);

    await dropOnWizard([
      file('one.jpg', 'image/jpeg'),
      file('surf.mp4', 'video/mp4'),
      file('two.jpg', 'image/jpeg'),
    ]);

    expect(
      screen.getByText(
        'surf.mp4 — a film is made from three photos — a video cannot be one of them',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('2 of 3 photos chosen — add 1 more.')).toBeInTheDocument();
    expect(generateFilm()).toBeDisabled();
  });

  it('both prompts arrive filled in from the default, and take an edit', async () => {
    const user = userEvent.setup();
    await openWizard(user);
    await dropOnWizard([
      file('one.jpg', 'image/jpeg'),
      file('two.jpg', 'image/jpeg'),
      file('three.jpg', 'image/jpeg'),
    ]);

    const first = screen.getByLabelText('Transition 1 · photo 1 → photo 2');
    const second = screen.getByLabelText('Transition 2 · photo 2 → photo 3');
    expect(first).toHaveValue(defaultFilmPrompt(0));
    expect(second).toHaveValue(defaultFilmPrompt(1));

    await user.clear(first);
    await user.type(first, 'a slow push through the doorway');
    expect(first).toHaveValue('a slow push through the doorway');
    // Editing one leg leaves the other on its default.
    expect(second).toHaveValue(defaultFilmPrompt(1));
  });

  it('with no credential it refuses, points at settings, and sends nothing', async () => {
    const user = userEvent.setup();
    await openWizard(user);
    act(() => useEditor.setState({ settings: NO_CLI }));

    await dropOnWizard([
      file('one.jpg', 'image/jpeg'),
      file('two.jpg', 'image/jpeg'),
      file('three.jpg', 'image/jpeg'),
    ]);

    expect(screen.getByText('Connect Higgsfield to generate')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open settings →' })).toBeInTheDocument();
    expect(generateFilm()).toBeDisabled();

    await user.click(generateFilm());
    expect(generateAnimation).not.toHaveBeenCalled();
    expect(useEditor.getState().film).toBeNull();
  });

  it('generate starts two transitions pairing the photos in the chosen order', async () => {
    const user = userEvent.setup();
    await openWizard(user);
    await dropOnWizard([
      file('one.jpg', 'image/jpeg'),
      file('two.jpg', 'image/jpeg'),
      file('three.jpg', 'image/jpeg'),
    ]);

    // The order is the user's: three.jpg is promoted into the middle before generating.
    await user.click(screen.getByRole('button', { name: 'Move three.jpg earlier' }));
    await user.click(generateFilm());

    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(2));

    const first = payloadForLeg(0);
    const second = payloadForLeg(1);
    expect(first.startFrame).toContain(stillOf('one.jpg'));
    expect(first.endFrame).toContain(stillOf('three.jpg'));
    expect(second.startFrame).toContain(stillOf('three.jpg'));
    expect(second.endFrame).toContain(stillOf('two.jpg'));
    expect(first.prompt).toBe(defaultFilmPrompt(0));
    expect(second.prompt).toBe(defaultFilmPrompt(1));

    // The selector was never touched, so both legs render on the default: Seedance 2.5.
    expect(first.model).toBe('seedance_2_5');
    expect(second.model).toBe(first.model);

    // The photos are inputs, not shots: the track stays empty until the film lands.
    expect(useEditor.getState().clips).toHaveLength(0);
    expect(Object.values(useEditor.getState().assets)).toHaveLength(3);
  });

  it('the model picked in the wizard rides with both legs', async () => {
    const user = userEvent.setup();
    await openWizard(user);
    await dropOnWizard([
      file('one.jpg', 'image/jpeg'),
      file('two.jpg', 'image/jpeg'),
      file('three.jpg', 'image/jpeg'),
    ]);

    await user.selectOptions(screen.getByLabelText('Model'), 'kling-3.0');
    await user.click(generateFilm());

    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(2));
    expect(payloadForLeg(0).model).toBe('kling3_0');
    expect(payloadForLeg(1).model).toBe('kling3_0');
  });

  it('a leg that fails explains itself and offers a retry, and the app stays usable', async () => {
    const user = userEvent.setup();
    await openWizard(user);
    await dropOnWizard([
      file('one.jpg', 'image/jpeg'),
      file('two.jpg', 'image/jpeg'),
      file('three.jpg', 'image/jpeg'),
    ]);
    await user.click(generateFilm());
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(2));

    expect(await screen.findAllByText('Queued')).toHaveLength(2);

    const legs = useEditor.getState().film?.segments ?? [];
    act(() => {
      emitGenerationUpdate({
        generationId: legs[0].generationId as string,
        status: 'running',
        progress: 0.4,
        elapsedSecs: 9,
        slow: false,
      });
      emitGenerationUpdate({
        generationId: legs[1].generationId as string,
        status: 'failed',
        progress: 0,
        elapsedSecs: 9,
        slow: false,
        error: { title: 'Rate limited', message: 'Too many requests — try again shortly.', retryable: true },
      });
    });

    expect(await screen.findByText('Rendering 40%')).toBeInTheDocument();
    expect(screen.getByText('Rate limited')).toBeInTheDocument();
    expect(screen.getByText('Too many requests — try again shortly.')).toBeInTheDocument();
    expect(screen.getByText('0 of 2 succeeded')).toBeInTheDocument();

    // Non-modal: the editor outside the panel is still live — still in the accessibility
    // tree and still operable, which is what the aria-modal check below pairs with.
    expect(screen.getByRole('button', { name: 'Import media' })).toBeEnabled();
    expect(screen.getByRole('dialog', { name: 'New film from 3 photos' })).not.toHaveAttribute(
      'aria-modal',
    );

    generateAnimation.mockClear();
    await user.click(screen.getByRole('button', { name: 'Retry transition 2' }));

    // Only the failed leg goes out again.
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    expect(payloadForLeg(1).startFrame).toContain(stillOf('two.jpg'));
  });

  // ------------------------------------------------------- three photos → an .mp4

  /** Three photos chosen and both legs sent. Resolves to the two generation ids, in order. */
  async function startWholeFilm(user: ReturnType<typeof userEvent.setup>): Promise<string[]> {
    await openWizard(user);
    await dropOnWizard([
      file('one.jpg', 'image/jpeg'),
      file('two.jpg', 'image/jpeg'),
      file('three.jpg', 'image/jpeg'),
    ]);
    await user.click(generateFilm());
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(2));
    return (useEditor.getState().film?.segments ?? []).map((s) => s.generationId as string);
  }

  /**
   * A leg coming home.
   *
   * Wrapped in an async `act` because the film assembles itself a microtask later, once the
   * finished file has been measured — the timeline lands inside the same commit.
   */
  async function legLands(generationId: string, outputPath: string) {
    await act(async () => {
      emitGenerationUpdate({
        generationId,
        status: 'succeeded',
        progress: 1,
        elapsedSecs: 60,
        slow: false,
        outputPath,
      });
    });
  }

  const filmClipPaths = () => {
    const { clips, assets } = useEditor.getState();
    return clips.map((c) => assets[c.assetId]?.path);
  };

  it('both transitions home — the film puts itself on the timeline, in order', async () => {
    const user = userEvent.setup();
    const [first, second] = await startWholeFilm(user);

    // Out of order on purpose: leg 2 comes back first and the film still reads 1 → 2 → 3.
    await legLands(second, '/cache/second.mp4');
    expect(useEditor.getState().clips).toHaveLength(0);

    await legLands(first, '/cache/first.mp4');

    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(2));
    expect(filmClipPaths()).toEqual(['/cache/first.mp4', '/cache/second.mp4']);

    // Two AI video clips on the one track, no manual placement asked of anyone.
    const onTrack = screen.getAllByRole('button', { name: /video clip/i });
    expect(onTrack).toHaveLength(2);
    expect(onTrack.every((clip) => within(clip).queryByText('✦ AI'))).toBe(true);

    const clips = useEditor.getState().clips;
    expect(clips.every((c) => c.kind === 'video' && c.ai)).toBe(true);
    expect(clips.map((c) => c.ai?.prompt)).toEqual([defaultFilmPrompt(0), defaultFilmPrompt(1)]);
    // Two 5 s transitions back to back: a ~10 s film, nothing else on the track.
    expect(clips.reduce((sum, c) => sum + c.durationMs, 0)).toBe(10_000);

    // And it plays: the second transition is what the preview shows at 7 s.
    act(() => useEditor.getState().setPlayhead(7000));
    expect(await screen.findByTestId('preview-video')).toHaveAttribute(
      'src',
      'asset:///cache/second.mp4',
    );
  });

  it('Export film writes the timeline through the real export, at 1920×1080 @ 30 fps', async () => {
    const user = userEvent.setup();
    vi.mocked(backend.pickExportPath).mockResolvedValue('/home/u/films/my-film.mp4');
    vi.mocked(backend.exportTimeline).mockClear();
    vi.mocked(backend.exportTimeline).mockResolvedValue('/home/u/films/my-film.mp4');

    const [first, second] = await startWholeFilm(user);
    await legLands(first, '/cache/first.mp4');
    await legLands(second, '/cache/second.mp4');
    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(2));

    await user.click(await screen.findByRole('button', { name: 'Export film' }));

    await waitFor(() => expect(backend.exportTimeline).toHaveBeenCalledTimes(1));
    const [spec, outPath] = vi.mocked(backend.exportTimeline).mock.calls[0];
    expect(backend.pickExportPath).toHaveBeenCalledWith('solcut-export.mp4');
    expect(outPath).toBe('/home/u/films/my-film.mp4');
    expect(spec).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    expect((spec as ReturnType<typeof buildExportSpec>).clips).toMatchObject([
      { kind: 'video', path: '/cache/first.mp4', durationMs: 5000, trimStartMs: 0 },
      { kind: 'video', path: '/cache/second.mp4', durationMs: 5000, trimStartMs: 0 },
    ]);

    // The finished file is named back to the user, with a way to go and find it.
    expect(await screen.findByText('Export complete')).toBeInTheDocument();
    expect(screen.getByText('/home/u/films/my-film.mp4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reveal' })).toBeInTheDocument();
  });

  it('one leg short: nothing is assembled and nothing is offered to export, until the retry lands', async () => {
    const user = userEvent.setup();
    vi.mocked(backend.exportTimeline).mockClear();
    const [first, second] = await startWholeFilm(user);

    await legLands(first, '/cache/first.mp4');
    act(() =>
      emitGenerationUpdate({
        generationId: second,
        status: 'failed',
        progress: 0,
        elapsedSecs: 4,
        slow: false,
        error: { title: 'Rate limited', message: 'Too many requests.', retryable: true },
      }),
    );

    // Half a film is not a film: the track stays empty and there is nothing to export.
    expect(await screen.findByText('1 of 2 succeeded')).toBeInTheDocument();
    expect(useEditor.getState().clips).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Export film' })).not.toBeInTheDocument();
    expect(backend.exportTimeline).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Retry transition 2' }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(3));

    // The retry's own generation is what finishes the film; the leg that landed is untouched.
    const retried = useEditor.getState().film?.segments[1].generationId as string;
    expect(retried).not.toBe(second);
    await legLands(retried, '/cache/second-retry.mp4');

    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(2));
    expect(filmClipPaths()).toEqual(['/cache/first.mp4', '/cache/second-retry.mp4']);
    expect(await screen.findByRole('button', { name: 'Export film' })).toBeInTheDocument();

    // Assembled once: the leg that had already landed does not get a second clip.
    await legLands(first, '/cache/first.mp4');
    expect(useEditor.getState().clips).toHaveLength(2);
  });
});

describe('the per-render model selector', () => {
  it('a render with the selector untouched goes to Seedance 2.5', async () => {
    const user = userEvent.setup();
    render(<App />);
    await dropPhotoPair();
    await user.click(screen.getByRole('button', { name: CUT_CHIP }));

    // The control stands on the cut card, already on the default — no pick required.
    expect(await screen.findByLabelText('Model')).toHaveValue('seedance-2.5');

    await user.click(screen.getByRole('button', { name: /generate transition/i }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    expect(generateAnimation.mock.calls[0][0].model).toBe('seedance_2_5');
  });

  it('a non-default pick is what that render submits', async () => {
    const user = userEvent.setup();
    render(<App />);
    await dropPhotoPair();
    await user.click(screen.getByRole('button', { name: CUT_CHIP }));

    await user.selectOptions(await screen.findByLabelText('Model'), 'veo-3.1-lite');
    await user.click(screen.getByRole('button', { name: /generate transition/i }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    expect(generateAnimation.mock.calls[0][0].model).toBe('veo3_1_lite');
  });

  it('Regenerate carries the same control, and submits its pick', async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await runCutGeneration(user);
    expect(generateAnimation.mock.calls[0][0].model).toBe('seedance_2_5');
    await succeed(id);

    // The landed transition clip is selected, so its card is showing now.
    generateAnimation.mockClear();
    await user.selectOptions(await screen.findByLabelText('Model'), 'seedance-2.0');
    await user.click(screen.getByRole('button', { name: /regenerate transition/i }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    expect(generateAnimation.mock.calls[0][0].model).toBe('seedance_2_0');
  });

  it('a model id typed into Settings is reachable as the Custom entry', async () => {
    const user = userEvent.setup();
    storedSettings = { ...STORED_SETTINGS, customModel: 'wan2_7' };
    render(<App />);
    await dropPhotoPair();
    await user.click(screen.getByRole('button', { name: CUT_CHIP }));

    const select = await screen.findByLabelText('Model');
    expect(within(select).getByRole('option', { name: 'Custom — wan2_7' })).toBeInTheDocument();

    await user.selectOptions(select, 'custom');
    await user.click(screen.getByRole('button', { name: /generate transition/i }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    expect(generateAnimation.mock.calls[0][0].model).toBe('wan2_7');
  });
});

// ---- AI transitions

const CUT_CHIP = 'Select the cut between sunset.jpg and cliff.png';

async function dropPhotoPair() {
  await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('cliff.png', 'image/png')]);
  await screen.findByRole('button', { name: 'sunset.jpg photo clip' });
}

/** Drop two photos, select their cut, press Generate. Returns the generation id. */
async function runCutGeneration(user: ReturnType<typeof userEvent.setup>): Promise<string> {
  await dropPhotoPair();
  await user.click(screen.getByRole('button', { name: CUT_CHIP }));
  await user.click(await screen.findByRole('button', { name: /generate transition/i }));
  await waitFor(() => expect(generateAnimation).toHaveBeenCalled());
  return Object.keys(useEditor.getState().generations)[0];
}

/** Drive one generation to success, flushing the duration probe inside act. */
function succeed(id: string, outputPath = '/home/u/.cache/solcut/generated/tr.mp4') {
  return act(async () => {
    emitGenerationUpdate({
      generationId: id,
      status: 'succeeded',
      progress: 1,
      elapsedSecs: 60,
      slow: false,
      outputPath,
    });
  });
}
