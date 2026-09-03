/**
 * Generating a photo in the media bin, driven through the real UI.
 *
 * The same two stubs as the other suites, for the same reason: the Tauri bridge and
 * canvas/media decoding are the only things jsdom cannot provide. The store, the bin and
 * the compose panel underneath are the real thing, and the Rust half of the same flow is
 * covered by `cargo test -p solcut-higgsfield`.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { useEditor } from './state/store';
import { resetEditor } from './test/harness';
import * as backend from './lib/backend';
import type { GenerateImageInput, GenerationUpdate } from './lib/backend';
import type { MediaAsset } from './types/project';

const generateImage = vi.fn(async (_input: GenerateImageInput) => {});
let emitGenerationUpdate: (u: GenerationUpdate) => void = () => {};

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

vi.mock('./lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/backend')>()),
  isDesktop: () => true,
  assetSrc: (p: string) => `asset://${p}`,
  getSettings: async () => storedSettings,
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  testApiKey: vi.fn(),
  importPaths: vi.fn(async () => ({ imported: [], rejected: [] })),
  loadProject: vi.fn(async () => null),
  readProject: vi.fn(async () => null),
  lastProjectPath: vi.fn(async () => null),
  recentProjects: vi.fn(async () => []),
  newProjectPath: vi.fn(async (name: string) => `/docs/${name}.solcut`),
  createProject: vi.fn(async () => {}),
  saveProject: vi.fn(async () => {}),
  pickProjectSavePath: vi.fn(async () => null),
  pickProjectFile: vi.fn(async () => null),
  generateAnimation: vi.fn(async () => {}),
  generateImage: (input: GenerateImageInput) => generateImage(input),
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

vi.mock('./lib/frames', () => ({
  FRAME_WIDTH: 1280,
  FRAME_HEIGHT: 720,
  renderPhotoJpeg: async (src: string) => `data:image/jpeg;base64,frame-of-${src}`,
  probeVideoDurationMs: async (_src: string, fallback: number) => fallback,
  probeAudioDurationMs: async (_src: string, fallback: number) => fallback,
}));

/** A bin photo as an import leaves it: a real path the CLI could upload. */
function photo(id: string, name: string, path = `/photos/${name}`): MediaAsset {
  return { id, name, kind: 'photo', path, src: `asset://${path}`, sizeBytes: 1024 };
}

function seedBin(...assets: MediaAsset[]) {
  useEditor.setState({ assets: Object.fromEntries(assets.map((a) => [a.id, a])) });
}

async function mount() {
  render(<App />);
  await waitFor(() => expect(useEditor.getState().settings).not.toBeNull());
}

/** Open the compose panel the way a user does. */
async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Generate a photo or video' }));
  return screen.getByLabelText('Describe the photo to generate');
}

const GENERATE = { name: /generate photo/i } as const;

function succeed(id: string, outputPath: string) {
  return act(async () => {
    emitGenerationUpdate({
      generationId: id,
      status: 'succeeded',
      progress: 1,
      elapsedSecs: 12,
      slow: false,
      outputPath,
    });
  });
}

beforeEach(() => {
  generateImage.mockClear();
  storedSettings = { ...STORED_SETTINGS };
  resetEditor();
});

