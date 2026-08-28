/**
 * The ticket's acceptance checks, driven through the real UI.
 *
 * Only the two genuinely non-UI edges are stubbed: the Tauri bridge (`lib/backend`) and
 * canvas/media decoding (`lib/frames`), neither of which jsdom provides. Everything in
 * between — the store, the timeline, the inspector, the segment maths — is the real thing.
 * The Rust side of the same flow is covered by `cargo test -p solcut-higgsfield`.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { buildExportSpec, useEditor } from './state/store';
import { layout } from './lib/timeline';
import { defaultFilmPrompt } from './lib/film';
import * as backend from './lib/backend';
import type { GenerateInput, GenerationUpdate } from './lib/backend';

const generateAnimation = vi.fn(async (_input: GenerateInput) => {});
let emitGenerationUpdate: (u: GenerationUpdate) => void = () => {};

vi.mock('./lib/backend', () => ({
  isDesktop: () => true,
  assetSrc: (p: string) => `asset://${p}`,
  getSettings: async () => ({
    configured: true,
    apiKeyIdHint: '••••7fa2',
    hasSecret: true,
    baseUrl: 'https://api.higgsfield.ai',
    endpoint: '/higgsfield-ai/dop/standard',
  }),
  DEFAULT_BASE_URL: 'https://api.higgsfield.ai',
  DEFAULT_ENDPOINT: '/higgsfield-ai/dop/standard',
  KNOWN_ENDPOINTS: ['/higgsfield-ai/dop/standard'],
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
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
  pickExportPath: vi.fn(),
  revealPath: vi.fn(),
}));

// Canvas rendering and media probing are browser capabilities jsdom lacks. The stub keeps
// the two keyframe stills distinguishable so the request can be asserted on.
vi.mock('./lib/frames', () => ({
  FRAME_WIDTH: 1280,
  FRAME_HEIGHT: 720,
  renderKeyframeJpeg: async (src: string, transform: { scale: number }) =>
    `data:image/jpeg;base64,frame-of-${src}-at-scale-${transform.scale}`,
  probeVideoDurationMs: async (_src: string, fallback: number) => fallback,
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
  useEditor.setState({
    assets: {},
    clips: [],
    selection: { kind: 'none' },
    playheadMs: 0,
    playing: false,
    generations: {},
    film: null,
    filmWizardOpen: false,
    importProblems: [],
    importing: 0,
    toasts: [],
    exportState: null,
    settingsOpen: false,
    // 100 px per second makes every drag below exactly 10 ms to the pixel.
    pxPerSecond: 100,
  });
});

describe('acceptance', () => {
  it('1 — a photo and a video dropped on the single timeline both become clips', async () => {
    render(<App />);
    expect(screen.getByText('Drop photos and videos here')).toBeInTheDocument();

    await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('surf.mp4', 'video/mp4')]);

    const photo = await screen.findByRole('button', { name: 'sunset.jpg photo clip' });
    const video = await screen.findByRole('button', { name: 'surf.mp4 video clip' });
    expect(photo).toBeInTheDocument();
    expect(video).toBeInTheDocument();

    // One track: the clips are laid end to end, not stacked on separate lanes.
    const clips = useEditor.getState().clips;
    expect(clips.map((c) => c.kind)).toEqual(['photo', 'video']);
    expect(screen.queryByText('Drop photos and videos here')).not.toBeInTheDocument();
  });

  it('2 — two keyframes can be added to a photo clip', async () => {
    const user = userEvent.setup();
    render(<App />);
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg')]);

    await user.click(await screen.findByRole('button', { name: 'sunset.jpg photo clip' }));
    const addKeyframe = screen.getByRole('button', { name: 'Add keyframe at playhead' });

    await user.click(addKeyframe);
    act(() => useEditor.getState().setPlayhead(3200));
    await user.click(screen.getByRole('button', { name: 'Add keyframe at playhead' }));

    expect(screen.getByRole('button', { name: 'Keyframe 1 at 00:00.00' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keyframe 2 at 00:03.20' })).toBeInTheDocument();
    expect(useEditor.getState().clips[0].keyframes).toHaveLength(2);
  });

  it('3 — a prompt can be typed for the segment between two keyframes', async () => {
    const user = userEvent.setup();
    render(<App />);
    await setUpTwoKeyframes(user);

    await user.click(
      screen.getByRole('button', { name: 'Segment from keyframe 1 to keyframe 2' }),
    );

    const prompt = await screen.findByLabelText(/describe the motion between these two keyframes/i);
    await user.type(prompt, 'slow dolly-in over the water');

    expect(prompt).toHaveValue('slow dolly-in over the water');
    expect(screen.getByRole('button', { name: /generate animation/i })).toBeEnabled();
  });

  it('3b — generate stays disabled, with a reason, until the prompt says something', async () => {
    const user = userEvent.setup();
    render(<App />);
    await setUpTwoKeyframes(user);
    await user.click(
      screen.getByRole('button', { name: 'Segment from keyframe 1 to keyframe 2' }),
    );

    expect(screen.getByRole('button', { name: /generate animation/i })).toBeDisabled();
    expect(screen.getByText('Describe the motion first.')).toBeInTheDocument();
    expect(generateAnimation).not.toHaveBeenCalled();
  });

  it('4 — submitting sends the prompt and both rendered keyframes to the backend', async () => {
    const user = userEvent.setup();
    render(<App />);
    await setUpTwoKeyframes(user);

    await user.click(
      screen.getByRole('button', { name: 'Segment from keyframe 1 to keyframe 2' }),
    );
    await user.type(
      await screen.findByLabelText(/describe the motion/i),
      'slow dolly-in over the water',
    );
    // Give the two keyframes different framing so the stills are distinguishable.
    act(() => {
      const state = useEditor.getState();
      const clip = state.clips[0];
      useEditor.setState({
        selection: { kind: 'keyframe', clipId: clip.id, keyframeId: clip.keyframes[1].id },
      });
      state.updateSelectedKeyframe({ scale: 1.6 });
      useEditor.setState({
        selection: {
          kind: 'segment',
          clipId: clip.id,
          fromKeyframeId: clip.keyframes[0].id,
          toKeyframeId: clip.keyframes[1].id,
        },
      });
    });

    await user.click(screen.getByRole('button', { name: /generate animation/i }));

    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    const sent = generateAnimation.mock.calls[0][0];

    expect(sent.prompt).toBe('slow dolly-in over the water');
    expect(sent.startFrame).toContain('data:image/jpeg;base64,');
    expect(sent.endFrame).toContain('data:image/jpeg;base64,');
    expect(sent.startFrame).not.toEqual(sent.endFrame);
    expect(sent.endFrame).toContain('scale-1.6');
    expect(sent.generationId).toBeTruthy();
  });

  it('4b — the segment shows queued, then live progress, while the editor stays usable', async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await runGeneration(user);

    expect(await screen.findByText('Queued')).toBeInTheDocument();

    act(() =>
      emitGenerationUpdate({
        generationId: id,
        status: 'running',
        progress: 0.46,
        elapsedSecs: 12,
        slow: false,
      }),
    );

    expect(await screen.findByText('Rendering 46%')).toBeInTheDocument();
    // Nothing is blocked while it renders.
    expect(screen.getByRole('button', { name: 'sunset.jpg photo clip' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeEnabled();
  });

  it('5 — the finished clip replaces the segment and is playable', async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await runGeneration(user);

    act(() =>
      emitGenerationUpdate({
        generationId: id,
        status: 'succeeded',
        progress: 1,
        elapsedSecs: 60,
        slow: false,
        outputPath: '/home/u/.cache/solcut/generated/out.mp4',
      }),
    );

    // It lands on the same single track, where the segment was.
    const generated = await screen.findByRole('button', { name: /ai-.*\.mp4 video clip/i });
    expect(generated).toBeInTheDocument();
    expect(within(generated).getByText('✦ AI')).toBeInTheDocument();

    const clips = useEditor.getState().clips;
    const ai = clips.find((c) => c.ai);
    expect(ai).toBeDefined();
    expect(ai!.kind).toBe('video');
    expect(ai!.durationMs).toBe(3200);
    expect(ai!.ai!.prompt).toBe('slow dolly-in over the water');
    // The whole timeline is still the same length — the segment was replaced, not appended.
    expect(clips.reduce((sum, c) => sum + c.durationMs, 0)).toBe(5000);

    // And it is what the preview plays.
    act(() => useEditor.getState().setPlayhead(1000));
    const video = await screen.findByTestId('preview-video');
    expect(video).toHaveAttribute('src', 'asset:///home/u/.cache/solcut/generated/out.mp4');
  });

  it('a failed generation explains itself and keeps the prompt for a retry', async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await runGeneration(user);

    act(() =>
      emitGenerationUpdate({
        generationId: id,
        status: 'failed',
        progress: 0,
        elapsedSecs: 4,
        slow: false,
        error: { title: 'Rate limited', message: 'rate limited', retryable: true },
      }),
    );

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Rate limited')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    const clip = useEditor.getState().clips[0];
    expect(Object.values(clip.prompts)).toContain('slow dolly-in over the water');
  });

  it('a long-running generation says so instead of leaving the user guessing', async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await runGeneration(user);

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

  it('an unsupported file is named and does not stop the rest of the drop', async () => {
    render(<App />);
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('notes.tiff', '')]);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/notes\.tiff/)).toBeInTheDocument();
    expect(useEditor.getState().clips).toHaveLength(1);
  });

  it('the AI card explains why it is unusable with only one keyframe', async () => {
    const user = userEvent.setup();
    render(<App />);
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg')]);
    await user.click(await screen.findByRole('button', { name: 'sunset.jpg photo clip' }));
    await user.click(screen.getByRole('button', { name: 'Add keyframe at playhead' }));

    expect(screen.getByText('Add a second keyframe to define a segment.')).toBeInTheDocument();
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
    expect(screen.getByText('Drop photos and videos here')).toBeInTheDocument();
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
  it('a clip dragged along the track changes places with its neighbour', async () => {
    render(<App />);
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('surf.mp4', 'video/mp4')]);
    const surf = await screen.findByRole('button', { name: 'surf.mp4 video clip' });

    // Grabbed at 7 s — inside the video — and let go over the first half of the photo.
    await dragFromTo(surf, 700, 100);

    const state = useEditor.getState();
    expect(state.clips.map((c) => c.name)).toEqual(['surf.mp4', 'sunset.jpg']);
    // Reordering does not change how long anything is, only where it sits.
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

    // Reordered, and both length edits are in the spec ffmpeg is driven from.
    expect(spec.clips.map((c) => [c.name, c.kind, c.durationMs])).toEqual([
      ['surf.mp4', 'video', 3500],
      ['sunset.jpg', 'photo', 7000],
    ]);
    expect(spec.clips[0]).toMatchObject({ trimStartMs: 1500 });
  });
});

// ---------------------------------------------------------------- helpers

/**
 * A pointer drag. The clip drag listens on the window so it survives the cursor leaving the
 * clip, which is exactly how the events are delivered here.
 */
