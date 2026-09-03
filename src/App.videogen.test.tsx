/**
 * Generating a video in the media bin, driven through the real UI.
 *
 * The companion to `App.imagegen.test.tsx`, and the same two stubs for the same reason:
 * the Tauri bridge and media decoding are the only things jsdom cannot provide. The store,
 * the bin and the create sheet underneath are the real thing, and the Rust half — the argv
 * a prompt-only video job actually sends — is covered by `cargo test -p solcut-higgsfield`.
 *
 * The probe stub deliberately answers with a length that is *not* the 5 s fallback, because
 * a generated video that is never measured lands at that fallback and stays there for good:
 * asserting the real number is the only way to tell the two apart.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { useEditor } from './state/store';
import { resetEditor } from './test/harness';
import * as backend from './lib/backend';
import type { GenerateImageInput, GenerateVideoInput, GenerationUpdate } from './lib/backend';
import type { MediaAsset } from './types/project';

/** What the probe answers, chosen so it cannot be confused with the 5 s fallback. */
const PROBED_MS = 8200;

const generateVideo = vi.fn(async (_input: GenerateVideoInput) => {});
const generateImage = vi.fn(async (_input: GenerateImageInput) => {});
const cancelGeneration = vi.fn(async (_id: string) => {});
let emitGenerationUpdate: (u: GenerationUpdate) => void = () => {};

const STORED_SETTINGS: backend.SettingsView = {
  configured: true,
  cliPath: '/usr/local/bin/higgsfield',
  customModel: '',
  hasApiKey: false,
  apiKeyIdHint: '',
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
  saveProject: vi.fn(async () => {}),
  generateAnimation: vi.fn(async () => {}),
  generateImage: (input: GenerateImageInput) => generateImage(input),
  generateVideo: (input: GenerateVideoInput) => generateVideo(input),
  cancelGeneration: (id: string) => cancelGeneration(id),
  ffmpegAvailable: async () => true,
  exportTimeline: vi.fn(),
  onGenerationUpdate: async (cb: (u: GenerationUpdate) => void) => {
    emitGenerationUpdate = cb;
    return () => {};
  },
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
  probeVideoDurationMs: async () => PROBED_MS,
  probeAudioDurationMs: async (_src: string, fallback: number) => fallback,
}));

function photo(id: string, name: string): MediaAsset {
  const path = `/photos/${name}`;
  return { id, name, kind: 'photo', path, src: `asset://${path}`, sizeBytes: 1024 };
}

async function mount() {
  render(<App />);
  await waitFor(() => expect(useEditor.getState().settings).not.toBeNull());
}

/** Open the sheet and switch it to video, the way a user does. */
async function openVideo(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Generate a photo or video' }));
  await user.click(screen.getByRole('button', { name: 'Video' }));
  return screen.getByLabelText('Describe the video to generate');
}

async function send(user: ReturnType<typeof userEvent.setup>, prompt: string) {
  const box = await openVideo(user);
  await user.type(box, prompt);
  await user.click(screen.getByRole('button', { name: /generate video/i }));
  await waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(1));
  return Object.keys(useEditor.getState().generations)[0];
}

function emit(update: Partial<GenerationUpdate> & { generationId: string }) {
  return act(async () => {
    emitGenerationUpdate({
      status: 'running',
      progress: 0.5,
      elapsedSecs: 4,
      slow: false,
      ...update,
    });
  });
}

beforeEach(() => {
  generateVideo.mockClear();
  generateImage.mockClear();
  cancelGeneration.mockClear();
  storedSettings = { ...STORED_SETTINGS };
  resetEditor();
});

describe('the create sheet switches between photo and video', () => {
  it('choosing Video swaps the model list, drops the aspect ratio, and renames the action', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole('button', { name: 'Generate a photo or video' }));

    // Photo is where it starts, and it discloses two controls.
    await user.click(screen.getByRole('button', { name: 'Options' }));
    expect(screen.getByLabelText('Image model')).toBeInTheDocument();
    expect(screen.getByLabelText('Aspect ratio')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate photo/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Video' }));

    // A prompt-only request carries no aspect ratio, so there is no control for one.
    expect(screen.queryByLabelText('Image model')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Aspect ratio')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate video/i })).toBeInTheDocument();

    // And the model list is the video catalog, not the image one.
    const models = screen.getByLabelText('Video model');
    expect(within(models).getByRole('option', { name: 'Seedance 2.5' })).toBeInTheDocument();
    expect(within(models).queryByRole('option', { name: 'Nano Banana Pro' })).toBeNull();
  });

  /**
   * The local backends composite an ffmpeg crossfade between two stills the editor hands
   * them. With no stills there is nothing to composite, so a menu entry for them here
   * would be one that always fails.
   */
  it('never offers a local backend, which cannot make a shot from words', async () => {
    const user = userEvent.setup();
    await mount();
    await openVideo(user);
    await user.click(screen.getByRole('button', { name: 'Options' }));

    const models = screen.getByLabelText('Video model');
    for (const label of ['Claude Code CLI', 'Codex CLI']) {
      expect(within(models).queryByRole('option', { name: label })).toBeNull();
    }
  });

  it('keeps the typed prompt across a switch — the medium changed, not the shot', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole('button', { name: 'Generate a photo or video' }));
    await user.type(screen.getByLabelText('Describe the photo to generate'), 'a lighthouse');

    await user.click(screen.getByRole('button', { name: 'Video' }));
    expect(screen.getByLabelText('Describe the video to generate')).toHaveValue('a lighthouse');

    await user.click(screen.getByRole('button', { name: 'Photo' }));
    expect(screen.getByLabelText('Describe the photo to generate')).toHaveValue('a lighthouse');
  });

  /**
   * The sheet floats over the stage but claims nothing: the bin beside it stays live,
   * which is what photo mode's reference picking needs and what a modal would take away.
   */
  it('is not a modal — no aria-modal, and the bin still works underneath it', async () => {
    const user = userEvent.setup();
    await mount();
    await openVideo(user);

    const sheet = screen.getByRole('dialog', { name: 'Generate a photo or video' });
    expect(sheet).not.toHaveAttribute('aria-modal');

    await user.click(screen.getByRole('button', { name: 'Import media' }));
    expect(backend.pickMediaFiles).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Generate a photo or video' })).toBeInTheDocument();
  });
});

