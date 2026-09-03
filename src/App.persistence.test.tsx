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

import { StrictMode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { useEditor } from './state/store';
import { resetEditor } from './test/harness';
import * as backend from './lib/backend';
import { DEFAULT_ASPECT_RATIO } from './lib/aspect';
import { PROJECT_VERSION, type ProjectFile } from './lib/project';
import type { GenerateInput, GenerationUpdate } from './lib/backend';

/** What is on disk for this test. `null` is a fresh install. */
let stored: unknown = null;
/** Paths the filesystem admits to having, for the restore probe. */
let onDisk: Set<string> = new Set();
/**
 * The close handler the app registered, or `null` before it has armed one.
 *
 * Calling it is the window's red X. `null` is an assertion in its own right: until the
 * restore has answered there is no listener, which is what lets a close during a slow read
 * go through natively and write nothing.
 */
let requestClose: (() => Promise<void>) | null = null;
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
  recentProjects: vi.fn(async () => []),
  newProjectPath: vi.fn(async (name: string) => `/docs/${name}.solcut`),
  createProject: vi.fn(async () => {}),
  generateAnimation: vi.fn(async (_input: GenerateInput) => {}),
  generateImage: vi.fn(async () => {}),
  cancelGeneration: vi.fn(async () => {}),
  ffmpegAvailable: async () => true,
  exportTimeline: vi.fn(),
  onGenerationUpdate: async (_cb: (u: GenerationUpdate) => void) => () => {},
  onExportProgress: async () => () => {},
  onWindowClose: async (cb: () => void | Promise<void>) => {
    requestClose = async () => {
      await cb();
    };
    return () => {
      requestClose = null;
    };
  },
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
    aspectRatio: DEFAULT_ASPECT_RATIO,
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
  requestClose = null;
  onDisk = new Set([PHOTO_PATH, SOUND_PATH]);
  saveProject.mockClear();
  vi.mocked(backend.loadProject).mockClear();
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

/**
 * Mount the editor the way `main.tsx` actually mounts it.
 *
 * Under `<StrictMode>` on purpose. Every suite here used to render a bare `<App/>` while the
 * real entry point wrapped it, and that gap is exactly how a broken double-mount guard
 * shipped: the restore ran twice, the second run decided the editor had been in use, and
 * autosave was off for the whole session with nothing but a plausible-looking toast to show
 * for it.
 */
function launch() {
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

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
    launch();

    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(1));
    expect(timeline()).toEqual({
      clips: ['clip_1@0+5000'],
      lanes: ['track_1@1000v0.5'],
      bin: ['cliff.png', 'score.mp3'],
    });
    // The `asset:` URL is rebuilt from the stored path, never restored from the old session.
    expect(useEditor.getState().assets.asset_p.src).toBe(`asset://${PHOTO_PATH}`);
    // The scratch is the untitled project, and the bar says so — it names the project now
    // rather than counting its clips, which the timeline was already showing.
    expect(screen.getByRole('button', { name: 'Untitled project' })).toBeInTheDocument();
  });

  it('starts empty on a fresh install, and says nothing about it', async () => {
    launch();
    await waitFor(() => expect(backend.loadProject).toHaveBeenCalled());

    expect(useEditor.getState().clips).toEqual([]);
    expect(useEditor.getState().toasts).toEqual([]);
    expect(screen.getByText('Untitled project')).toBeInTheDocument();
  });

  /** A generation's job died with the process, so a restored one would never finish. */
  it('restores no part of the session that made it', async () => {
    stored = { ...storedProject(), generations: { gen_1: { status: 'running' } }, playing: true, film: { id: 'film_1' } };
    launch();

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
    launch();

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
    launch();

    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(1));
    await waitFor(() => expect(backend.importPaths).toHaveBeenCalled());
    expect(useEditor.getState().assets.asset_p.missing).toBeUndefined();
  });
});

describe('autosaving as the timeline changes', () => {
  async function launchEmpty() {
    launch();
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
    launch();

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
    launch();
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
    launch();

    expect(await screen.findByText('The saved project could not be read')).toBeInTheDocument();
    act(() => {
      useEditor.setState({ clips: [{ id: 'clip_x', assetId: 'asset_p', kind: 'photo', name: 'a.png', startMs: 0, durationMs: 5000, trimStartMs: 0 }] });
    });
    await waitFor(() => expect(saveProject).toHaveBeenCalled(), { timeout: 3000 });
  });
});


