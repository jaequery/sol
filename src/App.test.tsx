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
