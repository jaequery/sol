/**
 * The saved project, end to end: launch, restore, edit, autosave.
 *
 * The one claim this suite cannot make is the one only the packaged app can — that the
 * file is still there tomorrow. What it *can* pin down is everything around it: that the
 * timeline comes back, that a session's own state does not, that a project which cannot be
 * read is never quietly replaced, and that the playhead sweeping sixty times a second does
 * not write the file sixty times a second.
 *
 * Timers are real here on purpose. The debounce is half a second and the assertions wait
 * for it, which is slower than faking the clock but leaves the hook's own scheduling
 * honest rather than mocked out from under it.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { useEditor } from './state/store';
import { resetEditor } from './test/harness';
import * as backend from './lib/backend';
import { PROJECT_VERSION, type ProjectFile } from './lib/project';
import type { GenerateInput, GenerationUpdate } from './lib/backend';

/** What is on disk for this test. `null` is a fresh install. */
let stored: unknown = null;
/** Paths the filesystem admits to having, for the restore probe. */
let onDisk: Set<string> = new Set();
const saveProject = vi.fn(async (project: unknown) => {
  stored = project;
});

vi.mock('./lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/backend')>()),
  isDesktop: () => true,
  assetSrc: (p: string) => `asset://${p}`,
  getSettings: async () => ({ configured: true, cliPath: '/usr/local/bin/higgsfield', customModel: '' }),
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  testApiKey: vi.fn(),
  importPaths: vi.fn(),
  loadProject: vi.fn(),
  saveProject: vi.fn(),
  generateAnimation: vi.fn(async (_input: GenerateInput) => {}),
  generateImage: vi.fn(async () => {}),
  cancelGeneration: vi.fn(async () => {}),
  ffmpegAvailable: async () => true,
  exportTimeline: vi.fn(),
  onGenerationUpdate: async (_cb: (u: GenerationUpdate) => void) => () => {},
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

const PHOTO_PATH = '/media/cliff.png';
const SOUND_PATH = '/media/score.mp3';

/** A project as the last session would have left it: one photo on the track, one lane. */
function storedProject(over: Partial<ProjectFile> = {}): ProjectFile {
  return {
    version: PROJECT_VERSION,
    assets: [
      { id: 'asset_p', name: 'cliff.png', kind: 'photo', path: PHOTO_PATH, sizeBytes: 2048 },
      { id: 'asset_s', name: 'score.mp3', kind: 'audio', path: SOUND_PATH, sizeBytes: 4096, durationMs: 30_000 },
    ],
    clips: [
      { id: 'clip_1', assetId: 'asset_p', kind: 'photo', name: 'cliff.png', startMs: 0, durationMs: 5000, trimStartMs: 0 },
    ],
    audioTracks: [
      { id: 'track_1', assetId: 'asset_s', name: 'score.mp3', startMs: 1000, durationMs: 8000, trimStartMs: 0, volume: 0.5, muted: false },
    ],
    cutPrompts: {},
    cutModes: {},
    ...over,
  };
}

beforeEach(() => {
  stored = null;
  onDisk = new Set([PHOTO_PATH, SOUND_PATH]);
  saveProject.mockClear();
  resetEditor();

  vi.mocked(backend.loadProject).mockImplementation(async () => stored);
  vi.mocked(backend.saveProject).mockImplementation(saveProject);
  // The restore probe goes through the same command an import does: it only stats.
  vi.mocked(backend.importPaths).mockImplementation(async (paths: string[]) => ({
    imported: paths
      .filter((p) => onDisk.has(p))
      .map((p) => ({ path: p, name: p.split('/').pop() ?? p, kind: 'photo' as const, sizeBytes: 1 })),
    rejected: paths
      .filter((p) => !onDisk.has(p))
      .map((p) => ({ path: p, name: p.split('/').pop() ?? p, reason: 'the file could not be read at that path' })),
  }));
});

/** The store's document, as an assertion-friendly shape. */
function timeline() {
  const s = useEditor.getState();
  return {
    clips: s.clips.map((c) => `${c.id}@${c.startMs}+${c.durationMs}`),
    lanes: s.audioTracks.map((t) => `${t.id}@${t.startMs}v${t.volume}`),
    bin: Object.values(s.assets).map((a) => a.name).sort(),
  };
}

