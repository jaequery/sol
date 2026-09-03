/**
 * Changing the shape of the video.
 *
 * The frame is one project-wide setting with four consumers, and the point of this suite is
 * that they cannot drift apart: the preview draws it, the export writes it, the stills an
 * AI transition is generated from take it, and the project file remembers it. A frame that
 * only reached one of the four is the bug this exists to catch — a vertical export with a
 * horizontal transition sitting in the middle of it.
 */

import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { buildExportSpec, useEditor } from './state/store';
import { resetEditor } from './test/harness';
import * as backend from './lib/backend';
import { ASPECT_RATIOS, DEFAULT_ASPECT_RATIO } from './lib/aspect';
import { PROJECT_VERSION, type ProjectFile } from './lib/project';
import type { GenerateInput, GenerationUpdate } from './lib/backend';

/** What is on disk for this test. `null` is a fresh install. */
let stored: unknown = null;
const generateAnimation = vi.fn(async (_input: GenerateInput) => {});
const renderPhotoJpeg = vi.fn(
  async (src: string, width?: number, height?: number) =>
    `data:image/jpeg;base64,${src}@${width}x${height}`,
);
const captureVideoFrame = vi.fn(
  async (path: string, atMs: number, width?: number, height?: number) =>
    `data:image/jpeg;base64,${path}@${atMs}@${width}x${height}`,
);

vi.mock('./lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/backend')>()),
  isDesktop: () => true,
  assetSrc: (p: string) => `asset://${p}`,
  getSettings: async () => ({ configured: true, cliPath: '/usr/local/bin/higgsfield', customModel: '' }),
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  testApiKey: vi.fn(),
  importPaths: vi.fn(async () => ({ imported: [], rejected: [] })),
  loadProject: vi.fn(async () => null),
  saveProject: vi.fn(async () => {}),
  recentProjects: vi.fn(async () => []),
  newProjectPath: vi.fn(async (name: string) => `/docs/${name}.solcut`),
  createProject: vi.fn(async () => {}),
  generateAnimation: (input: GenerateInput) => generateAnimation(input),
  generateImage: vi.fn(async () => {}),
  cancelGeneration: vi.fn(async () => {}),
  ffmpegAvailable: async () => true,
  captureVideoFrame: (path: string, atMs: number, width?: number, height?: number) =>
    captureVideoFrame(path, atMs, width, height),
  exportTimeline: vi.fn(),
  onGenerationUpdate: async (_cb: (u: GenerationUpdate) => void) => () => {},
  onExportProgress: async () => () => {},
  onWindowClose: async () => () => {},
  pickMediaFiles: vi.fn(),
  pickAudioFiles: vi.fn(),
  pickExportPath: vi.fn(),
  revealPath: vi.fn(),
}));

// Canvas rendering and media probing are browser capabilities jsdom lacks. The size the
// still is drawn at is exactly what this suite is asserting on, so it is echoed back.
vi.mock('./lib/frames', () => ({
  FRAME_WIDTH: 1280,
  FRAME_HEIGHT: 720,
  renderPhotoJpeg: (src: string, width?: number, height?: number) =>
    renderPhotoJpeg(src, width, height),
  probeVideoDurationMs: async (_src: string, fallback: number) => fallback,
  probeAudioDurationMs: async (_src: string, fallback: number) => fallback,
}));

const PICKER = 'Frame aspect ratio';

beforeEach(() => {
  stored = null;
  generateAnimation.mockClear();
  renderPhotoJpeg.mockClear();
  captureVideoFrame.mockClear();
  vi.mocked(backend.saveProject).mockClear();
  vi.mocked(backend.exportTimeline).mockClear();
  resetEditor();
  vi.mocked(backend.loadProject).mockImplementation(async () => stored);
  vi.mocked(backend.saveProject).mockImplementation(async (project: unknown) => {
    stored = project;
  });
});