describe('generating a photo in the media bin', () => {
  it('a prompt on its own is a whole request — no references, and the bin keeps its import button', async () => {
    const user = userEvent.setup();
    await mount();

    // Import did not go anywhere: the ticket adds a way in, it does not replace one.
    expect(screen.getByRole('button', { name: 'Import media' })).toBeInTheDocument();

    const prompt = await openPanel(user);
    await user.type(prompt, 'a quiet beach at sunrise');
    await user.click(screen.getByRole('button', GENERATE));

    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    const sent = generateImage.mock.calls[0][0];
    expect(sent.prompt).toBe('a quiet beach at sunrise');
    expect(sent.references).toEqual([]);
    // The default model and the frame the editor exports at.
    expect(sent.model).toBe('nano_banana_2');
    expect(sent.aspectRatio).toBe('16:9');

    // The generation owns the prompt now, so the panel is closed and clean.
    expect(screen.queryByLabelText('Describe the photo to generate')).not.toBeInTheDocument();
    expect(useEditor.getState().imagePanel.prompt).toBe('');
  });

  it('bin photos clicked as references travel as paths, in the order they were clicked', async () => {
    const user = userEvent.setup();
    await mount();
    seedBin(photo('asset_a', 'cliff.png'), photo('asset_b', 'sunset.jpg'));

    const prompt = await openPanel(user);
    await user.type(prompt, 'the same coast, at night');

    // The bin itself is the picker — the panel never covers it.
    await user.click(screen.getByRole('button', { name: 'Use sunset.jpg as a reference' }));
    await user.click(screen.getByRole('button', { name: 'Use cliff.png as a reference' }));
    expect(screen.getByRole('button', { name: 'Use sunset.jpg as a reference' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', GENERATE));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    expect(generateImage.mock.calls[0][0].references).toEqual([
      '/photos/sunset.jpg',
      '/photos/cliff.png',
    ]);
  });

  it('clicking a picked photo again takes it back off', async () => {
    const user = userEvent.setup();
    await mount();
    seedBin(photo('asset_a', 'cliff.png'));

    const prompt = await openPanel(user);
    await user.type(prompt, 'x');
    const tile = () => screen.getByRole('button', { name: 'Use cliff.png as a reference' });
    await user.click(tile());
    expect(tile()).toHaveAttribute('aria-pressed', 'true');
    await user.click(tile());
    expect(tile()).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', GENERATE));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    expect(generateImage.mock.calls[0][0].references).toEqual([]);
  });

  /**
   * The bug this guards: a photo dropped from a browser has no filesystem path and is not
   * flagged missing, so it looks perfectly usable in the bin. Offering it would send an
   * empty path that fails somewhere inside the CLI, about nothing the user could name.
   */
  it('a photo with no file on disk is never offered as a reference', async () => {
    const user = userEvent.setup();
    await mount();
    seedBin(photo('asset_a', 'dropped.png', ''), photo('asset_b', 'real.png'));

    const prompt = await openPanel(user);
    await user.type(prompt, 'x');

    expect(
      screen.queryByRole('button', { name: 'Use dropped.png as a reference' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use real.png as a reference' })).toBeInTheDocument();

    // Even asked for directly, the store refuses it rather than sending an empty path.
    act(() => useEditor.getState().toggleImageReference('asset_a'));
    expect(useEditor.getState().imagePanel.referenceAssetIds).toEqual([]);

    await user.click(screen.getByRole('button', GENERATE));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    expect(generateImage.mock.calls[0][0].references).toEqual([]);
  });

  it('a video in the bin is not a reference', async () => {
    const user = userEvent.setup();
    await mount();
    useEditor.setState({
      assets: {
        asset_v: {
          id: 'asset_v',
          name: 'clip.mp4',
          kind: 'video',
          path: '/v/clip.mp4',
          src: 'asset:///v/clip.mp4',
          sizeBytes: 2048,
        },
      },
    });

    await openPanel(user);
    expect(
      screen.queryByRole('button', { name: 'Use clip.mp4 as a reference' }),
    ).not.toBeInTheDocument();
  });

  it('the finished photo lands in the bin and the timeline is left alone', async () => {
    const user = userEvent.setup();
    await mount();

    const prompt = await openPanel(user);
    await user.type(prompt, 'a lighthouse');
    await user.click(screen.getByRole('button', GENERATE));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));

    const id = Object.keys(useEditor.getState().generations)[0];
    await succeed(id, '/home/u/.local/share/solcut/generated/gen_1.png');

    const assets = Object.values(useEditor.getState().assets);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      kind: 'photo',
      path: '/home/u/.local/share/solcut/generated/gen_1.png',
      // The file's own name, so the label cannot disagree with what is on disk.
      name: 'gen_1.png',
    });
    // The whole promise of "lands in the bin only".
    expect(useEditor.getState().clips).toEqual([]);
    expect(await screen.findByText('Photo ready')).toBeInTheDocument();
  });

  it('a failed generation says why, and Retry re-sends the same prompt and references', async () => {
    const user = userEvent.setup();
    await mount();
    seedBin(photo('asset_a', 'cliff.png'));

    const prompt = await openPanel(user);
    await user.type(prompt, 'the same coast, at night');
    await user.click(screen.getByRole('button', { name: 'Use cliff.png as a reference' }));
    await user.click(screen.getByRole('button', GENERATE));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));

    const id = Object.keys(useEditor.getState().generations)[0];
    await act(async () => {
      emitGenerationUpdate({
        generationId: id,
        status: 'failed',
        progress: 0,
        elapsedSecs: 3,
        slow: false,
        error: {
          title: 'Higgsfield refused the request',
          message: 'Unknown model "nano_banana_99".',
          retryable: false,
          build: '0.1.0+abc123',
        },
      });
    });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Higgsfield refused the request')).toBeInTheDocument();
    // Not retryable, so it is not offered — only dismissed.
    expect(
      within(alert).queryByRole('button', { name: /^Retry generating/ }),
    ).not.toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: /^Dismiss the failed photo/ }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a retryable failure offers Retry, which re-sends exactly what the first attempt did', async () => {
    const user = userEvent.setup();
    await mount();
    seedBin(photo('asset_a', 'cliff.png'));

    const prompt = await openPanel(user);
    await user.type(prompt, 'the same coast, at night');
    await user.click(screen.getByRole('button', { name: 'Use cliff.png as a reference' }));
    await user.click(screen.getByRole('button', GENERATE));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));

    const id = Object.keys(useEditor.getState().generations)[0];
    await act(async () => {
      emitGenerationUpdate({
        generationId: id,
        status: 'failed',
        progress: 0,
        elapsedSecs: 3,
        slow: false,
        error: { title: 'Higgsfield is unavailable', message: 'HTTP 503', retryable: true },
      });
    });

    generateImage.mockClear();
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: /^Retry generating/ }));

    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    const resent = generateImage.mock.calls[0][0];
    expect(resent.prompt).toBe('the same coast, at night');
    expect(resent.references).toEqual(['/photos/cliff.png']);
  });

  it('a reference removed from the bin before a retry is simply not re-sent', async () => {
    const user = userEvent.setup();
    await mount();
    seedBin(photo('asset_a', 'cliff.png'));

    const prompt = await openPanel(user);
    await user.type(prompt, 'the same coast');
    await user.click(screen.getByRole('button', { name: 'Use cliff.png as a reference' }));
    await user.click(screen.getByRole('button', GENERATE));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));

    const id = Object.keys(useEditor.getState().generations)[0];
    await act(async () => {
      emitGenerationUpdate({
        generationId: id,
        status: 'failed',
        progress: 0,
        elapsedSecs: 3,
        slow: false,
        error: { title: 'Higgsfield is unavailable', message: 'HTTP 503', retryable: true },
      });
    });

    act(() => useEditor.getState().removeAsset('asset_a'));
    generateImage.mockClear();
    act(() => {
      useEditor.getState().retryGeneration(id);
    });

    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    expect(generateImage.mock.calls[0][0].references).toEqual([]);
  });

  it('the options disclosure picks a model, and the aspect list follows it', async () => {
    const user = userEvent.setup();
    await mount();

    const prompt = await openPanel(user);
    await user.type(prompt, 'a diagram of the water cycle');

    // Closed by default: the plain path is type, then Generate.
    expect(screen.queryByLabelText('Image model')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Options' }));

    // FLUX.2 publishes five ratios; Nano Banana Pro publishes ten.
    expect(within(screen.getByLabelText('Aspect ratio')).getAllByRole('option')).toHaveLength(10);
    await user.selectOptions(screen.getByLabelText('Image model'), 'flux-2');
    expect(within(screen.getByLabelText('Aspect ratio')).getAllByRole('option')).toHaveLength(5);

    await user.selectOptions(screen.getByLabelText('Aspect ratio'), '9:16');
    await user.click(screen.getByRole('button', GENERATE));

    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    expect(generateImage.mock.calls[0][0]).toMatchObject({ model: 'flux_2', aspectRatio: '9:16' });
  });

  /** Switching to a model that does not publish the chosen ratio must not send it. */
  it('a ratio the new model does not take is swapped for one it does', async () => {
    const user = userEvent.setup();
    await mount();

    const prompt = await openPanel(user);
    await user.type(prompt, 'a poster');
    await user.click(screen.getByRole('button', { name: 'Options' }));
    await user.selectOptions(screen.getByLabelText('Aspect ratio'), '21:9');
    // FLUX.2 has no 21:9.
    await user.selectOptions(screen.getByLabelText('Image model'), 'flux-2');

    await user.click(screen.getByRole('button', GENERATE));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    expect(generateImage.mock.calls[0][0].aspectRatio).toBe('16:9');
  });

  it('with no Higgsfield CLI it refuses up front, points at settings, and sends nothing', async () => {
    storedSettings = { ...STORED_SETTINGS, configured: false, cliPath: null };
    const user = userEvent.setup();
    await mount();

    const prompt = await openPanel(user);
    await user.type(prompt, 'a quiet beach');

    const callout = screen.getByRole('status');
    expect(within(callout).getByText('Connect Higgsfield to generate')).toBeInTheDocument();
    expect(screen.getByRole('button', GENERATE)).toBeDisabled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('Generate stays out of reach until something has been asked for', async () => {
    const user = userEvent.setup();
    await mount();

    const prompt = await openPanel(user);
    expect(screen.getByRole('button', GENERATE)).toBeDisabled();
    await user.type(prompt, '   ');
    expect(screen.getByRole('button', GENERATE)).toBeDisabled();
    await user.type(prompt, 'a lighthouse');
    expect(screen.getByRole('button', GENERATE)).toBeEnabled();
  });

  it('a second photo can be asked for while the first is still rendering', async () => {
    const user = userEvent.setup();
    await mount();

    let prompt = await openPanel(user);
    await user.type(prompt, 'first');
    await user.click(screen.getByRole('button', GENERATE));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));

    prompt = await openPanel(user);
    await user.type(prompt, 'second');
    await user.click(screen.getByRole('button', GENERATE));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(2));

    expect(Object.keys(useEditor.getState().generations)).toHaveLength(2);
    expect(generateImage.mock.calls.map((c) => c[0].prompt)).toEqual(['first', 'second']);
  });

  it('closing the panel keeps the draft, so Escape is not a way to lose a prompt', async () => {
    const user = userEvent.setup();
    await mount();

    const prompt = await openPanel(user);
    await user.type(prompt, 'half a thought');
    await user.click(screen.getByRole('button', { name: 'Close the generate panel' }));
    expect(screen.queryByLabelText('Describe the photo to generate')).not.toBeInTheDocument();

    await openPanel(user);
    expect(screen.getByLabelText('Describe the photo to generate')).toHaveValue('half a thought');
    expect(generateImage).not.toHaveBeenCalled();
  });
});
