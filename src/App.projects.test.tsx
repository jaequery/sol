/**
 * More than one project: naming one, opening another, starting a fresh one.
 *
 * `App.persistence.test.tsx` proves that *a* project survives a launch. This file proves
 * that there can be several, and — mostly — that no route between them loses one. Half of
 * these tests are about a switch that must **not** happen: a file that cannot be read, a
 * flush the disk refuses, the project that is already open being picked again. Those are
 * the paths where the cost of being wrong is somebody's work, so they are the ones written
 * down.
 *
 * The disk is a `Map` keyed by path, with `null` standing for the untitled scratch — the
 * same two-kinds-of-project shape the Rust side has. Timers are real, as next door, so the
 * debounce is the real one.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { useEditor } from './state/store';
import { resetEditor } from './test/harness';
import * as backend from './lib/backend';
import { PROJECT_VERSION, type ProjectFile } from './lib/project';
import type { GenerateInput, GenerationUpdate } from './lib/backend';

/** The untitled scratch's key on the fake disk. */
const SCRATCH = null;
const BEACH = '/x/beach.solcut';
const REEL = '/x/reel.solcut';

/** Everything on disk, by path. */
let disk = new Map<string | null, unknown>();
/** What `current.txt` holds: where the last write went. */
let pointer: string | null = null;
/** Set to a message to make the next write fail. */
let writeFails: string | null = null;

vi.mock('./lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/backend')>()),
  isDesktop: () => true,
  assetSrc: (p: string) => `asset://${p}`,
  getSettings: async () => ({ configured: true, cliPath: '/usr/local/bin/higgsfield', customModel: '' }),
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  testApiKey: vi.fn(),
  importPaths: vi.fn(async () => ({ imported: [], rejected: [] })),
  loadProject: vi.fn(),
  readProject: vi.fn(),
  lastProjectPath: vi.fn(),
  saveProject: vi.fn(),
  pickProjectSavePath: vi.fn(),
  pickProjectFile: vi.fn(),
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

/** A project holding one photo clip, named so the assertions can tell projects apart. */
function projectOf(name: string): ProjectFile {
  return {
    version: PROJECT_VERSION,
    assets: [{ id: `asset_${name}`, name: `${name}.png`, kind: 'photo', path: `/media/${name}.png`, sizeBytes: 2048 }],
    clips: [
      {
        id: `clip_${name}`,
        assetId: `asset_${name}`,
        kind: 'photo',
        name: `${name}.png`,
        startMs: 0,
        durationMs: 5000,
        trimStartMs: 0,
      },
    ],
    audioTracks: [],
    cutPrompts: {},
    cutModes: {},
  };
}

beforeEach(() => {
  disk = new Map();
  pointer = null;
  writeFails = null;
  resetEditor();

  vi.mocked(backend.loadProject).mockImplementation(async () => disk.get(SCRATCH) ?? null);
  vi.mocked(backend.lastProjectPath).mockImplementation(async () => pointer);
  vi.mocked(backend.readProject).mockImplementation(async (path: string) => {
    if (!disk.has(path)) throw new Error(`${path}: No such file or directory`);
    return disk.get(path);
  });
  vi.mocked(backend.saveProject).mockImplementation(async (project: unknown, path = null) => {
    if (writeFails) throw new Error(writeFails);
    disk.set(path ?? SCRATCH, project);
    pointer = path;
  });
  vi.mocked(backend.pickProjectSavePath).mockResolvedValue(null);
  vi.mocked(backend.pickProjectFile).mockResolvedValue(null);
});

// ----------------------------------------------------------------------------- helpers

/** Mount the editor and wait for the restore to have answered. */
async function mount() {
  render(<App />);
  await waitFor(() => expect(backend.lastProjectPath).toHaveBeenCalled());
}

/** Put a clip on the timeline the way an import would, without one. */
function seed(name: string) {
  const file = projectOf(name);
  act(() =>
    useEditor.setState({
      assets: { [file.assets[0].id]: { ...file.assets[0], src: `asset://${file.assets[0].path}` } },
      clips: file.clips,
    }),
  );
}

/** Open the title bar's project menu and click one of its items. */
async function menu(user: ReturnType<typeof userEvent.setup>, item: string) {
  const bar = document.querySelector('.titlebar') as HTMLElement;
  await user.click(within(bar).getByRole('button', { name: projectName() }));
  await user.click(screen.getByRole('button', { name: item }));
}

/** What the title bar is calling the open project. */
function projectName(): string {
  const bar = document.querySelector('.titlebar') as HTMLElement;
  return within(bar).getByRole('button', { expanded: false }).textContent ?? '';
}

const clipIds = () => useEditor.getState().clips.map((c) => c.id);
const savedClipIds = (path: string | null) =>
  ((disk.get(path) as ProjectFile | undefined)?.clips ?? []).map((c) => c.id);

// ----------------------------------------------------------------------------- save as

