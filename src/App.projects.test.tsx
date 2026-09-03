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

import { StrictMode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { useEditor } from './state/store';
import { resetEditor } from './test/harness';
import * as backend from './lib/backend';
import { DEFAULT_ASPECT_RATIO } from './lib/aspect';
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
/** What `recents.json` holds, newest first. */
let recents: string[] = [];
/** Set to a message to make the next write fail. */
let writeFails: string | null = null;
/** Set to a message to make the next *creation* fail, without touching ordinary writes. */
let createFails: string | null = null;

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
  recentProjects: vi.fn(),
  newProjectPath: vi.fn(),
  createProject: vi.fn(),
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
    aspectRatio: DEFAULT_ASPECT_RATIO,
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
  recents = [];
  writeFails = null;
  createFails = null;
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
    remember(path);
  });
  // The Rust side prunes what is not there, so the fake disk does too — otherwise the menu
  // in a test would offer projects no test ever created.
  vi.mocked(backend.recentProjects).mockImplementation(async () =>
    recents.filter((path) => disk.has(path)),
  );
  vi.mocked(backend.newProjectPath).mockImplementation(async (name: string, near) => {
    const dir = near ? near.slice(0, near.lastIndexOf('/')) : '/docs';
    const path = `${dir}/${name}.solcut`;
    if (disk.has(path)) throw new Error(`“${name}” is already in that folder.`);
    return path;
  });
  vi.mocked(backend.createProject).mockImplementation(async (project: unknown, path: string) => {
    if (createFails) throw new Error(createFails);
    // `create_new` semantics: creating never replaces. The whole point of the command.
    if (disk.has(path)) throw new Error(`${path}: File exists`);
    disk.set(path, project);
    remember(path);
  });
  vi.mocked(backend.pickProjectSavePath).mockResolvedValue(null);
  vi.mocked(backend.pickProjectFile).mockResolvedValue(null);
});

/** What the Rust side does on a landed write: move the pointer, and the list with it. */
function remember(path: string | null) {
  if (pointer === path) return;
  for (const seen of [pointer, path]) {
    if (seen === null) continue;
    recents = [seen, ...recents.filter((p) => p !== seen)];
  }
  pointer = path;
}

// ----------------------------------------------------------------------------- helpers

/**
 * Mount the editor and wait for the restore to have answered.
 *
 * Under `<StrictMode>`, exactly as `main.tsx` does it — a suite that mounts differently from
 * the app cannot see a double-mount bug, which is how one shipped.
 */
async function mount() {
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
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
  await openMenu(user);
  await user.click(screen.getByRole('button', { name: item }));
}

/** Open the title bar's project menu and leave it open. */
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  const bar = document.querySelector('.titlebar') as HTMLElement;
  await user.click(within(bar).getByRole('button', { name: projectName() }));
}

/**
 * What the title bar is calling the open project.
 *
 * Queried by class rather than by "the button in the bar that is not expanded": the menu
 * this opens is *inside* the bar, so anything in it that discloses something of its own —
 * the name field does — would make that query ambiguous for every test at once.
 */
function projectName(): string {
  return (document.querySelector('.doc__name') as HTMLElement).textContent ?? '';
}

/** Start a new project and name it, the way a user does. */
async function newProject(user: ReturnType<typeof userEvent.setup>, name: string) {
  await menu(user, 'New project…');
  await user.type(await screen.findByLabelText('New project'), name);
  await user.click(screen.getByRole('button', { name: 'Create' }));
}