describe('restoring at launch', () => {
  it('puts the last session’s timeline, lanes and media bin back', async () => {
    stored = storedProject();
    render(<App />);

    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(1));
    expect(timeline()).toEqual({
      clips: ['clip_1@0+5000'],
      lanes: ['track_1@1000v0.5'],
      bin: ['cliff.png', 'score.mp3'],
    });
    // The `asset:` URL is rebuilt from the stored path, never restored from the old session.
    expect(useEditor.getState().assets.asset_p.src).toBe(`asset://${PHOTO_PATH}`);
    expect(screen.getByText('1 clips')).toBeInTheDocument();
  });

  it('starts empty on a fresh install, and says nothing about it', async () => {
    render(<App />);
    await waitFor(() => expect(backend.loadProject).toHaveBeenCalled());

    expect(useEditor.getState().clips).toEqual([]);
    expect(useEditor.getState().toasts).toEqual([]);
    expect(screen.getByText('Untitled project')).toBeInTheDocument();
  });

  /** A generation's job died with the process, so a restored one would never finish. */
  it('restores no part of the session that made it', async () => {
    stored = { ...storedProject(), generations: { gen_1: { status: 'running' } }, playing: true, film: { id: 'film_1' } };
    render(<App />);

    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(1));
    expect(useEditor.getState().generations).toEqual({});
    expect(useEditor.getState().film).toBeNull();
    expect(useEditor.getState().playing).toBe(false);
    expect(useEditor.getState().selection).toEqual({ kind: 'none' });
  });
});

describe('media that went missing between sessions', () => {
  beforeEach(() => {
    onDisk = new Set([SOUND_PATH]);
    stored = storedProject();
  });

  it('comes back marked, named in one toast, and blocks the export it would break', async () => {
    render(<App />);

    await waitFor(() => expect(useEditor.getState().assets.asset_p?.missing).toBe(true));
    expect(await screen.findByText('1 file is no longer on disk')).toBeInTheDocument();
    expect(screen.getByText(/^cliff\.png — re-import it and put it back/)).toBeInTheDocument();
    // The sound was where it was left, so it is untouched.
    expect(useEditor.getState().assets.asset_s.missing).toBeUndefined();

    // The pre-check tests the file, not just the path: a stored path that no longer
    // resolves would otherwise sail through and die inside ffmpeg.
    await act(async () => {
      await useEditor.getState().runExport();
    });
    expect(backend.exportTimeline).not.toHaveBeenCalled();
    expect(useEditor.getState().exportState?.status).toBe('failed');
    expect(useEditor.getState().exportState?.error).toContain('cliff.png');
  });

  /** Only the probe failed. Calling all of it missing would make a working project look broken. */
  it('assumes the media is fine when the probe itself fails', async () => {
    vi.mocked(backend.importPaths).mockRejectedValue(new Error('the disk went away'));
    render(<App />);

    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(1));
    await waitFor(() => expect(backend.importPaths).toHaveBeenCalled());
    expect(useEditor.getState().assets.asset_p.missing).toBeUndefined();
  });
});