describe('giving a project a file', () => {
  it('writes the timeline where it was asked to, and names the bar after it', async () => {
    const user = userEvent.setup();
    await mount();
    seed('beach');

    vi.mocked(backend.pickProjectSavePath).mockResolvedValue(BEACH);
    await menu(user, 'Save as…');

    await waitFor(() => expect(disk.has(BEACH)).toBe(true));
    expect(savedClipIds(BEACH)).toEqual(['clip_beach']);
    expect(useEditor.getState().projectPath).toBe(BEACH);
    // The name is the file's, and the extension is not part of it.
    expect(screen.getByRole('button', { name: 'beach' })).toBeInTheDocument();
  });

  it('retargets autosave, so the next edit lands in the file and not the scratch', async () => {
    const user = userEvent.setup();
    await mount();
    seed('beach');

    vi.mocked(backend.pickProjectSavePath).mockResolvedValue(BEACH);
    await menu(user, 'Save as…');
    await waitFor(() => expect(disk.has(BEACH)).toBe(true));
    disk.delete(SCRATCH);

    act(() => useEditor.getState().setClipDuration('clip_beach', 9000));

    await waitFor(() => {
      const clips = (disk.get(BEACH) as ProjectFile).clips;
      expect(clips[0].durationMs).toBe(9000);
    });
    expect(disk.has(SCRATCH)).toBe(false);
  });

  it('changes nothing when the save panel is dismissed', async () => {
    const user = userEvent.setup();
    await mount();
    seed('beach');

    vi.mocked(backend.pickProjectSavePath).mockResolvedValue(null);
    await menu(user, 'Save as…');

    expect(useEditor.getState().projectPath).toBeNull();
    expect(disk.has(BEACH)).toBe(false);
  });
});

// ----------------------------------------------------------------------------- open

describe('opening another project', () => {
  it('puts the chosen project on screen and writes there from then on', async () => {
    const user = userEvent.setup();
    disk.set(REEL, projectOf('reel'));
    await mount();
    seed('beach');
    act(() => useEditor.setState({ projectPath: BEACH }));

    vi.mocked(backend.pickProjectFile).mockResolvedValue(REEL);
    await menu(user, 'Open project…');

    await waitFor(() => expect(clipIds()).toEqual(['clip_reel']));
    expect(useEditor.getState().projectPath).toBe(REEL);
    expect(screen.getByRole('button', { name: 'reel' })).toBeInTheDocument();
    // The project being left is written before the swap, not abandoned to its last autosave.
    expect(savedClipIds(BEACH)).toEqual(['clip_beach']);
  });

  it('refuses a file it cannot read, and leaves the open project exactly as it was', async () => {
    const user = userEvent.setup();
    // No version at all — some other JSON file the user picked by mistake. A file that
    // *does* carry this version but no clips is an empty project, and opens fine.
    disk.set(REEL, { notASolCutProject: true });
    await mount();
    seed('beach');
    act(() => useEditor.setState({ projectPath: BEACH }));

    vi.mocked(backend.pickProjectFile).mockResolvedValue(REEL);
    await menu(user, 'Open project…');

    await screen.findByText('That file is not a SolCut project');
    expect(clipIds()).toEqual(['clip_beach']);
    expect(useEditor.getState().projectPath).toBe(BEACH);
  });

  it('refuses a project from a newer build rather than opening it half-read', async () => {
    const user = userEvent.setup();
    disk.set(REEL, { ...projectOf('reel'), version: PROJECT_VERSION + 1 });
    await mount();
    seed('beach');
    act(() => useEditor.setState({ projectPath: BEACH }));

    vi.mocked(backend.pickProjectFile).mockResolvedValue(REEL);
    await menu(user, 'Open project…');

    await screen.findByText('That project was saved by a newer SolCut');
    expect(clipIds()).toEqual(['clip_beach']);
    // Untouched: refusing to open it is the whole point of refusing to open it.
    expect((disk.get(REEL) as ProjectFile).version).toBe(PROJECT_VERSION + 1);
  });

  it('does nothing at all when the project picked is the one already open', async () => {
    const user = userEvent.setup();
    disk.set(BEACH, projectOf('beach'));
    await mount();
    seed('beach');
    act(() => useEditor.setState({ projectPath: BEACH }));
    // An edit the debounce has not written yet — the state this used to lose.
    act(() => useEditor.getState().setClipDuration('clip_beach', 9000));

    vi.mocked(backend.pickProjectFile).mockResolvedValue(BEACH);
    await menu(user, 'Open project…');

    expect(useEditor.getState().clips[0].durationMs).toBe(9000);
    await waitFor(() => expect((disk.get(BEACH) as ProjectFile).clips[0].durationMs).toBe(9000));
  });
});

// ----------------------------------------------------------------------------- new