describe('generating a video in the media bin', () => {
  it('sends the words and the model and nothing else', async () => {
    const user = userEvent.setup();
    await mount();
    await send(user, 'a drone rises over the surf');

    const sent = generateVideo.mock.calls[0][0];
    expect(sent.prompt).toBe('a drone rises over the surf');
    expect(sent.model).toBe('seedance_2_5');
    // Not the image path, and carrying none of its fields.
    expect(generateImage).not.toHaveBeenCalled();
    expect(Object.keys(sent).sort()).toEqual(['generationId', 'model', 'prompt']);
  });

  it('refuses an empty prompt, and refuses when Higgsfield is not connected', async () => {
    const user = userEvent.setup();
    storedSettings = { ...STORED_SETTINGS, configured: false };
    await mount();
    await openVideo(user);

    expect(screen.getByRole('button', { name: /generate video/i })).toBeDisabled();
    expect(screen.getByText('Connect Higgsfield to generate')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Describe the video to generate'), 'a shot');
    // Still refused: a prompt is not a connection.
    expect(screen.getByRole('button', { name: /generate video/i })).toBeDisabled();
    expect(generateVideo).not.toHaveBeenCalled();
  });

  it('lands in the bin as a measured video, and leaves the timeline alone', async () => {
    const user = userEvent.setup();
    await mount();
    const id = await send(user, 'a drone rises over the surf');

    await emit({
      generationId: id,
      status: 'succeeded',
      progress: 1,
      outputPath: '/home/u/.local/share/solcut/generated/gen_1.mp4',
    });

    const assets = Object.values(useEditor.getState().assets);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      kind: 'video',
      path: '/home/u/.local/share/solcut/generated/gen_1.mp4',
      name: 'gen_1.mp4',
    });
    // The whole point of the probe: an unmeasured video would sit at the 5 s fallback for
    // good, because nothing downstream of the bin ever measures one.
    await waitFor(() => {
      expect(Object.values(useEditor.getState().assets)[0].durationMs).toBe(PROBED_MS);
    });
    expect(useEditor.getState().clips).toEqual([]);
    expect(await screen.findByText('Video ready')).toBeInTheDocument();
  });

  /**
   * The sheet clears and closes on send, so the bin is the only surface left that can say
   * a render is running, that it failed, or offer its Retry.
   */
  it('reports its progress, its failure and its retry in the bin', async () => {
    const user = userEvent.setup();
    await mount();
    const id = await send(user, 'a drone rises over the surf');

    expect(
      screen.getByLabelText('Generating a drone rises over the surf'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Stop generating a drone rises over the surf' }),
    ).toBeInTheDocument();

    await emit({
      generationId: id,
      status: 'failed',
      progress: 0,
      error: { title: 'Higgsfield refused the job', message: 'try again', retryable: true },
    });

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Higgsfield refused the job')).toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: /^Retry generating/ }));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(2));
    // A retry is exact: the words and the model are both on the record.
    expect(generateVideo.mock.calls[1][0]).toMatchObject({
      prompt: 'a drone rises over the surf',
      model: 'seedance_2_5',
    });
  });

  it('names the kind it could not make, so a failed video does not read as a photo', async () => {
    const user = userEvent.setup();
    await mount();
    const id = await send(user, 'a drone rises over the surf');

    // No title from the backend: the card has to name the kind itself.
    await emit({ generationId: id, status: 'failed', progress: 0 });
    expect(await screen.findByText('The video could not be generated')).toBeInTheDocument();
  });

  /**
   * The expensive regression. A prompt-only video has no clip on the track that speaks for
   * it, so no edit to the track can doom it — and getting that backwards would cancel a
   * paid render because the user tidied up an unrelated tile.
   */
  it('survives the deletion of an unrelated bin asset', async () => {
    const user = userEvent.setup();
    await mount();
    const id = await send(user, 'a drone rises over the surf');

    act(() => {
      useEditor.setState({ assets: { a1: photo('a1', 'a.jpg') } });
    });
    await user.click(screen.getByRole('button', { name: 'Remove a.jpg' }));

    expect(useEditor.getState().generations[id]).toBeDefined();
    expect(useEditor.getState().generations[id].status).toBe('queued');
    expect(cancelGeneration).not.toHaveBeenCalled();
  });
});
