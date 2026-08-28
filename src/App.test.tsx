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
import { addKeyframe, layout } from './lib/timeline';
import { DEFAULT_TRANSITION_PROMPT, IDENTITY_TRANSFORM } from './types/project';
import * as backend from './lib/backend';
import type { GenerateInput, GenerationUpdate } from './lib/backend';

const generateAnimation = vi.fn(async (_input: GenerateInput) => {});
let emitGenerationUpdate: (u: GenerationUpdate) => void = () => {};

/** What the backend reports it has stored. Reset per test; a few of them change it. */
const STORED_SETTINGS = {
  configured: true,
  apiKeyIdHint: '••••7fa2',
  hasSecret: true,
  baseUrl: 'https://api.higgsfield.ai',
  endpoint: '/higgsfield-ai/dop/standard',
};
let storedSettings = { ...STORED_SETTINGS };

vi.mock('./lib/backend', () => ({
  isDesktop: () => true,
  assetSrc: (p: string) => `asset://${p}`,
  getSettings: async () => storedSettings,
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
  pickAudioFiles: vi.fn(),
  pickExportPath: vi.fn(),
  revealPath: vi.fn(),
}));

// Canvas rendering and media probing are browser capabilities jsdom lacks. The stub keeps
// the two keyframe stills distinguishable so the request can be asserted on.
vi.mock('./lib/frames', () => ({
  FRAME_WIDTH: 1280,
  FRAME_HEIGHT: 720,
  renderKeyframeJpeg: async (_src: string, transform: { scale: number }) =>
    `data:image/jpeg;base64,frame-at-scale-${transform.scale}`,
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
    cutPrompts: {},
    animateQueue: null,
    animateSubmittingId: null,
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

describe('AI transitions between photos', () => {
  it('1 — dropping two photos grows a ✦ chip on the cut between them', async () => {
    render(<App />);
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('cliff.png', 'image/png')]);

    expect(await screen.findByRole('button', { name: CUT_CHIP })).toBeInTheDocument();
    expect(useEditor.getState().clips.map((c) => c.kind)).toEqual(['photo', 'photo']);
  });

  it('2 — a chip tap only selects; Generate sends A-end and B-start with the default prompt', async () => {
    const user = userEvent.setup();
    render(<App />);
    await dropPhotoPair();

    // Give the left photo's end framing a distinct scale so the stills are tellable apart.
    act(() => {
      const s = useEditor.getState();
      const a = s.clips[0];
      useEditor.setState({
        clips: s.clips.map((c) =>
          c.id === a.id ? addKeyframe(c, a.durationMs, { ...IDENTITY_TRANSFORM, scale: 1.6 }) : c,
        ),
      });
    });

    await user.click(screen.getByRole('button', { name: CUT_CHIP }));
    // Selecting is free: nothing is sent until the big button.
    expect(generateAnimation).not.toHaveBeenCalled();
    expect(useEditor.getState().selection.kind).toBe('cut');

    await user.click(await screen.findByRole('button', { name: /generate transition/i }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    const sent = generateAnimation.mock.calls[0][0];
    expect(sent.prompt).toBe(DEFAULT_TRANSITION_PROMPT);
    expect(sent.startFrame).toBe('data:image/jpeg;base64,frame-at-scale-1.6');
    expect(sent.endFrame).toBe('data:image/jpeg;base64,frame-at-scale-1');

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
        error: { title: 'Rate limited', message: 'rate limited', retryable: true },
      });
    });

    expect(await screen.findByText('✕ FAILED')).toBeInTheDocument();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Rate limited')).toBeInTheDocument();

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

  it('7 — a reframed neighbour marks it stale; Regenerate uses the new framing', async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await runCutGeneration(user);
    await succeed(id);

    // The right photo's first frame is re-framed after the render landed.
    act(() => {
      const s = useEditor.getState();
      const b = s.clips[2];
      useEditor.setState({
        clips: s.clips.map((c) =>
          c.id === b.id ? addKeyframe(c, 0, { ...IDENTITY_TRANSFORM, scale: 2 }) : c,
        ),
      });
    });
    expect(await screen.findByText('⟳ SOURCES CHANGED')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /ai-.*\.mp4 video clip/i }));
    generateAnimation.mockClear();
    await user.click(await screen.findByRole('button', { name: /regenerate transition/i }));
    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    // The NEW neighbour framing went out, not the one the old render was made from.
    expect(generateAnimation.mock.calls[0][0].endFrame).toBe('data:image/jpeg;base64,frame-at-scale-2');

    const regen = Object.values(useEditor.getState().generations).find((g) => g.status === 'queued')!;
    await succeed(regen.id, '/home/u/.cache/solcut/generated/tr2.mp4');

    // Swapped in place: same shape, and the staleness tag is gone.
    expect(useEditor.getState().clips.map((c) => c.kind)).toEqual(['photo', 'video', 'photo']);
    expect(screen.queryByText('⟳ SOURCES CHANGED')).not.toBeInTheDocument();
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

    // While it renders, c.jpg is dragged between the pair.
    act(() => {
      const s = useEditor.getState();
      s.moveClip(s.clips[2].id, 1);
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

  it('11 — with no credential the cut card explains and nothing is sent', async () => {
    const user = userEvent.setup();
    storedSettings = { ...STORED_SETTINGS, configured: false, hasSecret: false, apiKeyIdHint: '' };
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

describe('the Higgsfield connection', () => {
  it('Test connection authenticates with the credential typed into the dialog', async () => {
    const user = userEvent.setup();
    const testConnection = vi.mocked(backend.testConnection);
    testConnection.mockClear();
    testConnection.mockResolvedValue('Authenticated with Higgsfield in 91 ms.');

    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Higgsfield/ }));

    await user.type(screen.getByLabelText('API key ID'), 'hf-key-id');
    await user.type(screen.getByLabelText('API key secret'), 'hf-key-secret');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    // The whole point of the button: it proves the key in the boxes, not the one on disk.
    await waitFor(() => expect(testConnection).toHaveBeenCalledTimes(1));
    expect(testConnection).toHaveBeenCalledWith({
      apiKeyId: 'hf-key-id',
      apiKeySecret: 'hf-key-secret',
      baseUrl: 'https://api.higgsfield.ai',
      endpoint: '/higgsfield-ai/dop/standard',
    });
    expect(await screen.findByText('Connection OK')).toBeInTheDocument();
  });

  it('a rejected credential is reported as a failure, not as a connection', async () => {
    const user = userEvent.setup();
    const testConnection = vi.mocked(backend.testConnection);
    testConnection.mockClear();
    testConnection.mockRejectedValue('authentication rejected (HTTP 401): Invalid credentials');

    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Higgsfield/ }));
    await user.type(screen.getByLabelText('API key ID'), 'wrong');
    await user.type(screen.getByLabelText('API key secret'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText('Could not connect')).toBeInTheDocument();
    expect(screen.getByText(/Invalid credentials/)).toBeInTheDocument();
  });

  it('reopening the dialog shows the endpoint that is stored, not the default', async () => {
    const user = userEvent.setup();
    const saveSettings = vi.mocked(backend.saveSettings);
    saveSettings.mockClear();

    // What the backend reports after the user pointed at another documented model.
    storedSettings = { ...STORED_SETTINGS, endpoint: '/veo3.1/first-last-frame-to-video' };

    render(<App />);
    await waitFor(() =>
      expect(useEditor.getState().settings?.endpoint).toBe('/veo3.1/first-last-frame-to-video'),
    );
    await user.click(screen.getByRole('button', { name: /Higgsfield/ }));

    // Seeded once at mount, the field would still read the default — and saving would
    // silently write that default back over the stored endpoint.
    expect(screen.getByLabelText('Model endpoint')).toHaveValue('/veo3.1/first-last-frame-to-video');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: '/veo3.1/first-last-frame-to-video' }),
    );
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
async function dragFromTo(target: Element, fromX: number, toX: number) {
  await act(async () => fireEvent.pointerDown(target, { button: 0, clientX: fromX }));
  await act(async () => fireEvent.pointerMove(window, { clientX: toX }));
  await act(async () => fireEvent.pointerUp(window, { clientX: toX }));
}

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