describe('starting a new project', () => {
  it('swaps silently out of a project that has a file, and that file keeps its work', async () => {
    const user = userEvent.setup();
    await mount();
    seed('beach');
    act(() => useEditor.setState({ projectPath: BEACH }));

    await menu(user, 'New project');

    await waitFor(() => expect(clipIds()).toEqual([]));
    expect(screen.queryByRole('dialog', { name: 'Save this project first?' })).toBeNull();
    expect(useEditor.getState().projectPath).toBeNull();
    expect(savedClipIds(BEACH)).toEqual(['clip_beach']);
  });

  it('asks before it throws away untitled work, and Cancel changes nothing', async () => {
    const user = userEvent.setup();
    await mount();
    seed('beach');

    await menu(user, 'New project');

    const dialog = await screen.findByRole('dialog', { name: 'Save this project first?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel — keep this project open' }));

    expect(screen.queryByRole('dialog', { name: 'Save this project first?' })).toBeNull();
    expect(clipIds()).toEqual(['clip_beach']);
  });

  it('Discard empties the timeline and the scratch it was autosaved into', async () => {
    const user = userEvent.setup();
    await mount();
    seed('beach');
    // Autosave has already put the untitled work on disk; clearing only the screen would
    // leave it there for the next New to destroy without ever asking.
    await waitFor(() => expect(savedClipIds(SCRATCH)).toEqual(['clip_beach']));

    await menu(user, 'New project');
    const dialog = await screen.findByRole('dialog', { name: 'Save this project first?' });
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(clipIds()).toEqual([]));
    await waitFor(() => expect(savedClipIds(SCRATCH)).toEqual([]));
  });

  it('Save as… inside the dialog names the work, then goes on with the switch', async () => {
    const user = userEvent.setup();
    await mount();
    seed('beach');

    vi.mocked(backend.pickProjectSavePath).mockResolvedValue(BEACH);
    await menu(user, 'New project');
    const dialog = await screen.findByRole('dialog', { name: 'Save this project first?' });
    await user.click(within(dialog).getByRole('button', { name: 'Save as…' }));

    await waitFor(() => expect(clipIds()).toEqual([]));
    expect(savedClipIds(BEACH)).toEqual(['clip_beach']);
    expect(useEditor.getState().projectPath).toBeNull();
  });

  it('leaves the dialog standing when the save panel is dismissed, so nothing is lost by a mis-click', async () => {
    const user = userEvent.setup();
    await mount();
    seed('beach');

    vi.mocked(backend.pickProjectSavePath).mockResolvedValue(null);
    await menu(user, 'New project');
    const dialog = await screen.findByRole('dialog', { name: 'Save this project first?' });
    await user.click(within(dialog).getByRole('button', { name: 'Save as…' }));

    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeEnabled(),
    );
    expect(screen.getByRole('dialog', { name: 'Save this project first?' })).toBeInTheDocument();
    expect(clipIds()).toEqual(['clip_beach']);
  });
});

// ----------------------------------------------------------------------------- the flush

describe('a switch the disk refuses', () => {
  it('keeps the project on screen when the write that would free it fails', async () => {
    const user = userEvent.setup();
    await mount();
    seed('beach');
    act(() => useEditor.setState({ projectPath: BEACH }));

    writeFails = 'no space left on device';
    await menu(user, 'New project');

    await screen.findByText('The project could not be saved');
    // Everything since the last autosave would have gone with it.
    expect(clipIds()).toEqual(['clip_beach']);
    expect(useEditor.getState().projectPath).toBe(BEACH);
  });
});

// ----------------------------------------------------------------------------- relaunch

describe('the project the app comes back to', () => {
  it('opens the one that was last written, not the untitled scratch', async () => {
    disk.set(SCRATCH, projectOf('scratch'));
    disk.set(BEACH, projectOf('beach'));
    pointer = BEACH;

    await mount();

    await waitFor(() => expect(clipIds()).toEqual(['clip_beach']));
    expect(useEditor.getState().projectPath).toBe(BEACH);
    expect(screen.getByRole('button', { name: 'beach' })).toBeInTheDocument();
  });

  it('still keeps pointing at a project it could not open, and writes nothing over it', async () => {
    // The project is on a drive that is not plugged in. Falling back to the scratch would
    // clear the only pointer to a file that is perfectly fine.
    pointer = BEACH;
    disk.set(SCRATCH, projectOf('scratch'));

    await mount();

    await screen.findByText('The last project could not be opened');
    expect(clipIds()).toEqual([]);
    expect(useEditor.getState().projectPath).toBe(BEACH);
    expect(screen.getByText('Not saved')).toBeInTheDocument();

    act(() => useEditor.setState({ clips: projectOf('beach').clips }));
    await new Promise((r) => setTimeout(r, 900));
    expect(disk.has(BEACH)).toBe(false);
    expect(savedClipIds(SCRATCH)).toEqual(['clip_scratch']);
  });

  it('a blocked session starts saving again the moment the project is given a file', async () => {
    const user = userEvent.setup();
    pointer = BEACH;
    await mount();
    await screen.findByText('The last project could not be opened');

    seed('beach');
    vi.mocked(backend.pickProjectSavePath).mockResolvedValue(REEL);
    await menu(user, 'Save as…');

    await waitFor(() => expect(savedClipIds(REEL)).toEqual(['clip_beach']));
    expect(useEditor.getState().saveBlocked).toBe(false);
    expect(screen.queryByText('Not saved')).toBeNull();
  });
});