/** The projects the menu is offering, in order. */
function offered(): string[] {
  return within(screen.getByRole('group', { name: 'Project' }))
    .queryAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? '')
    .filter((name) => name.startsWith('Open '))
    .map((name) => name.replace(/^Open /, ''));
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
  it('names the file up front, creates it, and switches to it', async () => {
    const user = userEvent.setup();
    await mount();
    seed('beach');
    act(() => useEditor.setState({ projectPath: BEACH }));

    await newProject(user, 'reel');

    // A new project has a file from the moment it exists — which is the whole reason it can
    // ever appear in the menu that offers it back.
    await waitFor(() => expect(useEditor.getState().projectPath).toBe('/x/reel.solcut'));
    expect(disk.has('/x/reel.solcut')).toBe(true);
    expect(clipIds()).toEqual([]);
    expect(projectName()).toBe('reel');
    // Beside the project it was started from, not in some folder of the app's choosing.
    expect(vi.mocked(backend.newProjectPath).mock.calls.at(-1)).toEqual(['reel', BEACH]);
    expect(savedClipIds(BEACH)).toEqual(['clip_beach']);
  });

  /**
   * The name was free when it was typed. The confirm dialog that can follow opens a native
   * save panel, so the user has an unbounded window in which to give another project that
   * exact name — and a create that replaced it would be a silent deletion.
   */
  it('refuses a name that is already taken rather than writing over it', async () => {
    const user = userEvent.setup();
    disk.set('/x/reel.solcut', projectOf('reel'));
    await mount();
    seed('beach');
    act(() => useEditor.setState({ projectPath: BEACH }));

    await newProject(user, 'reel');

    await screen.findByText('That project could not be created');
    expect(useEditor.getState().projectPath).toBe(BEACH);
    expect(clipIds()).toEqual(['clip_beach']);
    expect(savedClipIds('/x/reel.solcut')).toEqual(['clip_reel']);
  });

  /**
   * The ordering the whole design rests on. `installDocument` stamps "what is on screen is
   * what is on disk" — so if the file were written *after* it, a failed write would leave
   * the user editing a project that does not exist, with nothing ever retrying it.
   */
  it('keeps the old project when the new file cannot be written, and leaves nothing behind', async () => {
    const user = userEvent.setup();
    await mount();
    seed('beach');
    act(() => useEditor.setState({ projectPath: BEACH }));

    createFails = 'read-only file system';
    await newProject(user, 'reel');

    await screen.findByText('The project could not be created');
    expect(useEditor.getState().projectPath).toBe(BEACH);
    expect(clipIds()).toEqual(['clip_beach']);
    expect(disk.has('/x/reel.solcut')).toBe(false);
  });

  /** A first project has no open one to sit beside, so it falls back to the documents folder. */
  it('puts the very first project in the documents folder', async () => {
    const user = userEvent.setup();
    await mount();

    await newProject(user, 'reel');

    await waitFor(() => expect(useEditor.getState().projectPath).toBe('/docs/reel.solcut'));
    expect(vi.mocked(backend.newProjectPath).mock.calls.at(-1)).toEqual(['reel', null]);
  });

  it('asks before it throws away untitled work, and Cancel changes nothing', async () => {
    const user = userEvent.setup();
    await mount();
    seed('beach');

    await newProject(user, 'reel');

    const dialog = await screen.findByRole('dialog', { name: 'Save this project first?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel — keep this project open' }));

    expect(screen.queryByRole('dialog', { name: 'Save this project first?' })).toBeNull();
    expect(clipIds()).toEqual(['clip_beach']);
    // Cancelled means nothing was created either.
    expect(disk.has('/docs/reel.solcut')).toBe(false);
  });

  it('Discard empties the timeline and the scratch it was autosaved into', async () => {
    const user = userEvent.setup();
    await mount();
    seed('beach');
    // Autosave has already put the untitled work on disk; clearing only the screen would
    // leave it there for the next New to destroy without ever asking.
    await waitFor(() => expect(savedClipIds(SCRATCH)).toEqual(['clip_beach']));

    await newProject(user, 'reel');
    const dialog = await screen.findByRole('dialog', { name: 'Save this project first?' });
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(clipIds()).toEqual([]));
    await waitFor(() => expect(savedClipIds(SCRATCH)).toEqual([]));
    expect(useEditor.getState().projectPath).toBe('/docs/reel.solcut');
  });

  it('Save as… inside the dialog names the work, then goes on with the switch', async () => {
    const user = userEvent.setup();
    await mount();
    seed('beach');

    vi.mocked(backend.pickProjectSavePath).mockResolvedValue(BEACH);
    await newProject(user, 'reel');
    const dialog = await screen.findByRole('dialog', { name: 'Save this project first?' });
    await user.click(within(dialog).getByRole('button', { name: 'Save as…' }));

    await waitFor(() => expect(clipIds()).toEqual([]));
    expect(savedClipIds(BEACH)).toEqual(['clip_beach']);
    expect(useEditor.getState().projectPath).toBe('/docs/reel.solcut');
  });

  it('leaves the dialog standing when the save panel is dismissed, so nothing is lost by a mis-click', async () => {
    const user = userEvent.setup();
    await mount();
    seed('beach');

    vi.mocked(backend.pickProjectSavePath).mockResolvedValue(null);
    await newProject(user, 'reel');
    const dialog = await screen.findByRole('dialog', { name: 'Save this project first?' });
    await user.click(within(dialog).getByRole('button', { name: 'Save as…' }));

    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeEnabled(),
    );
    expect(screen.getByRole('dialog', { name: 'Save this project first?' })).toBeInTheDocument();
    expect(clipIds()).toEqual(['clip_beach']);
  });

  it('an empty name creates nothing', async () => {
    const user = userEvent.setup();
    await mount();

    const asked = vi.mocked(backend.newProjectPath).mock.calls.length;
    await menu(user, 'New project…');
    await screen.findByLabelText('New project');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    expect(vi.mocked(backend.newProjectPath).mock.calls).toHaveLength(asked);
  });
});