async function dragFromTo(target: Element, fromX: number, toX: number) {
  await act(async () => fireEvent.pointerDown(target, { button: 0, clientX: fromX }));
  await act(async () => fireEvent.pointerMove(window, { clientX: toX }));
  await act(async () => fireEvent.pointerUp(window, { clientX: toX }));
}

describe('the 3-photo film wizard', () => {
  const NO_KEY = {
    configured: false,
    apiKeyIdHint: '',
    hasSecret: false,
    baseUrl: 'https://api.higgsfield.ai',
    endpoint: '/higgsfield-ai/dop/standard',
  };

  /** Both ways in carry the same label: the title bar's, then the empty timeline's. */
  const entryPoints = () => screen.getAllByRole('button', { name: '✦ New film from 3 photos' });

  /** Open the panel and wait for the settings load to have landed. */
  async function openWizard(user: ReturnType<typeof userEvent.setup>, from = 0) {
    render(<App />);
    await waitFor(() => expect(useEditor.getState().settings).not.toBeNull());
    await user.click(entryPoints()[from]);
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
    return `frame-of-${asset?.src}-at-`;
  }

  /** The request that answers for one leg — never arrival order, which is a race. */
  function payloadForLeg(index: number): GenerateInput {
    const id = useEditor.getState().film?.segments[index].generationId;
    const call = generateAnimation.mock.calls.find(([input]) => input.generationId === id);
    expect(call, `leg ${index} was sent`).toBeTruthy();
    return (call as [GenerateInput])[0];
  }

  it('opens from the title bar and from the empty timeline alike', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(useEditor.getState().settings).not.toBeNull());
    expect(entryPoints()).toHaveLength(2);

    // The empty-timeline CTA, which is the one a first run actually sees.
    await user.click(entryPoints()[1]);
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

  it('a video cannot be one of the three keyframes, and is told so', async () => {
    const user = userEvent.setup();
    await openWizard(user);

    await dropOnWizard([
      file('one.jpg', 'image/jpeg'),
      file('surf.mp4', 'video/mp4'),
      file('two.jpg', 'image/jpeg'),
    ]);

    expect(
      screen.getByText(
        "surf.mp4 — a film's three keyframes are photos — a video cannot be one of them",
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
    act(() => useEditor.setState({ settings: NO_KEY }));

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

    // The photos are inputs, not shots: the track stays empty until the film lands.
    expect(useEditor.getState().clips).toHaveLength(0);
    expect(Object.values(useEditor.getState().assets)).toHaveLength(3);
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

    // Non-modal: the editor behind the panel is still live.
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
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

async function setUpTwoKeyframes(user: ReturnType<typeof userEvent.setup>) {
  await dropOnTimeline([file('sunset.jpg', 'image/jpeg')]);
  await user.click(await screen.findByRole('button', { name: 'sunset.jpg photo clip' }));
  await user.click(screen.getByRole('button', { name: 'Add keyframe at playhead' }));
  act(() => useEditor.getState().setPlayhead(3200));
  await user.click(screen.getByRole('button', { name: 'Add keyframe at playhead' }));
}

/** Get as far as a queued generation, and return its id. */
async function runGeneration(user: ReturnType<typeof userEvent.setup>): Promise<string> {
  await setUpTwoKeyframes(user);
  await user.click(screen.getByRole('button', { name: 'Segment from keyframe 1 to keyframe 2' }));
  await user.type(
    await screen.findByLabelText(/describe the motion/i),
    'slow dolly-in over the water',
  );
  await user.click(screen.getByRole('button', { name: /generate animation/i }));
  await waitFor(() => expect(generateAnimation).toHaveBeenCalled());
  return Object.keys(useEditor.getState().generations)[0];
}