describe('autosaving as the timeline changes', () => {
  async function launchEmpty() {
    render(<App />);
    await waitFor(() => expect(backend.loadProject).toHaveBeenCalled());
  }

  it('writes the edit, and writes the document rather than the session', async () => {
    await launchEmpty();

    act(() => {
      useEditor.setState({
        assets: { asset_p: { id: 'asset_p', name: 'cliff.png', kind: 'photo', path: PHOTO_PATH, src: 'asset://x', sizeBytes: 1 } },
        clips: [{ id: 'clip_1', assetId: 'asset_p', kind: 'photo', name: 'cliff.png', startMs: 0, durationMs: 5000, trimStartMs: 0 }],
        playing: true,
        toasts: [{ id: 'toast_1', tone: 'ok', title: 'ignore me' }],
      });
    });

    await waitFor(() => expect(saveProject).toHaveBeenCalled(), { timeout: 3000 });
    const written = stored as ProjectFile;
    expect(written.version).toBe(PROJECT_VERSION);
    expect(written.clips.map((c) => c.id)).toEqual(['clip_1']);
    expect(JSON.stringify(written)).not.toContain('ignore me');
  });

  /**
   * The reason the subscription compares the document by reference rather than saving on
   * every store change: `advance` runs once a frame while playing.
   */
  it('does not write for a playhead that is only moving', async () => {
    await launchEmpty();
    act(() => {
      useEditor.setState({ playing: true });
      for (let i = 0; i < 30; i += 1) useEditor.getState().setPlayhead(i * 100);
    });

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saveProject).not.toHaveBeenCalled();
  });

  it('collapses a burst of edits into one write', async () => {
    await launchEmpty();
    act(() => {
      for (let i = 0; i < 10; i += 1) {
        useEditor.setState({
          clips: [{ id: 'clip_1', assetId: 'asset_p', kind: 'photo', name: 'a.png', startMs: i * 10, durationMs: 5000, trimStartMs: 0 }],
        });
      }
    });

    await waitFor(() => expect(saveProject).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(saveProject).toHaveBeenCalledTimes(1);
  });

  it('says so, once, when saving fails — and stops saying it when it recovers', async () => {
    await launchEmpty();
    vi.mocked(backend.saveProject).mockRejectedValue(new Error('the disk is full'));

    act(() => {
      useEditor.setState({ clips: [{ id: 'clip_1', assetId: 'asset_p', kind: 'photo', name: 'a.png', startMs: 0, durationMs: 5000, trimStartMs: 0 }] });
    });

    expect(await screen.findByText('Not saved', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText('The project could not be saved')).toBeInTheDocument();

    vi.mocked(backend.saveProject).mockImplementation(saveProject);
    act(() => {
      useEditor.setState({ clips: [{ id: 'clip_2', assetId: 'asset_p', kind: 'photo', name: 'a.png', startMs: 0, durationMs: 5000, trimStartMs: 0 }] });
    });
    await waitFor(() => expect(screen.queryByText('Not saved')).not.toBeInTheDocument(), { timeout: 3000 });
  });
});

describe('a stored project this build must not replace', () => {
  /** Overwriting it would destroy work a later build can still open. */
  it('leaves a newer project alone and saves nothing for the rest of the session', async () => {
    stored = { ...storedProject(), version: PROJECT_VERSION + 1 };
    render(<App />);

    expect(await screen.findByText('This project was saved by a newer SolCut')).toBeInTheDocument();
    expect(useEditor.getState().clips).toEqual([]);

    act(() => {
      useEditor.setState({ clips: [{ id: 'clip_x', assetId: 'asset_p', kind: 'photo', name: 'a.png', startMs: 0, durationMs: 5000, trimStartMs: 0 }] });
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saveProject).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ version: PROJECT_VERSION + 1 });
  });

  it('saves nothing when the project could not even be read off disk', async () => {
    vi.mocked(backend.loadProject).mockRejectedValue(new Error('permission denied'));
    render(<App />);
    await waitFor(() => expect(useEditor.getState().saveError).toBe('permission denied'));

    act(() => {
      useEditor.setState({ clips: [{ id: 'clip_x', assetId: 'asset_p', kind: 'photo', name: 'a.png', startMs: 0, durationMs: 5000, trimStartMs: 0 }] });
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saveProject).not.toHaveBeenCalled();
  });

  /**
   * Unreadable is not the same refusal: this build understands the format and what is
   * stored is not it, so the next edit is allowed to replace it. Otherwise a single bad
   * file would turn saving off forever with no way back.
   */
  it('replaces an unreadable project once the user edits, having said so', async () => {
    stored = { version: PROJECT_VERSION - 1, clips: [], assets: [] };
    render(<App />);

    expect(await screen.findByText('The saved project could not be read')).toBeInTheDocument();
    act(() => {
      useEditor.setState({ clips: [{ id: 'clip_x', assetId: 'asset_p', kind: 'photo', name: 'a.png', startMs: 0, durationMs: 5000, trimStartMs: 0 }] });
    });
    await waitFor(() => expect(saveProject).toHaveBeenCalled(), { timeout: 3000 });
  });
});