// ----------------------------------------------------------------------------- the list

describe('the projects the menu offers', () => {
  it('lists the ones worked in, newest first, without the one already open', async () => {
    const user = userEvent.setup();
    disk.set(BEACH, projectOf('beach'));
    disk.set(REEL, projectOf('reel'));
    recents = [REEL, BEACH];
    pointer = REEL;
    await mount();
    await waitFor(() => expect(clipIds()).toEqual(['clip_reel']));

    await openMenu(user);

    // `reel` is the open project — its name is the control this menu hangs from, and
    // choosing it would do nothing.
    await waitFor(() => expect(offered()).toEqual(['beach']));
  });

  it('does not offer a project whose file has gone', async () => {
    const user = userEvent.setup();
    disk.set(BEACH, projectOf('beach'));
    recents = ['/x/gone.solcut', BEACH];
    await mount();

    await openMenu(user);

    await waitFor(() => expect(offered()).toEqual(['beach']));
  });

  it('switches to a project in one click, with no file picker anywhere near it', async () => {
    const user = userEvent.setup();
    disk.set(BEACH, projectOf('beach'));
    disk.set(REEL, projectOf('reel'));
    recents = [BEACH];
    pointer = REEL;
    await mount();
    await waitFor(() => expect(clipIds()).toEqual(['clip_reel']));

    const picked = vi.mocked(backend.pickProjectFile).mock.calls.length;
    await openMenu(user);
    await user.click(await screen.findByRole('button', { name: 'Open beach' }));

    await waitFor(() => expect(clipIds()).toEqual(['clip_beach']));
    expect(useEditor.getState().projectPath).toBe(BEACH);
    expect(projectName()).toBe('beach');
    // The outgoing project was written before it left the screen.
    expect(savedClipIds(REEL)).toEqual(['clip_reel']);
    // The whole point of a list: no picker was involved at any stage.
    expect(vi.mocked(backend.pickProjectFile).mock.calls).toHaveLength(picked);
  });

  /**
   * The project someone was in before this list existed lives in `current.txt` and nowhere
   * else. Seeding the list from the pointer is what keeps their first switch from being the
   * last time they saw it.
   */
  it('remembers the project it just left, so there is a way back', async () => {
    const user = userEvent.setup();
    disk.set(BEACH, projectOf('beach'));
    disk.set(REEL, projectOf('reel'));
    pointer = BEACH;
    await mount();
    await waitFor(() => expect(clipIds()).toEqual(['clip_beach']));

    vi.mocked(backend.pickProjectFile).mockResolvedValue(REEL);
    await menu(user, 'Open project…');
    await waitFor(() => expect(clipIds()).toEqual(['clip_reel']));

    await openMenu(user);
    await waitFor(() => expect(offered()).toEqual(['beach']));
  });

  /**
   * A double-click on a row is one gesture, not two switches. Both would pass their read,
   * both would flush, and both would install — the second over the first.
   */
  it('treats a double-click on a project as the one switch it is', async () => {
    const user = userEvent.setup();
    disk.set(BEACH, projectOf('beach'));
    disk.set(REEL, projectOf('reel'));
    recents = [BEACH];
    pointer = REEL;
    await mount();
    await waitFor(() => expect(clipIds()).toEqual(['clip_reel']));

    const reads = () =>
      vi.mocked(backend.readProject).mock.calls.filter(([path]) => path === BEACH).length;
    const before = reads();

    await openMenu(user);
    await act(async () => {
      useEditor.getState().openRecentProject(BEACH);
      useEditor.getState().openRecentProject(BEACH);
    });

    await waitFor(() => expect(clipIds()).toEqual(['clip_beach']));
    // The second call found a switch already running and stood down; two would each have
    // read, each flushed, and each installed — the second over the first.
    expect(reads() - before).toBe(1);
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
    await newProject(user, 'reel');

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

  /**
   * The one that quietly destroyed an afternoon.
   *
   * `refuseRemembered` leaves the path pointing at the project it would not touch *and* sets
   * `saveBlocked`, and `persistProject` answers "true" while blocked — nothing failed, there
   * was simply nothing it was allowed to write. So the question that guards a switch was
   * skipped (there *is* a path, so the work must have somewhere to go), the flush before the
   * switch reported success having written nothing, and then the empty document went out
   * over the untitled scratch on the way in. Two projects, no prompt, no toast.
   */
  it('asks before discarding work a blocked session was never able to write', async () => {
    pointer = BEACH;
    disk.set(SCRATCH, projectOf('scratch'));
    await mount();
    await screen.findByText('The last project could not be opened');

    const writes = vi.mocked(backend.saveProject).mock.calls.length;
    seed('beach');
    await new Promise((r) => setTimeout(r, 900));
    expect(vi.mocked(backend.saveProject).mock.calls).toHaveLength(writes);

    await act(async () => {
      useEditor.getState().startNewProject();
      useEditor.getState().setNewProjectName('reel');
      await useEditor.getState().createNewProject();
    });

    // The work is still on screen, behind the question — and so is the scratch on disk.
    expect(useEditor.getState().pendingSwitch).not.toBeNull();
    expect(clipIds()).toEqual(['clip_beach']);
    expect(savedClipIds(SCRATCH)).toEqual(['clip_scratch']);
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  });

  /**
   * A record belongs to the project it was started in. Carrying one across a switch would
   * put a card on screen naming clips the incoming project has never heard of, wearing a
   * Retry button that would pay to render against a cut that does not exist.
   */
  it('does not carry an interrupted render into the project it switches to', async () => {
    const user = userEvent.setup();
    // Opened on a project that already has a file, so the switch needs no question first.
    pointer = BEACH;
    disk.set(BEACH, projectOf('beach'));
    disk.set(REEL, projectOf('reel'));
    await mount();
    await waitFor(() => expect(clipIds()).toEqual(['clip_beach']));
    act(() =>
      useEditor.setState({
        generations: {
          gen_1: {
            id: 'gen_1',
            target: { kind: 'image', referenceAssetIds: [], aspect: '16:9' },
            prompt: 'a cliff at dusk',
            modelId: 'nano_banana_pro',
            status: 'failed',
            progress: 0,
            elapsedSecs: 0,
            slow: false,
            error: { title: 'Interrupted', message: 'x', retryable: true },
          },
        },
      }),
    );

    vi.mocked(backend.pickProjectFile).mockResolvedValue(REEL);
    await menu(user, 'Open project…');

    await waitFor(() => expect(clipIds()).toEqual(['clip_reel']));
    expect(useEditor.getState().generations).toEqual({});
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