/** One photo clip, at a start the assertions can tell apart. */
function clipAt(startMs: number, id = 'clip_1') {
  return { id, assetId: 'asset_p', kind: 'photo' as const, name: 'cliff.png', startMs, durationMs: 5000, trimStartMs: 0 };
}

/** Mount, and wait until the persistence hook has finished arming its writers. */
async function launchArmed() {
  launch();
  await waitFor(() => expect(requestClose).not.toBeNull(), { timeout: 3000 });
}

describe('a launch that must not restore twice', () => {
  /**
   * The bug this is here to stop coming back, and it is worth stating plainly because the
   * symptom looked exactly like a feature working: the restore ran twice, the second run
   * found the first run's clips on the timeline, decided the user had got there first, and
   * turned saving off — for the whole session, behind a toast that reads as a design
   * decision. Every launch of the dev app with a project in it saved nothing at all.
   */
  it('reads the project once, and leaves autosave on', async () => {
    stored = storedProject();
    launch();

    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(1));
    // Long enough for a second restore to have resolved and drawn its conclusion.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(backend.loadProject).toHaveBeenCalledTimes(1);
    expect(useEditor.getState().saveBlocked).toBe(false);
    expect(screen.queryByText('The saved project was not restored')).toBeNull();

    act(() => {
      useEditor.setState({ clips: [...useEditor.getState().clips, clipAt(6000, 'clip_2')] });
    });
    await waitFor(() => expect(saveProject).toHaveBeenCalled(), { timeout: 3000 });
    expect((stored as ProjectFile).clips.map((c) => c.id)).toEqual(['clip_1', 'clip_2']);
  });
});

describe('the window closing', () => {
  /** Quitting does not wait half a second for a debounce, so the flush has to not need one. */
  it('writes the pending edit before the window is allowed to go', async () => {
    await launchArmed();

    act(() => useEditor.setState({ clips: [clipAt(0)] }));
    // Load-bearing: without it this passes even when the flush does nothing and the
    // ordinary debounce is what saved the work.
    expect(saveProject).not.toHaveBeenCalled();

    await act(async () => {
      await requestClose!();
    });

    expect(saveProject).toHaveBeenCalledTimes(1);
    expect((stored as ProjectFile).clips.map((c) => c.id)).toEqual(['clip_1']);
  });

  /**
   * The rule the whole hook is built on, now that there is more than one writer.
   *
   * A project on a spun-down drive takes seconds to read. Close the window in that gap and
   * an ungated flush would write the empty editor over it — atomically, with no half-written
   * file left to recover from.
   */
  it('writes nothing while the restore is still in flight', async () => {
    stored = storedProject();
    const untouched = JSON.stringify(stored);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(backend.loadProject).mockImplementation(async () => {
      await held;
      return stored;
    });

    launch();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // No listener at all yet, so a close goes through natively and writes nothing.
    expect(requestClose).toBeNull();
    expect(saveProject).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(1));
    await waitFor(() => expect(requestClose).not.toBeNull(), { timeout: 3000 });
    expect(JSON.stringify(stored)).toBe(untouched);
  });
});

