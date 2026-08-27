/**
 * The ticket's acceptance checks, driven through the real UI.
 *
 * Only the two genuinely non-UI edges are stubbed: the Tauri bridge (`lib/backend`) and
 * canvas/media decoding (`lib/frames`), neither of which jsdom provides. Everything in
 * between — the store, the timeline, the inspector, the segment maths — is the real thing.
 * The Rust side of the same flow is covered by `cargo test -p solcut-higgsfield`.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { useEditor } from './state/store';
import type { GenerateInput, GenerationUpdate } from './lib/backend';

const generateAnimation = vi.fn(async (_input: GenerateInput) => {});
let emitGenerationUpdate: (u: GenerationUpdate) => void = () => {};

vi.mock('./lib/backend', () => ({
  isDesktop: () => true,
  assetSrc: (p: string) => `asset://${p}`,
  getSettings: async () => ({
    configured: true,
    apiKeyHint: '••••7fa2',
    hasSecret: false,
    baseUrl: 'https://platform.higgsfield.ai',
    model: 'dop',
    endpoint: '/v1/image2video',
  }),
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
  renderKeyframeJpeg: async (_src: string, transform: { scale: number }) =>
    `data:image/jpeg;base64,frame-at-scale-${transform.scale}`,
  probeVideoDurationMs: async (_src: string, fallback: number) => fallback,
}));

function file(name: string, type: string): File {
  return new File(['binary'], name, { type });
}

async function dropOnTimeline(files: File[]) {
  const track = screen.getByTestId('timeline-track');
  const dataTransfer = { files, items: files.map(() => ({})), types: ['Files'] };
  await act(async () => {
    const { fireEvent } = await import('@testing-library/react');
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
    importProblems: [],
    importing: 0,
    toasts: [],
    exportState: null,
    settingsOpen: false,
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
    expect(sent.durationSeconds).toBeCloseTo(3.2, 5);
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

// ---------------------------------------------------------------- helpers

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