function launch() {
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

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

/**
 * Media that has a real file behind it, put straight on the track.
 *
 * A browser drop only ever gets an object URL and no path, and the export refuses a clip
 * with no file on disk before it renders anything — so a suite about what the export
 * *writes* has to seed paths rather than drop `File`s.
 */
function seedTrack(): void {
  act(() =>
    useEditor.setState({
      assets: {
        asset_v: {
          id: 'asset_v',
          name: 'pan.mp4',
          kind: 'video',
          path: '/media/pan.mp4',
          src: 'asset:///media/pan.mp4',
          sizeBytes: 4096,
          durationMs: 12_000,
        },
        asset_p: {
          id: 'asset_p',
          name: 'cliff.png',
          kind: 'photo',
          path: '/media/cliff.png',
          src: 'asset:///media/cliff.png',
          sizeBytes: 2048,
        },
      },
      clips: [
        {
          id: 'clip_v',
          assetId: 'asset_v',
          kind: 'video',
          name: 'pan.mp4',
          startMs: 0,
          durationMs: 5000,
          trimStartMs: 0,
        },
        {
          id: 'clip_p',
          assetId: 'asset_p',
          kind: 'photo',
          name: 'cliff.png',
          startMs: 5000,
          durationMs: 5000,
          trimStartMs: 0,
        },
      ],
    }),
  );
}

/** Mounted, and past the point where the settings and the ffmpeg probe have answered. */
async function launched() {
  launch();
  await waitFor(() => expect(useEditor.getState().settings?.configured).toBe(true));
  await waitFor(() => expect(useEditor.getState().ffmpegAvailable).toBe(true));
}

describe('the frame is a control over the frame it reshapes', () => {
  it('sits in the preview’s panel head and offers every ratio, 16:9 first', async () => {
    launch();

    const picker = await screen.findByLabelText(PICKER);
    expect(picker).toHaveValue(DEFAULT_ASPECT_RATIO);
    expect(within(picker).getAllByRole('option')).toHaveLength(ASPECT_RATIOS.length);
    // Both of the ticket's examples are reachable, and "9:6" is 3:2.
    for (const id of ['16:9', '9:16', '4:5', '3:2']) {
      expect(within(picker).getByRole('option', { name: new RegExp(`^${id} `) })).toBeInTheDocument();
    }
  });

  it('turns the frame on its side, and the preview follows it', async () => {
    const user = userEvent.setup();
    launch();
    await dropOnTimeline([file('cliff.png', 'image/png')]);

    const canvas = await screen.findByTestId('preview-canvas');
    expect(canvas).toHaveAttribute('data-aspect', '16:9');
    expect(canvas.parentElement).toHaveStyle({ '--frame-ratio': '16 / 9' });

    await user.selectOptions(screen.getByLabelText(PICKER), '9:16');

    expect(useEditor.getState().aspectRatio).toBe('9:16');
    expect(canvas).toHaveAttribute('data-aspect', '9:16');
    expect(canvas.parentElement).toHaveStyle({ '--frame-ratio': '9 / 16' });
  });

  it('ignores a ratio this build does not offer rather than drawing nothing', () => {
    act(() => useEditor.getState().setAspectRatio('7:3'));
    expect(useEditor.getState().aspectRatio).toBe(DEFAULT_ASPECT_RATIO);
  });
});

describe('the export writes the frame the preview drew', () => {
  it('renders each ratio at its own pixel size', () => {
    const clips = useEditor.getState().clips;
    const assets = useEditor.getState().assets;
    expect(buildExportSpec(clips, assets, [], '16:9')).toMatchObject({ width: 1920, height: 1080 });
    expect(buildExportSpec(clips, assets, [], '9:16')).toMatchObject({ width: 1080, height: 1920 });
    expect(buildExportSpec(clips, assets, [], '4:5')).toMatchObject({ width: 1080, height: 1350 });
    expect(buildExportSpec(clips, assets, [], '3:2')).toMatchObject({ width: 1620, height: 1080 });
    expect(buildExportSpec(clips, assets, [], '1:1')).toMatchObject({ width: 1080, height: 1080 });
    // Unchanged for a project that never touches the control.
    expect(buildExportSpec(clips, assets)).toMatchObject({ width: 1920, height: 1080, fps: 30 });
  });

  it('sends the chosen frame through the real Export button', async () => {
    const user = userEvent.setup();
    vi.mocked(backend.pickExportPath).mockResolvedValue('/home/u/vertical.mp4');
    vi.mocked(backend.exportTimeline).mockResolvedValue('/home/u/vertical.mp4');
    await launched();
    seedTrack();

    await user.selectOptions(await screen.findByLabelText(PICKER), '4:5');
    await user.click(screen.getByRole('button', { name: 'Export MP4' }));

    await waitFor(() => expect(backend.exportTimeline).toHaveBeenCalledTimes(1));
    expect(vi.mocked(backend.exportTimeline).mock.calls[0][0]).toMatchObject({
      width: 1080,
      height: 1350,
      fps: 30,
    });
  });
});

describe('an AI transition is generated into the frame it will be shown in', () => {
  it('draws both anchor stills at the project’s shape, not at 16:9', async () => {
    const user = userEvent.setup();
    launch();
    await dropOnTimeline([file('sunset.jpg', 'image/jpeg'), file('cliff.png', 'image/png')]);
    await screen.findByRole('button', { name: 'sunset.jpg photo clip' });

    await user.selectOptions(await screen.findByLabelText(PICKER), '9:16');
    await user.click(
      screen.getByRole('button', { name: 'Select the cut between sunset.jpg and cliff.png' }),
    );
    await user.click(await screen.findByRole('button', { name: /generate transition/i }));

    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    // 720 short edge, turned on its side with the frame — and both ends alike, which is the
    // whole point: they are the two ends of one motion.
    expect(renderPhotoJpeg).toHaveBeenCalledTimes(2);
    for (const call of renderPhotoJpeg.mock.calls) {
      expect(call.slice(1)).toEqual([720, 1280]);
    }
  });

  it('grabs a video anchor at the same shape, so both ends of one motion agree', async () => {
    await launched();
    seedTrack();
    act(() => useEditor.getState().setAspectRatio('4:5'));

    await act(async () => {
      useEditor.getState().startCutGeneration('clip_v', 'clip_p');
    });

    await waitFor(() => expect(generateAnimation).toHaveBeenCalledTimes(1));
    expect(captureVideoFrame).toHaveBeenCalledTimes(1);
    expect(captureVideoFrame.mock.calls[0].slice(2)).toEqual([720, 900]);
    expect(renderPhotoJpeg).toHaveBeenCalledTimes(1);
    expect(renderPhotoJpeg.mock.calls[0].slice(1)).toEqual([720, 900]);
  });
});

describe('the frame travels with the project', () => {
  it('is written to the file and comes back with it', async () => {
    const user = userEvent.setup();
    await launched();
    seedTrack();

    await user.selectOptions(await screen.findByLabelText(PICKER), '9:16');
    await waitFor(() =>
      expect(stored).toMatchObject({ version: PROJECT_VERSION, aspectRatio: '9:16' }),
    );
  });

  it('opens a project written before the setting existed at 16:9, and never refuses it', async () => {
    // Exactly the bytes an older build wrote: no `aspectRatio` field anywhere.
    const legacy: Omit<ProjectFile, 'aspectRatio'> = {
      version: PROJECT_VERSION,
      assets: [
        { id: 'asset_p', name: 'cliff.png', kind: 'photo', path: '/media/cliff.png', sizeBytes: 2048 },
      ],
      clips: [
        {
          id: 'clip_1',
          assetId: 'asset_p',
          kind: 'photo',
          name: 'cliff.png',
          startMs: 0,
          durationMs: 5000,
          trimStartMs: 0,
        },
      ],
      audioTracks: [],
      cutPrompts: {},
      cutModes: {},
    };
    stored = legacy;
    launch();

    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(1));
    expect(useEditor.getState().aspectRatio).toBe('16:9');
    expect(await screen.findByLabelText(PICKER)).toHaveValue('16:9');
  });

  it('restores the ratio a stored project was saved at', async () => {
    stored = {
      version: PROJECT_VERSION,
      aspectRatio: '4:5',
      assets: [
        { id: 'asset_p', name: 'cliff.png', kind: 'photo', path: '/media/cliff.png', sizeBytes: 2048 },
      ],
      clips: [
        {
          id: 'clip_1',
          assetId: 'asset_p',
          kind: 'photo',
          name: 'cliff.png',
          startMs: 0,
          durationMs: 5000,
          trimStartMs: 0,
        },
      ],
      audioTracks: [],
      cutPrompts: {},
      cutModes: {},
    };
    launch();

    await waitFor(() => expect(useEditor.getState().aspectRatio).toBe('4:5'));
    expect(await screen.findByLabelText(PICKER)).toHaveValue('4:5');
  });

  it('falls back rather than refusing a file someone hand-edited to a shape that does not exist', async () => {
    stored = {
      version: PROJECT_VERSION,
      aspectRatio: '7:3',
      assets: [
        { id: 'asset_p', name: 'cliff.png', kind: 'photo', path: '/media/cliff.png', sizeBytes: 2048 },
      ],
      clips: [
        {
          id: 'clip_1',
          assetId: 'asset_p',
          kind: 'photo',
          name: 'cliff.png',
          startMs: 0,
          durationMs: 5000,
          trimStartMs: 0,
        },
      ],
      audioTracks: [],
      cutPrompts: {},
      cutModes: {},
    };
    launch();

    // The timeline is worth far more than the ratio it was drawn at.
    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(1));
    expect(useEditor.getState().aspectRatio).toBe('16:9');
  });
});