describe('the periodic save', () => {
  /**
   * The change stream cannot help here: the write already happened and failed, and there is
   * no second edit coming. Before this, the work sat unwritten until the user happened to
   * touch something.
   */
  it('retries a write that failed, with no edit to prompt it', async () => {
    await launchArmed();
    vi.mocked(backend.saveProject).mockRejectedValue(new Error('the disk is full'));

    act(() => useEditor.setState({ clips: [clipAt(0)] }));
    expect(await screen.findByText('Not saved', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(saveProject).not.toHaveBeenCalled();

    // The drive comes back. Nothing else happens — no edit, no click, no quit.
    vi.mocked(backend.saveProject).mockImplementation(saveProject);
    await waitFor(() => expect(saveProject).toHaveBeenCalled(), { timeout: 12_000 });
    expect((stored as ProjectFile).clips.map((c) => c.id)).toEqual(['clip_1']);

    const bar = document.querySelector('.titlebar') as HTMLElement;
    await waitFor(() => expect(within(bar).getByText('Saved')).toBeInTheDocument(), { timeout: 3000 });
  }, 20_000);

  /**
   * Where the user is looking deliberately triggers no write of its own — the playhead moves
   * sixty times a second — so this interval is the only thing that gets it to disk.
   */
  it('writes where the user is looking, which no edit would have carried', async () => {
    await launchArmed();
    act(() => useEditor.setState({ clips: [clipAt(0)] }));
    await waitFor(() => expect(saveProject).toHaveBeenCalledTimes(1), { timeout: 3000 });

    act(() => {
      useEditor.getState().setPlayhead(2500);
      useEditor.setState({ pxPerSecond: 80, snapping: false });
    });
    // Not on sight: nothing about the viewport is worth interrupting a drag for.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saveProject).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(saveProject).toHaveBeenCalledTimes(2), { timeout: 12_000 });
    expect((stored as ProjectFile).view).toEqual({ playheadMs: 2500, pxPerSecond: 80, snapping: false });
  }, 20_000);
});

describe('where the user was looking', () => {
  it('comes back at the same playhead, zoom and snap', async () => {
    stored = storedProject({ view: { playheadMs: 3200, pxPerSecond: 64, snapping: false } });
    launch();

    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(1));
    const s = useEditor.getState();
    expect(s.playheadMs).toBe(3200);
    expect(s.pxPerSecond).toBe(64);
    expect(s.snapping).toBe(false);
  });

  /** A project that never stored one does not get to reset the zoom the user is working at. */
  it('leaves the view alone when the stored project has none', async () => {
    stored = storedProject();
    act(() => useEditor.setState({ pxPerSecond: 123 }));
    launch();

    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(1));
    expect(useEditor.getState().pxPerSecond).toBe(123);
  });
});

describe('a render interrupted by the restart', () => {
  /** Two adjacent photos, so the pair still forms a cut a record can be retried onto. */
  function projectMidRender(): ProjectFile {
    return {
      ...storedProject(),
      clips: [clipAt(0), clipAt(5000, 'clip_2')],
      generations: [
        {
          id: 'gen_cut',
          target: {
            kind: 'cut',
            afterClipId: 'clip_1',
            beforeClipId: 'clip_2',
            from: { clipId: 'clip_1', assetId: 'asset_p' },
            to: { clipId: 'clip_2', assetId: 'asset_p' },
          },
          prompt: 'a gentle push in',
          modelId: 'seedance_2_5',
        },
        {
          id: 'gen_img',
          target: { kind: 'image', referenceAssetIds: [], aspect: '16:9' },
          prompt: 'a cliff at dusk',
          modelId: 'nano_banana_pro',
        },
      ],
    };
  }

  it('comes back as a card that offers Retry, and re-sends nothing by itself', async () => {
    stored = projectMidRender();
    launch();

    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(2));

    // The photo's card stands at the top of the bin whatever is selected.
    expect(await screen.findByText('Interrupted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry generating a cliff at dusk' })).toBeInTheDocument();
    // The cut's card is behind its own chip, which says so on the timeline.
    expect(screen.getByText('FAILED')).toBeInTheDocument();

    const restored = useEditor.getState().generations;
    expect(restored.gen_cut.status).toBe('failed');
    expect(restored.gen_cut.error?.retryable).toBe(true);
    // The handle on a job nothing can re-attach to is deliberately not among them.
    expect(restored.gen_cut.jobId).toBeUndefined();

    // Nothing was re-submitted, and the bar's live-render count does not claim otherwise.
    expect(backend.generateAnimation).not.toHaveBeenCalled();
    expect(backend.generateImage).not.toHaveBeenCalled();
    const bar = document.querySelector('.titlebar') as HTMLElement;
    expect(within(bar).getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(within(bar).queryByText(/rendering/)).toBeNull();
  });

  /**
   * The card is a report about the session that was interrupted, not a to-do that follows
   * the project around for ever. It is written down only while a render is actually in
   * flight, so once it has been shown the next write lets it go — the timeline it belongs
   * to is untouched either way, and the cut is still one tap from being generated again.
   */
  it('is reported once, and not carried forward into the session after that', async () => {
    stored = projectMidRender();
    launch();
    await waitFor(() => expect(useEditor.getState().clips).toHaveLength(2));
    expect(await screen.findByText('Interrupted')).toBeInTheDocument();

    act(() => useEditor.setState({ clips: [clipAt(0), clipAt(6000, 'clip_2')] }));
    await waitFor(() => expect(saveProject).toHaveBeenCalled(), { timeout: 3000 });
    expect((stored as ProjectFile).generations).toBeUndefined();
    // The work itself is exactly where it was.
    expect((stored as ProjectFile).clips.map((c) => c.id)).toEqual(['clip_1', 'clip_2']);
  });
});
