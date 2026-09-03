/**
 * Editor state.
 *
 * Deliberately one flat store: the timeline is a single track, and nearly every action
 * touches both the clip list and the selection, so splitting it up would mostly create
 * synchronisation work. Anything that is pure arithmetic lives in `lib/timeline`.
 */

import { create } from 'zustand';
import { DEFAULT_ASPECT_RATIO, frameSize, isAspectRatio, stillSize, type FrameSize } from '../lib/aspect';
import * as backend from '../lib/backend';
import { probeAudioDurationMs, probeVideoDurationMs, renderPhotoJpeg } from '../lib/frames';
import { resetPreviewSync } from '../lib/preview-sync';
import {
  AUDIO_EXTS,
  DEFAULT_AUDIO_DURATION_MS,
  DEFAULT_PHOTO_DURATION_MS,
  DEFAULT_PX_PER_SECOND,
  DEFAULT_TRANSITION_DURATION_MS,
  DEFAULT_TRANSITION_MODE,
  DEFAULT_TRANSITION_PROMPT,
  DEFAULT_VIDEO_DURATION_MS,
  type AudioTrack,
  type Clip,
  type ClipEdge,
  type Generation,
  type GenerationTarget,
  type MediaAsset,
  type MediaKind,
  type FilmGeneration,
  type GenerationError,
  type Selection,
  type TransitionMode,
  type TransitionSource,
} from '../types/project';
import {
  applyGenerationToFilm,
  assembleFilm,
  cancelFilmSegments,
  createFilm,
  defaultFilmPrompt,
  filmProgress,
  FILM_SEGMENT_DURATION_MS,
  inFlightFilmGenerationIds,
  isFilmAssembled,
  markFilmAssembled,
  markFilmSegmentFailed,
  markFilmSegmentQueued,
  patchFilmSegment,
  setFilmPrompt,
  type Film,
} from '../lib/film';
import {
  hydrate,
  markMissing,
  readProjectFile,
  toProjectFile,
  type ProjectDocument,
} from '../lib/project';
import {
  anchorMs,
  audioTrack,
  bridgeableCuts,
  canSplitAt,
  clipAt,
  consumedByReplace,
  cutOffersReplace,
  insertClips,
  insertIndexAtTime,
  insertTransitionClip,
  makeId,
  moveAudio,
  photoClip,
  placeClip,
  removeClipsClosingSpans,
  replacePairWithTransition,
  replaceTransitionClip,
  resizeAudio,
  resizeClipInList,
  retimeClip,
  setTransitionDuration,
  sortClips,
  timelineEndMs,
  trackEndMs,
  transitionSource,
  videoClip,
  type Cut,
  type GeneratedTransition,
} from '../lib/timeline';

export interface Toast {
  id: string;
  tone: 'ok' | 'error';
  title: string;
  detail?: string;
  action?: { label: string; path: string };
}

export interface ImportProblem {
  name: string;
  reason: string;
}

/**
 * The media bin's compose panel: what is being asked for, which bin photos it works on
 * top of, and what will render it.
 *
 * One object rather than five flat keys — like `film`, it is one thing to read and one
 * thing to put back. `open` lives inside it rather than beside it precisely so the draft
 * survives a close: Escape and Cancel are not reasonable ways to lose a typed prompt.
 */
export interface ImagePanel {
  open: boolean;
  /**
   * Which kind of media the sheet is currently making.
   *
   * The prompt is shared across a switch on purpose — describing a beach and then deciding
   * it should move is a change of mind about the medium, not about the shot, and retyping
   * it would be the panel punishing the user for switching.
   */
  mode: CreateMode;
  prompt: string;
  /** Bin asset ids attached as references, in the order they were clicked. Photo mode only. */
  referenceAssetIds: string[];
  /** An `IMAGE_MODELS` id. Photo mode only — see `videoModelId`. */
  modelId: string;
  /**
   * A `RENDER_MODELS` id (or `custom`), kept separate from `modelId` rather than sharing it.
   *
   * Sharing one field would be a quiet trap: `setImageModel` feeds its value to
   * `imageAspectFor` and `imageReferenceLimit`, both of which fall back to `IMAGE_MODELS[0]`
   * for an id they do not recognise — so a video model parked in `modelId` would silently
   * start behaving as Nano Banana Pro.
   */
  videoModelId: string;
  aspect: string;
}

/** Photo or video — what the create sheet is pointed at. */
export type CreateMode = 'photo' | 'video';

/** Everything one image generation needs — the panel's draft, or a failed one's record. */
export interface ImageRequestDraft {
  prompt: string;
  referenceAssetIds: string[];
  modelId: string;
  aspect: string;
}

/**
 * Everything one prompt-only video generation needs.
 *
 * Two fields, and there is nothing missing: a text-to-video request carries no references
 * and no aspect ratio, so a retry from a failed record is exact.
 */
export interface VideoRequestDraft {
  prompt: string;
  modelId: string;
}

export function emptyImagePanel(): ImagePanel {
  return {
    open: false,
    mode: 'photo',
    prompt: '',
    referenceAssetIds: [],
    modelId: backend.DEFAULT_IMAGE_MODEL_ID,
    videoModelId: backend.DEFAULT_MODEL_ID,
    aspect: backend.DEFAULT_IMAGE_ASPECT,
  };
}

/**
 * The panel as it stands after a send: clean, but still pointed at the same kind of media.
 *
 * The mode is deliberately the one thing that survives. It is not a per-request option
 * like the prompt or the model — it is which tool the user has in hand, and ejecting them
 * back to photos every time they generate a video would be the panel forgetting what they
 * are doing.
 */
function clearedPanel(mode: CreateMode): ImagePanel {
  return { ...emptyImagePanel(), mode };
}

/**
 * Whether a bin photo can be sent to Higgsfield as a reference.
 *
 * The path check is the load-bearing one: a photo dropped from a browser has no
 * filesystem path and is *not* flagged missing, so it looks perfectly usable in the bin
 * while being impossible to upload.
 */
export function referenceEligible(asset: MediaAsset | undefined): boolean {
  if (!asset || asset.kind !== 'photo' || asset.missing || !asset.path) return false;
  const ext = asset.path.split('.').pop()?.toLowerCase() ?? '';
  return REFERENCE_IMAGE_EXTS.includes(ext);
}

/**
 * What a reference photo may be. Narrower than the bin's own photo list, which also takes
 * `bmp`, `gif` and `avif` — kept in step with `REFERENCE_IMAGE_EXTS` in
 * `src-tauri/crates/higgsfield/src/lib.rs`, which refuses the rest before anything is sent.
 */
const REFERENCE_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp'];

export interface ExportState {
  stage: string;
  fraction: number;
  status: 'running' | 'failed';
  error?: string;
  /**
   * Whether running the same export again could plausibly do something different. A render
   * that died mid-encode is worth another go; a clip with no file on disk will fail the
   * same pre-check every time, so offering "Try again" there is a button that visibly does
   * nothing. Mirrors `GenerationError.retryable`.
   */
  retryable?: boolean;
}

/**
 * What restoring the stored project found — and therefore whether autosave may start.
 *
 * `blocked` is the one that matters: it means something is on disk that this session must
 * not overwrite. Arming autosave after a restore that *failed* would leave an empty editor
 * writing over the project it could not read, the moment the user touched anything.
 */
export type RestoreOutcome = 'restored' | 'nothing' | 'blocked';

/**
 * What a switch is switching *to*.
 *
 * `open` is the native picker and `openPath` is a row in the project menu — the same
 * operation with the file already chosen, which is the whole difference between hunting for
 * a project and clicking its name. `create` carries a path that does not exist yet.
 *
 * There is deliberately no `new`: every project the user makes is named when they make it,
 * so nothing produces an untitled one any more. The scratch survives only as the state a
 * first launch lands in, before anything has been named.
 */
export type SwitchAction =
  | { kind: 'open' }
  | { kind: 'openPath'; path: string }
  | { kind: 'create'; path: string };

/**
 * A switch the user has been asked about, because the project they are in is untitled and
 * has work in it — the one case with nowhere to flush to.
 *
 * `saving` is up while the save panel is open, so the dialog's own buttons cannot be used
 * to start a second one behind it.
 */
export interface PendingSwitch {
  action: SwitchAction;
  saving: boolean;
}

/**
 * One photo the film wizard is holding, before anything has been imported.
 *
 * Either half can be the real one: a desktop pick and an OS drop carry a `path` the Rust
 * side can read, a plain browser drop only ever has the `File`.
 */
export interface FilmPhotoSource {
  name: string;
  file?: File;
  path?: string;
}

/**
 * One launched cut of an "Animate all" run, tracked until the run's terminal collapse.
 * `landedClipId` is set once the leg's insert landing has placed a clip; a leg whose
 * landing no-oped (the photos moved) stays without one, so its photos are kept.
 */
export interface AnimateLeg {
  generationId: string;
  afterClipId: string;
  beforeClipId: string;
  landedClipId?: string;
}

export const PHOTO_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'avif'];
const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'm4v', 'mkv', 'avi'];

export function kindOf(name: string, mime = ''): MediaKind | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  // The extension wins for audio: browsers report `.ogg` as `video/ogg` often enough that
  // trusting the MIME type first would put sounds on the visual track.
  if (AUDIO_EXTS.includes(ext) || mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (PHOTO_EXTS.includes(ext)) return 'photo';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  return null;
}

export interface EditorState {
  assets: Record<string, MediaAsset>;
  clips: Clip[];
  audioTracks: AudioTrack[];
  selection: Selection;
  playheadMs: number;
  playing: boolean;
  pxPerSecond: number;
  /** The snapping aid on the track: drags still land anywhere, they just like edges. */
  snapping: boolean;
  /**
   * The shape of the project's frame — an `ASPECT_RATIOS` id. Part of the *document*, not
   * of the view: it decides what the export writes and what shape an AI transition is
   * generated in, so it travels with the project rather than with the window.
   */
  aspectRatio: string;

  generations: Record<string, Generation>;
  /**
   * The model the next render uses — a `RenderModel` id, or `custom` for the model id
   * Settings stores. Chosen at any render entry point and sent with every request; never
   * persisted, so a fresh session is back on the default (Seedance 2.5).
   */
  modelId: string;
  /** The three-photo film currently being made, if there is one. */
  film: Film | null;
  /** The wizard panel. It outlives the film it starts, and the film outlives it. */
  filmWizardOpen: boolean;
  /** The media bin's compose panel: what is being asked for, and what will render it. */
  imagePanel: ImagePanel;
  /** Prompts typed for cuts that have not generated yet, keyed `${afterClipId}:${beforeClipId}`. */
  cutPrompts: Record<string, string>;
  /** Insert/replace picked per cut, keyed like `cutPrompts`. A cut with no entry inserts. */
  cutModes: Record<string, TransitionMode>;
  /** Cuts still waiting their turn in an "Animate all" run. `null` when no run is active. */
  animateQueue: Cut[] | null;
  /** The queue's generation whose submission has not been accepted (no `jobId`) yet. */
  animateSubmittingId: string | null;
  /**
   * The whole "Animate all" run, one leg per launched cut. Landings stay between their
   * photos while it lives; once the queue has drained *and* every leg is terminal, the run
   * collapses — the photos its landings stand for leave the track and each landing is
   * stamped `replace`, so the chain ends as pure motion. `null` when no run is active.
   */
  animateRun: { legs: AnimateLeg[] } | null;
  importing: number;
  importProblems: ImportProblem[];
  /**
   * The bin tile a pointer is currently carrying, if any. Transient, but the drag starts in
   * one panel and lands in another, which is exactly what the one flat store is for — the
   * timeline is the only thing that knows where a drop would land, so it owns the geometry.
   */
  draggingAssetId: string | null;

  settings: backend.SettingsView | null;
  settingsOpen: boolean;
  /**
   * The last thing a connection or key check said. `title` overrides the box's heading —
   * the API key check reports its own, because "Could not connect" is the wrong words for
   * a key on a machine whose CLI is fine.
   */
  connectionMessage: { ok: boolean; text: string; title?: string } | null;

  /**
   * Why the last autosave failed, or `null` while it is working.
   *
   * One of the four fields the title bar's save state is read from. A *broken* autosave has
   * to say so, or the user loses everything without ever being told; this is the one that
   * carries the reason, and the tooltip repeats it verbatim.
   */
  saveError: string | null;

  /** A write is on the wire right now. `Saving…`, and nothing more. */
  saving: boolean;

  /**
   * When the last write landed, or `null` when none has this session.
   *
   * `null` is why the bar says *nothing* on a fresh launch rather than "Saved": claiming a
   * save that has not happened is exactly the lie this indicator exists to stop telling.
   */
  savedAt: number | null;

  /**
   * Where the open project lives, or `null` while it is untitled.
   *
   * The whole of a project's identity: its file *is* the project, and its name is that
   * file's name. Nothing is written inside the project about where it lives, so renaming
   * it on disk is not something the app has to be told about.
   */
  projectPath: string | null;

  /**
   * Saving is off for the open project, and only an explicit Save as… or a switch turns it
   * back on.
   *
   * A property of the document rather than the session: it is set when the thing on disk
   * must not be replaced — a project from a newer build, one that could not be read at all
   * — and cleared by installing a document that *was* read, so opening something else is a
   * way out rather than a trap.
   */
  saveBlocked: boolean;

  /** The switch waiting on an answer, or `null` when nothing was asked. */
  pendingSwitch: PendingSwitch | null;

  /** Whether the title bar's project menu is showing. */
  projectMenuOpen: boolean;

  /**
   * The projects the menu offers, newest first — read fresh each time it opens.
   *
   * Read rather than kept in step: the alternative is a second copy of a list the Rust side
   * already owns, updated from every path that changes which project is open. One read on a
   * menu that opens a few times a day is cheaper than that, and cannot go stale.
   */
  recentProjects: string[];

  /**
   * What is typed in the inline "New project" field, or `null` while it is not showing.
   *
   * The empty string is a real state — the field is open and nothing has been typed — which
   * is why this is not just a string.
   */
  newProjectName: string | null;

  exportState: ExportState | null;
  /**
   * A render is in flight. Distinct from `exportState`, which is only what the dialog is
   * showing: closing the dialog nulls that while ffmpeg keeps going, so the re-entrancy
   * guard and the Export button both have to read this instead.
   */
  exporting: boolean;
  ffmpegAvailable: boolean | null;
  toasts: Toast[];

  // ---- media
  addFiles: (files: File[], index?: number, audioStartMs?: number) => Promise<void>;
  addPaths: (paths: string[], index?: number, audioStartMs?: number) => Promise<void>;
  importViaDialog: () => Promise<void>;
  addAudioViaDialog: () => Promise<void>;
  removeAsset: (assetId: string) => void;
  dismissImportProblems: () => void;
  beginAssetDrag: (assetId: string) => void;
  endAssetDrag: () => void;
  placeAssetOnTimeline: (assetId: string, index?: number, audioStartMs?: number) => void;

  // ---- audio tracks
  moveAudioTrack: (trackId: string, startMs: number) => void;
  resizeAudioTrack: (trackId: string, edge: ClipEdge, deltaMs: number) => void;
  setAudioDuration: (trackId: string, durationMs: number) => number | null;
  setAudioVolume: (trackId: string, volume: number) => void;
  toggleAudioMute: (trackId: string) => void;

  // ---- selection & editing
  select: (selection: Selection) => void;
  deleteSelection: () => void;
  splitAtPlayhead: () => void;
  moveClipTo: (clipId: string, startMs: number) => void;
  resizeClip: (clipId: string, edge: ClipEdge, deltaMs: number) => void;
  setClipDuration: (clipId: string, durationMs: number) => number | null;
  toggleSnapping: () => void;
  /** Reshape the project's frame. An id this build does not offer is ignored. */
  setAspectRatio: (id: string) => void;

  // ---- playback
  setPlayhead: (ms: number) => void;
  togglePlay: () => void;
  advance: (deltaMs: number) => void;

  // ---- generation
  setModel: (modelId: string) => void;
  setCutPrompt: (prompt: string) => void;
  setCutMode: (mode: TransitionMode) => void;
  setTransitionPrompt: (clipId: string, prompt: string) => void;
  startCutGeneration: (
    afterClipId: string,
    beforeClipId: string,
    mode?: TransitionMode,
  ) => string | null;
  regenerateTransition: (clipId: string) => void;
  retryGeneration: (generationId: string) => void;
  animateAll: () => void;
  advanceAnimateQueue: () => void;
  applyGenerationUpdate: (update: backend.GenerationUpdate) => void;
  cancelGeneration: (id: string) => Promise<void>;
  dismissGeneration: (id: string) => void;

  // ---- film (three photos, two AI transitions)
  openFilmWizard: () => void;
  closeFilmWizard: () => void;

  addFilmPhotos: (sources: FilmPhotoSource[]) => Promise<string[]>;
  startFilm: (assetIds: string[], prompts?: string[]) => Promise<void>;
  setFilmSegmentPrompt: (index: number, prompt: string) => void;
  retryFilmSegment: (index: number) => Promise<void>;
  cancelFilm: () => Promise<void>;
  placeFilmOnTimeline: () => void;
  dismissFilm: () => void;

  // ---- generating a photo or a video (the media bin's create sheet)
  openImagePanel: () => void;
  /** Point the sheet at photos or at video. The typed prompt survives the switch. */
  setCreateMode: (mode: CreateMode) => void;
  /** Put the panel away, keeping the draft — only a generation that went clears it. */
  closeImagePanel: () => void;
  setImagePrompt: (prompt: string) => void;
  /** Attach or detach one bin photo as a reference. Ineligible photos are ignored. */
  toggleImageReference: (assetId: string) => void;
  setImageModel: (modelId: string) => void;
  setImageAspect: (aspect: string) => void;
  /**
   * Send one image generation and return its id, or `null` when nothing was sent.
   *
   * Called with nothing it takes the compose panel's draft and, on a successful send,
   * clears and closes it. Called with a request — a retry — it sends exactly that and
   * leaves the panel alone.
   */
  startImageGeneration: (request?: ImageRequestDraft) => string | null;
  setVideoModel: (modelId: string) => void;
  /**
   * Send one prompt-only video generation and return its id, or `null` when nothing was
   * sent. Called with nothing it takes the sheet's draft and, on a successful send, clears
   * and closes it; called with a request — a retry — it sends exactly that.
   */
  startVideoGeneration: (request?: VideoRequestDraft) => string | null;

  // ---- the saved project
  restoreProject: () => Promise<RestoreOutcome>;
  /** Write the project where it lives. `false` means a write was attempted and failed. */
  persistProject: () => Promise<boolean>;
  openProjectMenu: () => Promise<void>;
  closeProjectMenu: () => void;
  /** Open a project the menu offered, without going near a file picker. */
  openRecentProject: (path: string) => void;
  /** Show the inline name field, or put it away. */
  startNewProject: () => void;
  setNewProjectName: (name: string) => void;
  cancelNewProject: () => void;
  /** Name the file and switch to it. Refuses rather than replacing an existing project. */
  createNewProject: () => Promise<void>;
  requestOpenProject: () => void;
  /** Give the project a file. `false` means it still has none. */
  saveProjectAs: () => Promise<boolean>;
  resolveSwitch: (choice: 'save' | 'discard' | 'cancel') => Promise<void>;

  // ---- settings, export, chrome
  loadSettings: () => Promise<void>;
  openSettings: () => void;
  closeSettings: () => void;
  saveSettings: (input: backend.SettingsInput) => Promise<void>;
  testConnection: () => Promise<void>;
  testApiKey: (input: backend.SettingsInput) => Promise<void>;
  runExport: () => Promise<void>;
  setExportProgress: (stage: string, fraction: number) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
}

export const useEditor = create<EditorState>((set, get) => ({
  assets: {},
  clips: [],
  audioTracks: [],
  selection: { kind: 'none' },
  playheadMs: 0,
  playing: false,
  pxPerSecond: DEFAULT_PX_PER_SECOND,
  snapping: true,
  aspectRatio: DEFAULT_ASPECT_RATIO,

  generations: {},
  modelId: backend.DEFAULT_MODEL_ID,
  film: null,
  filmWizardOpen: false,
  imagePanel: emptyImagePanel(),
  cutPrompts: {},
  cutModes: {},
  animateQueue: null,
  animateSubmittingId: null,
  animateRun: null,
  importing: 0,
  importProblems: [],
  draggingAssetId: null,

  settings: null,
  settingsOpen: false,
  connectionMessage: null,

  saveError: null,
  saving: false,
  savedAt: null,
  projectPath: null,
  saveBlocked: false,
  pendingSwitch: null,
  projectMenuOpen: false,
  recentProjects: [],
  newProjectName: null,

  exportState: null,
  exporting: false,
  ffmpegAvailable: null,
  toasts: [],

  // ------------------------------------------------------------------ media

  async addFiles(files, index, audioStartMs) {
    const accepted: Imported[] = [];
    const problems: ImportProblem[] = [];

    for (const file of files) {
      const kind = kindOf(file.name, file.type);
      if (!kind) {
        problems.push({
          name: file.name,
          reason: `unsupported format. Supported: ${[...PHOTO_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS].join(', ')}`,
        });
        continue;
      }
      const asset: MediaAsset = {
        id: makeId('asset'),
        name: file.name,
        kind,
        // A browser drop has no filesystem path; export needs one, and says so.
        path: (file as File & { path?: string }).path ?? '',
        src: safeObjectUrl(file),
        sizeBytes: file.size,
      };
      accepted.push(placed(asset, audioStartMs ?? get().playheadMs));
    }

    commitImport(set, documentEpoch, accepted, problems, index);
    await probeDurations(set, documentEpoch, accepted);
  },

  async addPaths(paths, index, audioStartMs) {
    if (paths.length === 0) return;
    // Captured before the stat, not after: which project this import belongs to is decided
    // when it starts, not when it comes back.
    const epoch = documentEpoch;
    set((s) => ({ importing: s.importing + paths.length }));
    try {
      const result = await backend.importPaths(paths);
      const accepted = result.imported.map((item) => {
        const asset: MediaAsset = {
          id: makeId('asset'),
          name: item.name,
          kind: item.kind,
          path: item.path,
          src: backend.assetSrc(item.path),
          sizeBytes: item.sizeBytes,
        };
        return placed(asset, audioStartMs ?? get().playheadMs);
      });
      commitImport(set, epoch, accepted, result.rejected, index);
      await probeDurations(set, epoch, accepted);
    } catch (error) {
      get().pushToast({ tone: 'error', title: 'Import failed', detail: message(error) });
    } finally {
      set((s) => ({ importing: Math.max(0, s.importing - paths.length) }));
    }
  },

  async importViaDialog() {
    try {
      await get().addPaths(await backend.pickMediaFiles());
    } catch (error) {
      get().pushToast({ tone: 'error', title: 'Could not open the file picker', detail: message(error) });
    }
  },

  /** The timeline's "add audio" action: a picker narrowed to sound files, dropped at the playhead. */
  async addAudioViaDialog() {
    try {
      await get().addPaths(await backend.pickAudioFiles());
    } catch (error) {
      get().pushToast({ tone: 'error', title: 'Could not open the file picker', detail: message(error) });
    }
  },

  /**
   * Take an imported asset back out of the bin. Its clips go with it — a clip whose media
   * is gone would only render as "media offline" and block export.
   */
  removeAsset(assetId) {
    const { assets, clips, audioTracks, selection, generations, cutPrompts, cutModes, playheadMs, playing, animateSubmittingId } =
      get();
    const asset = assets[assetId];
    if (!asset) return;

    const doomed = new Set(clips.filter((c) => c.assetId === assetId).map((c) => c.id));
    const doomedAudio = new Set(audioTracks.filter((t) => t.assetId === assetId).map((t) => t.id));
    const nextAssets = { ...assets };
    delete nextAssets[assetId];
    const nextClips = clips.filter((c) => !doomed.has(c.id));
    const nextAudio = audioTracks.filter((t) => !doomedAudio.has(t.id));
    const total = timelineEndMs(nextClips, nextAudio);

    const selectionDoomed =
      selection.kind === 'audio'
        ? doomedAudio.has(selection.trackId)
        : selection.kind === 'cut'
          ? doomed.has(selection.afterClipId) || doomed.has(selection.beforeClipId)
          : selection.kind !== 'none' && doomed.has(selection.clipId);

    // A generation is doomed when any clip it works for is: either side of the cut, or the
    // transition clip it would replace.
    // Film legs animate between photos, not clips, and a generated photo or video is media
    // the bin asked for — none of the three has a clip on the track that speaks for it, so
    // none of them is doomed by an edit to the track. Getting this wrong in the other
    // direction is expensive rather than merely wrong: it would cancel a paid render
    // because the user deleted some unrelated tile.
    const generationDoomed = (g: Generation) =>
      g.target.kind === 'film' || g.target.kind === 'image' || g.target.kind === 'video'
        ? false
        : doomed.has(g.target.afterClipId) ||
          doomed.has(g.target.beforeClipId) ||
          (g.target.replacesClipId !== undefined && doomed.has(g.target.replacesClipId));

    const kept = Object.fromEntries(
      Object.entries(generations).filter(([, g]) => !generationDoomed(g)),
    );
    const pruned = prunedAfterEdit(nextClips, kept, cutPrompts, cutModes);
    set({
      assets: nextAssets,
      clips: nextClips,
      audioTracks: nextAudio,
      ...pruned,
      selection: selectionDoomed ? { kind: 'none' } : selection,
      playheadMs: Math.min(playheadMs, total),
      playing: total === 0 ? false : playing,
    });

    // Nothing is left to put the result on, so stop paying for the render.
    for (const generation of Object.values(generations)) {
      if (!generationDoomed(generation)) continue;
      if (generation.status !== 'queued' && generation.status !== 'running') continue;
      void backend.cancelGeneration(generation.id).catch(() => {});
    }

    // The queue's in-flight submit may just have been swept; its terminal event will never
    // reach a record that no longer exists, so nudge the queue from here.
    if (animateSubmittingId && !pruned.generations[animateSubmittingId]) {
      set({ animateSubmittingId: null });
      get().advanceAnimateQueue();
    }
    // Same silence for the animate run: a swept record leaves its leg terminal-by-missing,
    // and this may have been the run's last live one.
    maybeCollapseAnimateRun(set, get);

    // A browser drop owns an object URL, and this was the last reference to it.
    if (asset.src.startsWith('blob:')) URL.revokeObjectURL(asset.src);
  },

  dismissImportProblems: () => set({ importProblems: [] }),

  beginAssetDrag: (assetId) => set({ draggingAssetId: assetId }),
  endAssetDrag: () => set({ draggingAssetId: null }),

  /**
   * Put an asset that is already in the bin onto the timeline — the drag out of the bin, and
   * the keyboard path beside it. Where it lands is the import's rule, not a second one:
   * `index` is a boundary on the visual track and `audioStartMs` an exact time on a new lane.
   * Both default to the playhead, which is what a caller with no pointer to speak of wants.
   *
   * The asset's own length is passed through, so a video whose file has been probed lands at
   * its real length: nothing would ever correct it later, since `probeDurations` only patches
   * the clip its own import created.
   */
  placeAssetOnTimeline(assetId, index, audioStartMs) {
    const { assets, clips, playheadMs } = get();
    const asset = assets[assetId];
    // An asset whose file has gone is refused here, the way a generation refuses one: a clip
    // on it could only render as "media offline" and would block the export.
    if (!asset || asset.missing) return;
    commitImport(
      set,
      documentEpoch,
      [placed(asset, audioStartMs ?? playheadMs, asset.durationMs)],
      [],
      index ?? insertIndexAtTime(clips, playheadMs),
    );
  },

  // ------------------------------------------------------------------ audio tracks

  /** Drag a sound along its lane: `startMs` is where it should begin. */
  moveAudioTrack(trackId, startMs) {
    const { audioTracks } = get();
    const track = audioTracks.find((t) => t.id === trackId);
    if (!track) return;
    const moved = moveAudio(track, startMs);
    if (moved === track) return;
    set({
      audioTracks: audioTracks.map((t) => (t.id === trackId ? moved : t)),
      selection: { kind: 'audio', trackId },
    });
  },

  /** Drag an edge of a sound: `deltaMs` is how far it moved to the right. */
  resizeAudioTrack(trackId, edge, deltaMs) {
    const { audioTracks, assets, clips, playheadMs } = get();
    const track = audioTracks.find((t) => t.id === trackId);
    if (!track) return;
    const resized = resizeAudio(track, edge, deltaMs, assets[track.assetId]?.durationMs);
    if (resized === track) return;
    const next = audioTracks.map((t) => (t.id === trackId ? resized : t));
    set({
      audioTracks: next,
      playheadMs: Math.min(playheadMs, timelineEndMs(clips, next)),
    });
  },

  /** The same as `setClipDuration`, for a sound on its lane. */
  setAudioDuration(trackId, durationMs) {
    const track = get().audioTracks.find((t) => t.id === trackId);
    if (!track) return null;
    get().resizeAudioTrack(trackId, 'end', Math.round(durationMs) - track.durationMs);
    return get().audioTracks.find((t) => t.id === trackId)?.durationMs ?? null;
  },

  setAudioVolume(trackId, volume) {
    const clamped = Math.min(1, Math.max(0, volume));
    set((s) => ({
      audioTracks: s.audioTracks.map((t) => (t.id === trackId ? { ...t, volume: clamped } : t)),
    }));
  },

  toggleAudioMute(trackId) {
    set((s) => ({
      audioTracks: s.audioTracks.map((t) => (t.id === trackId ? { ...t, muted: !t.muted } : t)),
    }));
  },

  // ------------------------------------------------------------------ editing

  select: (selection) => set({ selection }),

  deleteSelection() {
    const { selection, clips, audioTracks, generations, cutPrompts, cutModes } = get();
    if (selection.kind === 'clip') {
      const nextClips = clips.filter((c) => c.id !== selection.clipId);
      set({
        clips: nextClips,
        selection: { kind: 'none' },
        ...prunedAfterEdit(nextClips, generations, cutPrompts, cutModes),
      });
      return;
    }
    if (selection.kind === 'audio') {
      set({
        audioTracks: audioTracks.filter((t) => t.id !== selection.trackId),
        selection: { kind: 'none' },
      });
    }
    // A cut is a place, not a thing: there is nothing to delete.
  },

  splitAtPlayhead() {
    const { clips, playheadMs } = get();
    if (!canSplitAt(clips, playheadMs)) return;
    const hit = clipAt(clips, playheadMs)!;

    // Half a transition no longer runs first frame to last, so neither half can honestly
    // claim its sources; both keep `ai` (still generated footage) but drop `transition`.
    const clip = hit.placed.clip;
    const head: Clip = {
      ...clip,
      id: makeId('clip'),
      transition: undefined,
      durationMs: hit.localMs,
    };
    const tail: Clip = {
      ...clip,
      id: makeId('clip'),
      transition: undefined,
      // The two halves fill exactly the span the clip held, so nothing else moves.
      startMs: clip.startMs + hit.localMs,
      durationMs: clip.durationMs - hit.localMs,
      trimStartMs: clip.trimStartMs + (clip.kind === 'video' ? hit.localMs : 0),
    };
    const index = clips.findIndex((c) => c.id === clip.id);
    const nextClips = [...clips.slice(0, index), head, tail, ...clips.slice(index + 1)];
    const { generations, cutPrompts, cutModes } = get();
    set({
      clips: nextClips,
      selection: { kind: 'clip', clipId: tail.id },
      ...prunedAfterEdit(nextClips, generations, cutPrompts, cutModes),
    });
  },

  /** Drag along the track: `startMs` is where the clip should begin, gaps and all. */
  moveClipTo(clipId, startMs) {
    const { clips, generations, cutPrompts, cutModes } = get();
    const next = placeClip(clips, clipId, startMs);
    if (next === clips) return;
    set({
      clips: next,
      selection: { kind: 'clip', clipId },
      ...prunedAfterEdit(next, generations, cutPrompts, cutModes),
    });
  },

  /** Drag an edge: `deltaMs` is how far it moved to the right, whichever edge it is. */
  resizeClip(clipId, edge, deltaMs) {
    const { clips, audioTracks, assets, playheadMs } = get();
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;

    const next = resizeClipInList(clips, clipId, edge, deltaMs, assets[clip.assetId]?.durationMs);
    if (next === clips) return;

    const { generations, cutPrompts, cutModes } = get();
    set({
      clips: next,
      // The track just got shorter under the playhead, or it did not — either way it stays on it.
      playheadMs: Math.min(playheadMs, timelineEndMs(next, audioTracks)),
      ...prunedAfterEdit(next, generations, cutPrompts, cutModes),
    });
  },

  /**
   * Set a clip's length outright — what the inspector's Duration box commits.
   *
   * Expressed as a tail-edge delta rather than written straight onto the clip, so the box
   * and the drag handle are one behaviour: the floors, the ceilings, the push on the clips
   * behind it and the pruning all come from `resizeClip` and cannot drift from it. The
   * delta is taken from the live clip, so the number the user typed is what lands even if
   * the timeline moved under them while they were typing.
   *
   * Answers with the length the clip ended up at — the one that was asked for, or the wall
   * it was clamped to. The box that asked is the only thing that can tell those apart, and
   * it cannot read the clamp off the clip afterwards: a later drag would look identical.
   * `null` when there is no such clip to set.
   */
  setClipDuration(clipId, durationMs) {
    const clip = get().clips.find((c) => c.id === clipId);
    if (!clip) return null;
    get().resizeClip(clipId, 'end', Math.round(durationMs) - clip.durationMs);
    return get().clips.find((c) => c.id === clipId)?.durationMs ?? null;
  },

  toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),

  // Refused rather than stored when this build does not know the id: the frame is what
  // every other size is derived from, and one nothing can resolve would export nothing.
  setAspectRatio: (id) => set(isAspectRatio(id) ? { aspectRatio: id } : {}),

  // ------------------------------------------------------------------ playback

  setPlayhead(ms) {
    const total = timelineEndMs(get().clips, get().audioTracks);
    set({ playheadMs: Math.min(Math.max(0, Math.round(ms)), total) });
  },

  togglePlay() {
    const { playing, playheadMs, clips, audioTracks } = get();
    const total = timelineEndMs(clips, audioTracks);
    if (total === 0) return;
    // Pressing play at the very end restarts rather than doing nothing.
    set({ playing: !playing, playheadMs: !playing && playheadMs >= total ? 0 : playheadMs });
  },

  advance(deltaMs) {
    const { playheadMs, clips, audioTracks, playing } = get();
    if (!playing) return;
    const total = timelineEndMs(clips, audioTracks);
    const next = playheadMs + deltaMs;
    if (next >= total) {
      set({ playheadMs: total, playing: false });
    } else {
      set({ playheadMs: next });
    }
  },

  // ------------------------------------------------------------------ generation

  setModel: (modelId) => set({ modelId }),

  setCutPrompt(prompt) {
    const { selection } = get();
    if (selection.kind !== 'cut') return;
    const key = cutKey(selection.afterClipId, selection.beforeClipId);
    set((s) => ({ cutPrompts: { ...s.cutPrompts, [key]: prompt } }));
  },

  setCutMode(mode) {
    const s0 = get();
    const { selection } = s0;
    if (selection.kind !== 'cut') return;
    const a = s0.clips.find((c) => c.id === selection.afterClipId);
    const b = s0.clips.find((c) => c.id === selection.beforeClipId);
    if (!a || !b) return;
    // The card removes the toggle where the pair has no still to give up; the action
    // refuses it there too, so a stored pick can never outlive the reason it was possible.
    if (mode === 'replace' && !cutOffersReplace(a, b)) return;
    const key = cutKey(selection.afterClipId, selection.beforeClipId);
    set((s) => ({ cutModes: { ...s.cutModes, [key]: mode } }));
  },

  setTransitionPrompt(clipId, prompt) {
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId && c.transition ? { ...c, transition: { ...c.transition, prompt } } : c,
      ),
    }));
  },

  /**
   * `mode` overrides the cut's own pick — the animate-all queue passes `insert`, because a
   * replace landing consumes clips and would invalidate the cuts still waiting behind it.
   */
  startCutGeneration(afterClipId, beforeClipId, mode) {
    const s = get();
    // Asked of the *chosen* backend, not of Higgsfield: `configured` means a `higgsfield`
    // binary is on disk, and gating on it refused a machine that has a coding-agent CLI and
    // could composite the cut perfectly well.
    if (!backend.renderReady(s.modelId, s.settings, s.ffmpegAvailable)) return null;
    if (!cutEligible(s, afterClipId, beforeClipId)) return null;

    const clipA = s.clips.find((c) => c.id === afterClipId);
    const clipB = s.clips.find((c) => c.id === beforeClipId);
    if (!clipA || !clipB) return null;
    const prompt =
      (s.cutPrompts[cutKey(afterClipId, beforeClipId)] ?? '').trim() || DEFAULT_TRANSITION_PROMPT;
    // The motion runs out of the left clip and into the right one, so each side gives up the
    // frame at the cut: a photo is that frame already, a video's is taken at its edge.
    const from: TransitionSource = transitionSource(clipA, 'out');
    const to: TransitionSource = transitionSource(clipB, 'in');
    const target: GenerationTarget = {
      kind: 'cut',
      afterClipId,
      beforeClipId,
      from,
      to,
      mode: resolveCutMode(s, clipA, clipB, mode),
    };
    return launchGeneration(set, get, target, prompt, get().modelId, {
      kind: 'frames',
      from: frameOfClip(s.assets[clipA.assetId], clipA, 'out'),
      to: frameOfClip(s.assets[clipB.assetId], clipB, 'in'),
      spanMs: spanOf(clipA, clipB),
    });
  },

  /**
   * Re-render an existing transition. An insert-mode clip renders from whatever stands
   * around it NOW — that is what makes stale → Regenerate correct after a reorder or a
   * replacement — and has nothing to do when orphaned: there is no longer a clip on each
   * side to span. A replace-mode clip consumed the pair's stills, so those are re-rendered
   * from their assets in the media bin; only a missing asset stops it.
   */
  regenerateTransition(clipId) {
    const s = get();
    if (!backend.renderReady(s.modelId, s.settings, s.ffmpegAvailable)) return;
    const placedClips = sortClips(s.clips);
    const at = placedClips.findIndex((c) => c.id === clipId);
    const clip = at === -1 ? undefined : placedClips[at];
    if (!clip?.transition) return;
    const alreadyLive = Object.values(s.generations).some(
      (g) => liveGeneration(g) && g.target.kind === 'cut' && g.target.replacesClipId === clipId,
    );
    if (alreadyLive) return;

    if (clip.transition.mode === 'replace') {
      const { from, to } = clip.transition;
      // A consumed still is re-rendered from its asset in the bin. A side the landing did
      // *not* consume — a video keeps its footage — is still on the track and may have been
      // trimmed since, so it is re-read from the clip as it stands rather than from the
      // frame that was recorded — its asset included, because a transition on that side
      // that was regenerated since kept its clip id and took a new file. That is exactly
      // what makes its Regenerate worth pressing.
      const liveA = s.clips.find((c) => c.id === from.clipId);
      const liveB = s.clips.find((c) => c.id === to.clipId);
      const assetA = s.assets[liveA?.assetId ?? from.assetId];
      const assetB = s.assets[liveB?.assetId ?? to.assetId];
      if (!assetA || !assetB || assetA.missing || assetB.missing) return;
      const prompt = clip.transition.prompt.trim() || DEFAULT_TRANSITION_PROMPT;
      const target: GenerationTarget = {
        kind: 'cut',
        afterClipId: from.clipId,
        beforeClipId: to.clipId,
        from: liveA ? transitionSource(liveA, 'out') : from,
        to: liveB ? transitionSource(liveB, 'in') : to,
        replacesClipId: clipId,
        mode: 'replace',
      };
      launchGeneration(set, get, target, prompt, get().modelId, {
        kind: 'frames',
        from: liveA ? frameOfClip(assetA, liveA, 'out') : frameOfSource(assetA, from),
        to: liveB ? frameOfClip(assetB, liveB, 'in') : frameOfSource(assetB, to),
        // What it is replacing is the clip standing there now, not the pair it came from.
        spanMs: clip.durationMs,
      });
      return;
    }

    const left = placedClips[at - 1];
    const right = placedClips[at + 1];
    // Whatever stands on each side will do — a photo, footage, or another transition, which
    // is footage like any other: the chip offers the cut beside one, and Regenerate reads it.
    if (!left || !right) return;
    const assetA = s.assets[left.assetId];
    const assetB = s.assets[right.assetId];
    if (!assetA || !assetB || assetA.missing || assetB.missing) return;

    const prompt = clip.transition.prompt.trim() || DEFAULT_TRANSITION_PROMPT;
    const from: TransitionSource = transitionSource(left, 'out');
    const to: TransitionSource = transitionSource(right, 'in');
    const target: GenerationTarget = {
      kind: 'cut',
      afterClipId: left.id,
      beforeClipId: right.id,
      from,
      to,
      replacesClipId: clipId,
    };
    launchGeneration(set, get, target, prompt, get().modelId, {
      kind: 'frames',
      from: frameOfClip(assetA, left, 'out'),
      to: frameOfClip(assetB, right, 'in'),
      spanMs: clip.durationMs,
    });
  },

  /** Resubmit a failed generation from its own target — never from whatever is selected. */
  retryGeneration(generationId) {
    const generation = get().generations[generationId];
    if (!generation || generation.status !== 'failed') return;
    get().dismissGeneration(generationId);

    const target = generation.target;
    const leg = get().animateRun?.legs.find((l) => l.generationId === generationId);
    if (target.kind === 'film') {
      // A film leg is retried from the film panel, which is where its state is shown.
      void get().retryFilmSegment(target.filmSegmentIndex);
    } else if (target.kind === 'image') {
      // Everything the first attempt sent is on the record, so a retry is exact — and a
      // reference the user has since removed from the bin is simply dropped rather than
      // resurrected.
      void get().startImageGeneration({
        prompt: generation.prompt,
        referenceAssetIds: target.referenceAssetIds,
        modelId: generation.modelId,
        aspect: target.aspect,
      });
    } else if (target.kind === 'video') {
      // The whole of a prompt-only request is the words and the model, and both are on the
      // record — so unlike an image retry there is nothing that could have gone stale.
      void get().startVideoGeneration({
        prompt: generation.prompt,
        modelId: generation.modelId,
      });
    } else if (target.replacesClipId !== undefined) {
      get().regenerateTransition(target.replacesClipId);
    } else if (leg) {
      // A run leg retries as insert — mid-run a replace landing would still consume clips
      // out from under the others — and re-registers itself so the collapse waits for the
      // retry's landing. When the cut no longer stands nothing launches: the record just
      // dismissed then leaves the leg terminal-by-missing, and the check below lets the
      // run resolve without it rather than stall.
      const id = get().startCutGeneration(target.afterClipId, target.beforeClipId, 'insert');
      if (id) {
        set((s) => ({
          animateRun: s.animateRun
            ? {
                legs: s.animateRun.legs.map((l) =>
                  l.generationId === generationId
                    ? { generationId: id, afterClipId: l.afterClipId, beforeClipId: l.beforeClipId }
                    : l,
                ),
              }
            : s.animateRun,
        }));
      }
      maybeCollapseAnimateRun(set, get);
    } else {
      get().startCutGeneration(target.afterClipId, target.beforeClipId);
    }
  },

  animateAll() {
    const s = get();
    if (!backend.renderReady(s.modelId, s.settings, s.ffmpegAvailable)) return;
    // One run at a time — the action guards itself, not just the button that offers it.
    if (s.animateQueue !== null || s.animateRun !== null) return;
    const eligible = animatableCuts(s);
    if (eligible.length === 0) return;
    set({ animateQueue: eligible, animateRun: { legs: [] } });
    get().advanceAnimateQueue();
  },

  /**
   * The one and only place the animate-all queue moves. Submissions are serialized because
   * a 429 during *submission* is terminal for that job: the next cut starts only once the
   * previous one has been accepted (gained a `jobId`) or died. A dequeued cut that went
   * ineligible while waiting is skipped, never stalled on.
   */
  advanceAnimateQueue() {
    const s = get();
    if (!s.animateQueue) return;
    if (s.animateSubmittingId) {
      const submitting = s.generations[s.animateSubmittingId];
      if (submitting && !submitting.jobId && liveGeneration(submitting)) return;
    }

    let queue = s.animateQueue;
    while (queue.length > 0) {
      const [head, ...rest] = queue;
      queue = rest;
      if (!cutEligible(get(), head.afterClipId, head.beforeClipId)) continue;
      // Insert-only, whatever the cut's own pick: a replace landing would consume clips
      // out from under the cuts still queued behind it.
      const id = get().startCutGeneration(head.afterClipId, head.beforeClipId, 'insert');
      if (id) {
        set((s2) => ({
          animateQueue: rest,
          animateSubmittingId: id,
          // The run tracks every launched cut as a leg; a skipped cut never becomes one.
          animateRun: s2.animateRun
            ? {
                legs: [
                  ...s2.animateRun.legs,
                  { generationId: id, afterClipId: head.afterClipId, beforeClipId: head.beforeClipId },
                ],
              }
            : s2.animateRun,
        }));
        return;
      }
    }
    set({ animateQueue: null, animateSubmittingId: null });
    // The last launch may already be terminal — or every cut was skipped — so the drain
    // itself can be the run's final event, not just a generation update.
    maybeCollapseAnimateRun(set, get);
  },

  applyGenerationUpdate(update) {
    const existing = get().generations[update.generationId];
    if (!existing) return;

    const next: Generation = {
      ...existing,
      status: update.status,
      progress: update.progress,
      jobId: update.jobId ?? existing.jobId,
      elapsedSecs: update.elapsedSecs,
      slow: update.slow,
      outputPath: update.outputPath ?? existing.outputPath,
      error: update.status === 'failed' ? update.error : undefined,
    };
    writeGeneration(set, next);

    if (update.status === 'succeeded' && update.outputPath) {
      if (next.target.kind === 'film') {
        // A film leg is parked, not placed. The film goes onto the track in one piece once
        // every leg is in, so a leg landing early cannot leave half a film in the project —
        // and it goes on by itself, the moment the last leg's file has been measured.
        const epoch = documentEpoch;
        void probeFilmSegmentDuration(
          set,
          epoch,
          next.target.filmSegmentIndex,
          update.outputPath,
        ).then(() => stillCurrent(epoch) && assembleFilmOnTimeline(set, get));
      } else if (next.target.kind === 'image') {
        // A photo goes into the bin and nowhere else: the timeline is the user's, and a
        // generation finishing mid-edit must not move anything they were working on.
        landImageResult(set, get, next, update.outputPath);
      } else if (next.target.kind === 'video') {
        // The same promise for a generated video — with one extra step a photo does not
        // need, because a video has a length and nothing downstream would ever measure it.
        landVideoResult(set, get, next, update.outputPath);
      } else {
        landCutResult(set, get, next, next.target, update.outputPath);
      }
    }

    maybeAdvanceAnimateQueue(set, get, update.generationId);
    maybeCollapseAnimateRun(set, get);
  },

  async cancelGeneration(id) {
    await backend.cancelGeneration(id);
    const existing = get().generations[id];
    if (existing) writeGeneration(set, { ...existing, status: 'cancelled' });
    maybeAdvanceAnimateQueue(set, get, id);
    maybeCollapseAnimateRun(set, get);
  },

  dismissGeneration(id) {
    set((s) => {
      const generations = { ...s.generations };
      delete generations[id];
      return { generations };
    });
  },

  // ------------------------------------------------------- generating a photo

  openImagePanel: () => set((s) => ({ imagePanel: { ...s.imagePanel, open: true } })),

  /**
   * Put the panel away, keeping the draft. Escape and Cancel both land here, and neither
   * is a reasonable way to lose a paragraph of prompt — only a generation that actually
   * went clears it.
   */
  closeImagePanel: () => set((s) => ({ imagePanel: { ...s.imagePanel, open: false } })),

  setImagePrompt: (prompt) => set((s) => ({ imagePanel: { ...s.imagePanel, prompt } })),

  toggleImageReference(assetId) {
    const s = get();
    const attached = s.imagePanel.referenceAssetIds;
    if (attached.includes(assetId)) {
      set({
        imagePanel: {
          ...s.imagePanel,
          referenceAssetIds: attached.filter((id) => id !== assetId),
        },
      });
      return;
    }
    // The tile is only offered when it is usable, but the action guards itself rather
    // than trusting the control that called it.
    if (!referenceEligible(s.assets[assetId])) return;
    if (attached.length >= backend.imageReferenceLimit(s.imagePanel.modelId)) return;
    set({ imagePanel: { ...s.imagePanel, referenceAssetIds: [...attached, assetId] } });
  },

  setImageModel(modelId) {
    set((s) => ({
      imagePanel: {
        ...s.imagePanel,
        modelId,
        // Both follow the model: an aspect it does not publish would fail the whole
        // generation, and a reference past its cap would be refused on arrival.
        aspect: backend.imageAspectFor(modelId, s.imagePanel.aspect),
        referenceAssetIds: s.imagePanel.referenceAssetIds.slice(
          0,
          backend.imageReferenceLimit(modelId),
        ),
      },
    }));
  },

  setImageAspect: (aspect) => set((s) => ({ imagePanel: { ...s.imagePanel, aspect } })),

  startImageGeneration(request) {
    const s = get();
    if (!s.settings?.configured) {
      get().pushToast({
        tone: 'error',
        title: 'Connect Higgsfield first',
        detail: 'Generating a photo runs through the Higgsfield CLI — Settings has the setup.',
      });
      return null;
    }

    const draft = request ?? {
      prompt: s.imagePanel.prompt,
      referenceAssetIds: s.imagePanel.referenceAssetIds,
      modelId: s.imagePanel.modelId,
      aspect: s.imagePanel.aspect,
    };
    const prompt = draft.prompt.trim();
    if (!prompt) return null;

    // A reference the user has since removed from the bin is simply not sent; one that is
    // still there but cannot be sent stops the whole request, because dropping it would
    // quietly generate something other than what was asked for.
    const present = draft.referenceAssetIds.filter((id) => s.assets[id]);
    const unusable = present.filter((id) => !referenceEligible(s.assets[id]));
    if (unusable.length > 0) {
      get().pushToast({
        tone: 'error',
        title: 'A reference photo cannot be sent',
        detail: unusable.map((id) => s.assets[id].name).join(', '),
      });
      return null;
    }

    const modelId = backend.imageModelId(draft.modelId);
    const aspect = backend.imageAspectFor(modelId, draft.aspect);
    const id = launchGeneration(
      set,
      get,
      {
        kind: 'image',
        referenceAssetIds: present,
        aspect,
      },
      prompt,
      modelId,
      {
        kind: 'references',
        paths: present.map((assetId) => s.assets[assetId].path),
        aspect,
      },
    );

    // The generation owns the prompt and the references now, so the panel starts clean —
    // and a second photo can be asked for while the first is still rendering.
    if (!request) set((st) => ({ imagePanel: clearedPanel(st.imagePanel.mode) }));
    return id;
  },

  /**
   * Point the sheet at photos or at video.
   *
   * Only the mode changes. The prompt in particular survives: deciding a described shot
   * should move is a change of mind about the medium, not about the shot.
   */
  setCreateMode: (mode) => set((s) => ({ imagePanel: { ...s.imagePanel, mode } })),

  setVideoModel: (videoModelId) =>
    set((s) => ({ imagePanel: { ...s.imagePanel, videoModelId } })),

  startVideoGeneration(request) {
    const s = get();
    if (!s.settings?.configured) {
      get().pushToast({
        tone: 'error',
        title: 'Connect Higgsfield first',
        detail: 'Generating a video runs through the Higgsfield CLI — Settings has the setup.',
      });
      return null;
    }

    const draft = request ?? {
      prompt: s.imagePanel.prompt,
      modelId: s.imagePanel.videoModelId,
    };
    const prompt = draft.prompt.trim();
    if (!prompt) return null;

    const id = launchGeneration(set, get, { kind: 'video' }, prompt, draft.modelId, {
      kind: 'prompt',
    });

    if (!request) set((st) => ({ imagePanel: clearedPanel(st.imagePanel.mode) }));
    return id;
  },

  // ------------------------------------------------------------------ film

  openFilmWizard: () => set({ filmWizardOpen: true }),

  /**
   * Put the panel away. Deliberately only the panel: a film that is already running keeps
   * running, because stopping a paid render is what the explicit Cancel is for.
   */
  closeFilmWizard: () => set({ filmWizardOpen: false }),

  /**
   * The wizard's photos into the media bin — assets only, nothing on the track.
   *
   * A film is nothing but the transitions between these three photos, so the photos are
   * inputs rather than shots: laying them on the timeline would put stills into a film that
   * is meant to be pure motion. Resolves to the new asset ids in the order given, and
   * throws — naming the files — if the backend would not take one.
   */
  async addFilmPhotos(sources) {
    const epoch = documentEpoch;
    const paths = [...new Set(sources.flatMap((s) => (s.path ? [s.path] : [])))];
    const imported = new Map<string, backend.ImportedMedia>();
    if (paths.length > 0) {
      const result = await backend.importPaths(paths);
      for (const item of result.imported) imported.set(item.path, item);
      if (result.rejected.length > 0) {
        throw new Error(result.rejected.map((r) => `${r.name} — ${r.reason}`).join('; '));
      }
    }

    const added: MediaAsset[] = [];
    const ids: string[] = [];
    // The same photo in two slots is the user's choice; one asset answers for both slots.
    const seen = new Map<string | File, string>();

    for (const source of sources) {
      const key = source.path ?? source.file;
      if (key === undefined) throw new Error(`${source.name} has neither a file nor a path`);

      const already = seen.get(key);
      if (already !== undefined) {
        ids.push(already);
        continue;
      }

      const item = source.path ? imported.get(source.path) : undefined;
      if (source.path && !item) throw new Error(`${source.name} could not be imported`);

      const asset: MediaAsset =
        item !== undefined
          ? {
              id: makeId('asset'),
              name: item.name,
              kind: item.kind,
              path: item.path,
              src: backend.assetSrc(item.path),
              sizeBytes: item.sizeBytes,
            }
          : {
              id: makeId('asset'),
              name: source.name,
              kind: 'photo',
              // A browser drop has no filesystem path; export says so when it matters.
              path: '',
              src: safeObjectUrl(source.file as File),
              sizeBytes: (source.file as File).size,
            };

      added.push(asset);
      seen.set(key, asset.id);
      ids.push(asset.id);
    }

    if (!stillCurrent(epoch)) return ids;
    set((s) => {
      const assets = { ...s.assets };
      for (const asset of added) assets[asset.id] = asset;
      return { assets };
    });
    return ids;
  },

  /**
   * Three photos in, one film out: two Higgsfield transitions run side by side.
   *
   * Nothing is sent — and no film is created — without the Higgsfield CLI. There is no
   * local renderer to fall back to, so a film with no Higgsfield behind it is refused
   * where the user asked for it rather than two legs later.
   */
  async startFilm(assetIds, prompts) {
    const { assets, settings, ffmpegAvailable, modelId, pushToast } = get();

    // A film is two transitions from whatever the selector is showing, so it is refused for
    // the same reasons a single cut is — and named the same way, rather than always blaming
    // a Higgsfield connection the user may not have chosen to use.
    const hint = backend.readinessHint(modelId, settings, ffmpegAvailable);
    if (hint) {
      pushToast({ tone: 'error', title: hint.title, detail: hint.detail });
      return;
    }

    const missing = assetIds.filter((id) => !assets[id]);
    if (missing.length > 0) {
      pushToast({
        tone: 'error',
        title: 'Film could not start',
        detail: `${missing.length} of the chosen photos are no longer in the media bin.`,
      });
      return;
    }

    let film: Film;
    try {
      film = createFilm(assetIds, prompts);
    } catch (error) {
      pushToast({ tone: 'error', title: 'Film could not start', detail: message(error) });
      return;
    }

    set({ film });
    // Both legs at once: they are independent, and a film is only as slow as its slowest.
    for (const segment of film.segments) launchFilmSegment(set, get, segment.index);
  },

  setFilmSegmentPrompt(index, prompt) {
    set((s) => (s.film ? { film: setFilmPrompt(s.film, index, prompt) } : s));
  },

  /** Run one leg again. Whatever already rendered stays rendered — and stays paid for. */
  async retryFilmSegment(index) {
    const segment = get().film?.segments.find((s) => s.index === index);
    if (!segment || segment.status === 'queued' || segment.status === 'running') return;
    launchFilmSegment(set, get, index);
  },

  /**
   * Stop the legs still in flight. Same deal as a single cancel: polling stops, the request
   * already with the API is not recalled.
   */
  async cancelFilm() {
    const film = get().film;
    if (!film) return;
    const ids = inFlightFilmGenerationIds(film);

    set((s) => {
      const generations = { ...s.generations };
      for (const id of ids) {
        const existing = generations[id];
        if (existing) generations[id] = { ...existing, status: 'cancelled' };
      }
      return { generations, film: s.film ? cancelFilmSegments(s.film) : s.film };
    });

    await Promise.all(ids.map((id) => backend.cancelGeneration(id).catch(() => {})));
  },

  /**
   * The finished film onto the track, asked for by hand.
   *
   * A whole film lays itself down the moment its last leg is in, so this is the explicit
   * way in rather than the usual one — and it is where an unfinished film gets told so.
   */
  placeFilmOnTimeline() {
    const film = get().film;
    if (!film || isFilmAssembled(film)) return;
    if (assembleFilmOnTimeline(set, get)) return;

    get().pushToast({
      tone: 'error',
      title: 'The film is not finished',
      detail: `${filmProgress(film).label} — every transition has to land before the film can go on the timeline.`,
    });
  },

  /** Put the film away. Cancel it first if its legs are still running — this only forgets it. */
  dismissFilm() {
    set({ film: null });
  },

  // ------------------------------------------------------------- the saved project

  async restoreProject() {
    let path: string | null = null;
    try {
      path = await backend.lastProjectPath();
    } catch {
      // Only the pointer failed. The scratch is still readable, and opening that beats
      // refusing to open anything at all.
    }

    let raw: unknown;
    try {
      raw = path === null ? await backend.loadProject() : await backend.readProject(path);
    } catch (error) {
      if (path !== null) return refuseRemembered(set, get, path, message(error));
      // Nothing is on screen and nothing is known about what is on disk. Saving stays off:
      // writing now would replace a project that may be perfectly good.
      set({ saveError: message(error), saveBlocked: true });
      return 'blocked';
    }

    const read = readProjectFile(raw);

    // A remembered project is a file the user named, so every way of failing to read it is
    // the same answer: leave it alone and keep pointing at it. The scratch below is the
    // opposite case — this build owns that file, and replacing a bad one is the way out.
    if (path !== null && read.kind !== 'project') {
      return refuseRemembered(
        set,
        get,
        path,
        read.kind === 'newer'
          ? 'It was saved by a newer SolCut.'
          : 'It is not a project this build can read.',
      );
    }

    if (read.kind === 'empty') return 'nothing';

    if (read.kind === 'newer') {
      set({ saveBlocked: true });
      get().pushToast({
        tone: 'error',
        title: 'This project was saved by a newer SolCut',
        detail: 'It is left untouched and nothing is being saved this session. Update SolCut to open it.',
      });
      return 'blocked';
    }

    if (read.kind === 'unreadable') {
      // Replaceable, unlike a newer file: this build understands the format and the stored
      // one is not it, so the next edit overwrites it. That is the only way out.
      get().pushToast({
        tone: 'error',
        title: 'The saved project could not be read',
        detail: 'Starting empty. Anything you do now replaces it.',
      });
      return 'nothing';
    }

    const s = get();
    if (s.clips.length > 0 || s.audioTracks.length > 0 || Object.keys(s.assets).length > 0) {
      // Something landed while the project was being read. That edit is the user's and it
      // wins — but it is not what is on disk, so nothing is written over the stored
      // project either. Restarting is what gets it back.
      set({ saveBlocked: true });
      get().pushToast({
        tone: 'error',
        title: 'The saved project was not restored',
        detail: 'The editor was already in use. Nothing is being saved this session — restart SolCut to open it.',
      });
      return 'blocked';
    }

    installDocument(set, get, hydrate(read.file, { resolveSrc: backend.assetSrc }), path);
    void probeRestoredMedia(set, get, documentEpoch);
    return 'restored';
  },

  async persistProject() {
    // Nothing failed — there was simply nothing this session is allowed to write. Callers
    // read `false` as "the write was refused by the disk", which is a reason to stop.
    if (get().saveBlocked) return true;

    // Every writer queues here rather than only the autosave hook's, because the hook is no
    // longer the only one: the switch flushes, Save as… writes, the close flush writes and
    // the debounce still fires. Two of those aimed at one path would race over a single
    // `.writing` temp file.
    const run = writeQueue.then(async () => {
      const path = get().projectPath;
      // Read once, at the moment the write actually starts rather than when it was queued,
      // so a queued write always carries the newest state — and so the snapshot recorded
      // below describes exactly the bytes that went out.
      const doc = documentOf(get());
      set({ saving: true });
      try {
        await backend.saveProject(toProjectFile(doc), path);
        savedSnapshot = snapshotOf(doc);
        set({ saving: false, savedAt: Date.now() });
        if (get().saveError) set({ saveError: null });
        return true;
      } catch (error) {
        const text = message(error);
        // Said once, when saving starts failing — not again on every debounce after that.
        if (!get().saveError) {
          get().pushToast({ tone: 'error', title: 'The project could not be saved', detail: text });
        }
        // The snapshot is deliberately *not* moved on: the document is still unwritten, so
        // the heartbeat sees it as dirty and tries again without needing another edit.
        set({ saving: false, saveError: text });
        return false;
      }
    });
    writeQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  },

  async openProjectMenu() {
    set({ projectMenuOpen: true, newProjectName: null });
    try {
      set({ recentProjects: await backend.recentProjects() });
    } catch {
      // A menu one section short still opens, and the three actions underneath are the
      // part that has to work. There is no version of "your projects could not be listed"
      // worth a toast over a control the user just clicked.
      set({ recentProjects: [] });
    }
  },

  closeProjectMenu() {
    // The draft goes with the menu. A name half-typed into a menu that has been dismissed
    // is not a name anyone is still thinking about, and finding it again on reopen reads
    // as the field having failed to close.
    set({ projectMenuOpen: false, newProjectName: null });
  },

  openRecentProject(path) {
    beginSwitch(set, get, { kind: 'openPath', path });
  },

  startNewProject() {
    set({ newProjectName: '' });
  },

  setNewProjectName(name) {
    set({ newProjectName: name });
  },

  cancelNewProject() {
    set({ newProjectName: null });
  },

  async createNewProject() {
    const name = get().newProjectName;
    if (name === null || name.trim() === '') return;

    // Where it goes is decided before anything is asked or flushed, so a name that cannot
    // be used costs the user nothing — the same shape as an Open refusing a file it cannot
    // read. The open project is what a new one is created beside.
    let path: string;
    try {
      path = await backend.newProjectPath(name, get().projectPath);
    } catch (error) {
      get().pushToast({
        tone: 'error',
        title: 'That project could not be created',
        detail: message(error),
      });
      return;
    }

    set({ newProjectName: null });
    beginSwitch(set, get, { kind: 'create', path });
  },

  requestOpenProject() {
    beginSwitch(set, get, { kind: 'open' });
  },

  async saveProjectAs() {
    set({ projectMenuOpen: false });

    let picked: string | null = null;
    try {
      picked = await backend.pickProjectSavePath(projectLabel(get().projectPath));
    } catch (error) {
      get().pushToast({
        tone: 'error',
        title: 'Could not open the save dialog',
        detail: message(error),
      });
      return false;
    }
    if (!picked) return false;

    // A file the user has just named cannot be one this session was protecting, so saving
    // comes back on: this is the way out of a blocked session.
    const was = { projectPath: get().projectPath, saveBlocked: get().saveBlocked };
    set({ projectPath: picked, saveBlocked: false });
    if (await get().persistProject()) return true;

    // The write was refused. Aiming autosave at a file the disk will not take would leave
    // every later edit failing too, so the project goes back to living where it did.
    set(was);
    return false;
  },

  async resolveSwitch(choice) {
    const pending = get().pendingSwitch;
    if (!pending || pending.saving) return;

    if (choice === 'cancel') {
      set({ pendingSwitch: null });
      return;
    }

    if (choice === 'save') {
      set({ pendingSwitch: { ...pending, saving: true } });
      const saved = await get().saveProjectAs();
      if (!saved) {
        // Backing out of the save panel backs out of nothing else: the dialog stays up, so
        // the work it exists to protect is still one click from Discard or Cancel.
        set({ pendingSwitch: { ...pending, saving: false } });
        return;
      }
      set({ pendingSwitch: null });
      await performSwitch(set, get, pending.action);
      return;
    }

    set({ pendingSwitch: null });
    await performSwitch(set, get, pending.action, { discard: true });
  },

  // ------------------------------------------------------------------ settings & export

  async loadSettings() {
    try {
      set({ settings: await backend.getSettings() });
    } catch {
      set({ settings: null });
    }
    // Probed separately: a missing ffmpeg says nothing about the credential, and folding
    // both into one `set` meant a rejected probe threw the settings away with it — a
    // configured app then reported itself unconfigured and gated off every generate path.
    try {
      set({ ffmpegAvailable: await backend.ffmpegAvailable() });
    } catch {
      set({ ffmpegAvailable: false });
    }
  },

  openSettings: () => set({ settingsOpen: true, connectionMessage: null }),
  closeSettings: () => set({ settingsOpen: false, connectionMessage: null }),

  async saveSettings(input) {
    try {
      set({ settings: await backend.saveSettings(input), settingsOpen: false, connectionMessage: null });
    } catch (error) {
      set({ connectionMessage: { ok: false, text: message(error) } });
    }
  },

  async testConnection() {
    try {
      set({ connectionMessage: { ok: true, text: await backend.testConnection() } });
    } catch (error) {
      set({ connectionMessage: { ok: false, text: message(error) } });
    }
  },

  /**
   * Prove the API key, which is a different credential from the CLI's — so it reports
   * under its own heading and never touches what `testConnection` said about the CLI.
   *
   * The backend answers with a verdict rather than by throwing, because "the key was
   * refused" and "the check could not be made" are different things and only the second
   * is an error. A throw here is the bridge itself failing (a browser, no desktop shell).
   */
  async testApiKey(input) {
    try {
      const check = await backend.testApiKey(input);
      set({ connectionMessage: { ok: check.ok, title: check.title, text: check.text } });
    } catch (error) {
      set({
        connectionMessage: {
          ok: false,
          title: 'Could not prove the API key',
          text: message(error),
        },
      });
    }
  },

  async runExport() {
    const { clips, audioTracks, assets, aspectRatio, pushToast, exporting } = get();
    if (clips.length === 0) return;
    // One render at a time. The dialog can be dismissed while ffmpeg runs, so `exportState`
    // is no evidence either way — without this a second click starts a second save dialog
    // and a second encode of the same timeline.
    if (exporting) return;

    // A restored clip whose file has since gone still *has* a path, so testing the path
    // alone would wave it through and let ffmpeg die on it mid-render.
    const unplayable = (assetId: string) => {
      const asset = assets[assetId];
      return !asset?.path || asset.missing === true;
    };
    const offline =
      clips.find((c) => unplayable(c.assetId)) ??
      audioTracks.find((t) => !t.muted && unplayable(t.assetId));
    if (offline) {
      set({
        exportState: {
          stage: 'Export blocked',
          fraction: 0,
          status: 'failed',
          // Not retryable: re-running hits this same pre-check. Re-importing mints a *new*
          // asset, so the fix is to put the re-imported file on the track in this clip's
          // place — which is why the copy says that rather than just "re-import".
          error: `“${offline.name}” has no file on disk to render. Re-import it and put it back on the track in place of this clip.`,
          retryable: false,
        },
      });
      return;
    }

    let outPath: string | null = null;
    try {
      outPath = await backend.pickExportPath('solcut-export.mp4');
    } catch (error) {
      pushToast({ tone: 'error', title: 'Export failed', detail: message(error) });
      return;
    }
    if (!outPath) return;

    set({ exporting: true, exportState: { stage: 'Starting…', fraction: 0, status: 'running' } });
    try {
      const written = await backend.exportTimeline(
        buildExportSpec(clips, assets, audioTracks, aspectRatio),
        outPath,
      );
      // Only clear the dialog if it is still *this* run's. Dismissing mid-render and
      // starting another must not have the first one close the second one's progress.
      set((s) => ({ exporting: false, exportState: s.exportState?.status === 'running' ? null : s.exportState }));
      pushToast({
        tone: 'ok',
        title: 'Export complete',
        detail: written,
        action: { label: 'Reveal', path: written },
      });
    } catch (error) {
      set({
        exporting: false,
        exportState: {
          stage: 'Export failed',
          fraction: 0,
          status: 'failed',
          error: message(error),
          retryable: true,
        },
      });
    }
  },

  setExportProgress(stage, fraction) {
    set((s) => (s.exportState?.status === 'running' ? { exportState: { ...s.exportState, stage, fraction } } : s));
  },

  pushToast(toast) {
    set((s) => ({ toasts: [...s.toasts, { ...toast, id: makeId('toast') }] }));
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

// ---------------------------------------------------------------- helpers

type Setter = (partial: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)) => void;

// ------------------------------------------------------------ which project is open

/**
 * Which document the store is holding.
 *
 * Bumped by every install. Async work that started against one project — an import being
 * stat'ed, a duration being decoded, the restore probe walking the filesystem — captures
 * this before its first await and drops its write if it comes back to a different one.
 *
 * Without it, every one of those re-reads `get()` after the await and writes into whatever
 * project is open by then: a 300-photo import launched in one project would land, whole, in
 * the project the user opened while it was still being stat'ed. It costs nothing while a
 * document is never replaced, which is why it was not needed until there was a way to
 * replace one.
 */
let documentEpoch = 0;

/** The project the caller started against is still the one on screen. */
function stillCurrent(epoch: number): boolean {
  return epoch === documentEpoch;
}

/**
 * Every write to disk, in order.
 *
 * `App.tsx` used to be the only writer and serialised itself. It is not any more — a switch
 * flushes, Save as… writes, and the debounce still fires — and two writes aimed at one path
 * would race over its single `.writing` temp file, or land the older timeline last.
 */
let writeQueue: Promise<void> = Promise.resolve();

/** Whether a switch is already in flight — see `performSwitch`. */
let switching = false;

/**
 * The document, pulled out of the session it is living in.
 *
 * The store *is* the document plus a great deal else, and `toProjectFile` used to be handed
 * the whole state and left to pick. It cannot pick any more: `view` is three top-level
 * fields that have to be gathered into one, and `generations` needs the live ones only. One
 * function decides what the project is, and both the writer and the dirty check read it.
 */
function documentOf(s: EditorState): ProjectDocument {
  return {
    assets: s.assets,
    clips: s.clips,
    audioTracks: s.audioTracks,
    cutPrompts: s.cutPrompts,
    cutModes: s.cutModes,
    aspectRatio: s.aspectRatio,
    view: { playheadMs: s.playheadMs, pxPerSecond: s.pxPerSecond, snapping: s.snapping },
    generations: s.generations,
  };
}

/**
 * What the last successful write put on disk, as cheaply as it can be compared.
 *
 * Five object *references* and one string — not a copy of the document. Every action
 * replaces those five immutably, so identity is an exact answer to "has this changed", and
 * the whole snapshot costs a pointer each. The generations line is the one that has to be a
 * projection rather than a reference: `applyGenerationUpdate` replaces the record on every
 * poll to move a progress bar, and none of that reaches the file.
 */
interface DocumentSnapshot {
  assets: unknown;
  clips: unknown;
  audioTracks: unknown;
  cutPrompts: unknown;
  cutModes: unknown;
  aspectRatio: string;
  generations: string;
  view: string;
}

let savedSnapshot: DocumentSnapshot | null = null;

/**
 * Forget what is on disk.
 *
 * Module state outlives a `setState`, so a suite that puts the editor back to first-run has
 * to say so here too — otherwise the next test starts believing its (quite different)
 * document has already been written, and the periodic save sits out the one write it exists
 * to make.
 */
export function forgetSavedSnapshot(): void {
  savedSnapshot = null;
}

function snapshotOf(doc: ProjectDocument): DocumentSnapshot {
  return {
    assets: doc.assets,
    clips: doc.clips,
    audioTracks: doc.audioTracks,
    cutPrompts: doc.cutPrompts,
    cutModes: doc.cutModes,
    aspectRatio: doc.aspectRatio,
    generations: liveGenerationKey(doc.generations ?? {}),
    view: doc.view ? `${doc.view.playheadMs}:${doc.view.pxPerSecond}:${doc.view.snapping}` : '',
  };
}

/**
 * The generations that would be written, as one comparable string.
 *
 * Ids alone are enough: everything else a record persists — its target, prompt and model —
 * is fixed when it is created, so the set changing is the only way the file's contents can.
 */
export function liveGenerationKey(generations: Record<string, Generation>): string {
  return Object.values(generations)
    .filter((g) => g.target.kind !== 'film' && liveGeneration(g))
    .map((g) => g.id)
    .sort()
    .join(',');
}

/**
 * Is there anything on screen that is not on disk?
 *
 * What the periodic save asks itself, and the answer to two different problems: a write
 * that failed and has had no edit since to retry it, and view state — which deliberately
 * never triggers the debounce, because the playhead moves sixty times a second.
 *
 * `playing` is the one exclusion. During playback the playhead changes every frame and
 * writing the file every few seconds for a value nobody asked to keep would be churn; the
 * pause is itself a change, so it lands the moment playback stops.
 */
export function unsavedChanges(s: EditorState): boolean {
  const now = snapshotOf(documentOf(s));
  const before = savedSnapshot;
  // Nothing has been written, and there is nothing to write. This is the launch that found
  // no project — and the one that found an unreadable one, which stays on disk until the
  // user does something, exactly as they were told it would.
  if (!before) return hasWork(s) || now.generations !== '';
  return (
    now.assets !== before.assets ||
    now.clips !== before.clips ||
    now.audioTracks !== before.audioTracks ||
    now.cutPrompts !== before.cutPrompts ||
    now.cutModes !== before.cutModes ||
    now.generations !== before.generations ||
    (!s.playing && now.view !== before.view)
  );
}

/** What to call the open project: its file's name, or that it does not have one yet. */
export function projectLabel(path: string | null): string {
  if (path === null) return 'Untitled project';
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.solcut$/i, '') || base;
}

/**
 * A project with nothing in it.
 *
 * `generations: {}` is not decoration. It is the *only* way generations reach the store
 * through an install, which is what keeps a switch from carrying the outgoing project's
 * records into the incoming one — cards naming clips that no longer exist, wearing a Retry
 * button that would pay to render against a dead cut. No `view`: a new project does not get
 * to reach over and change the zoom the user is working at.
 */
function emptyDocument(): ProjectDocument {
  return {
    assets: {},
    clips: [],
    audioTracks: [],
    cutPrompts: {},
    cutModes: {},
    // A new project is 16:9, whatever the last one was: the frame belongs to the project,
    // so carrying the outgoing one's shape into it would be the document leaking.
    aspectRatio: DEFAULT_ASPECT_RATIO,
    generations: {},
  };
}

/**
 * Everything a switch puts back to how it starts.
 *
 * Deliberately narrower than "not the document". `exportState`/`exporting` stay, because a
 * render is a job on the machine rather than part of the project — and `exporting` is the
 * one-render-at-a-time guard, so clearing it would let a second ffmpeg start over the
 * first. `toasts` stay, or the toast announcing a switch would be destroyed by it. So do
 * the view and connection preferences, which belong to the user rather than to a project.
 */
function freshSession(): Partial<EditorState> {
  return {
    selection: { kind: 'none' },
    playheadMs: 0,
    playing: false,
    // Blanked here and refilled from the document by `installDocument`. Keeping the reset
    // in this list is what makes a *switch* clear generations while a *restore* preserves
    // them — the incoming document is the only thing allowed to put any back.
    generations: {},
    film: null,
    filmWizardOpen: false,
    imagePanel: emptyImagePanel(),
    animateQueue: null,
    animateSubmittingId: null,
    animateRun: null,
    importing: 0,
    importProblems: [],
    draggingAssetId: null,
    saveError: null,
    pendingSwitch: null,
    projectMenuOpen: false,
    // The menu closes with the switch, and a half-typed name closes with it. `recentProjects`
    // deliberately does *not* reset here — the list belongs to the app, like the settings and
    // the ffmpeg probe, not to whichever project happens to be open.
    newProjectName: null,
  };
}

/**
 * Put a project on screen — the one operation that replaces a document.
 *
 * Everything that outlives a `set` has to be taken down by hand first: object URLs nothing
 * will ever revoke again, renders whose clip is about to stop existing, and the media
 * elements the playhead is steered by. Then one `set`, so no render ever sees clips whose
 * assets are not in the bin yet.
 */
function installDocument(
  set: Setter,
  get: () => EditorState,
  doc: ProjectDocument,
  path: string | null,
  opts: { blocked?: boolean } = {},
): void {
  const outgoing = get();
  documentEpoch += 1;

  // A browser drop's object URL lives as long as the process unless something revokes it,
  // and `removeAsset` is the only thing that ever did.
  for (const asset of Object.values(outgoing.assets)) {
    if (asset.src.startsWith('blob:')) URL.revokeObjectURL(asset.src);
  }

  // A render lands on a clip. That clip is about to stop existing, so the job has nowhere
  // to go — stopping the poller is honest, where letting it finish would pay for a result
  // nothing can use and say nothing about it.
  for (const generation of Object.values(outgoing.generations)) {
    if (generation.status === 'queued' || generation.status === 'running') {
      void backend.cancelGeneration(generation.id);
    }
  }

  // The registry is keyed by clip id, and the outgoing project's elements would go on
  // steering the playhead in the incoming one.
  resetPreviewSync();

  // Restored records only, and only the ones whose cut still stands: `prunedAfterEdit` is
  // the same rule an edit applies, so a record with no chip and no card to be dismissed
  // from is dropped here rather than left as invisible state.
  const pruned = prunedAfterEdit(doc.clips, doc.generations ?? {}, doc.cutPrompts, doc.cutModes);

  set({
    ...doc,
    ...freshSession(),
    // After `freshSession`, which blanks both — a restore is the one install that has
    // something to put back, and an empty document supplies `{}` for the rest.
    ...pruned,
    ...(doc.view
      ? {
          playheadMs: doc.view.playheadMs,
          pxPerSecond: doc.view.pxPerSecond,
          snapping: doc.view.snapping,
        }
      : {}),
    projectPath: path,
    saveBlocked: opts.blocked === true,
  });

  // What is on screen is exactly what is on disk, so the periodic save has nothing to do
  // until something changes. Without this a freshly restored project reads as unwritten and
  // would be written straight back for no reason.
  savedSnapshot = snapshotOf(documentOf(get()));
}

/** A remembered project this build must not replace: keep pointing at it, and write nothing. */
function refuseRemembered(
  set: Setter,
  get: () => EditorState,
  path: string,
  why: string,
): RestoreOutcome {
  set({ projectPath: path, saveBlocked: true });
  get().pushToast({
    tone: 'error',
    title: 'The last project could not be opened',
    detail: `${why} It is left untouched and nothing is being saved — open a project, or start a new one.`,
  });
  return 'blocked';
}

/**
 * Start a switch, asking first only when there is work with nowhere to go.
 *
 * A project that has a file is flushed to it and swapped without a word; an empty editor
 * has nothing to lose. It is work that cannot be written anywhere that has to be asked
 * about, and the question it is asked is the same one the launch restore asks about the
 * editor being in use — clips, or lanes, or anything sitting in the bin.
 *
 * **Having a path is not the same as having somewhere to go.** `refuseRemembered` leaves the
 * path pointing at a project this build must not touch *and* sets `saveBlocked`, and
 * `persistProject` answers `true` while blocked — so `performSwitch`'s flush reports success
 * having written nothing, and the switch went through silently. It then wrote the *empty*
 * document over the untitled scratch on the way out, so a real project on disk died with the
 * one on screen. A blocked session is precisely the case where the path proves nothing.
 */
function beginSwitch(set: Setter, get: () => EditorState, action: SwitchAction): void {
  set({ projectMenuOpen: false });
  const s = get();
  if ((s.projectPath === null || s.saveBlocked) && hasWork(s)) {
    set({ pendingSwitch: { action, saving: false } });
    return;
  }
  void performSwitch(set, get, action);
}

function hasWork(s: EditorState): boolean {
  return s.clips.length > 0 || s.audioTracks.length > 0 || Object.keys(s.assets).length > 0;
}

/**
 * Swap the open project for another one, or for an empty one.
 *
 * The order is the whole of the safety. For an Open, the picked file is read *first* and a
 * bad read refuses the switch outright, so a file that cannot be opened costs the user
 * nothing — the opposite of the launch restore, which may start empty and replace, because
 * there the user has not pointed at anything. Only then is the outgoing project written,
 * and only if that write lands does anything on screen change.
 */
async function performSwitch(
  set: Setter,
  get: () => EditorState,
  action: SwitchAction,
  opts: { discard?: boolean } = {},
): Promise<void> {
  // One switch at a time. Both entry points used to be modal — a native picker, or the
  // confirm dialog — so two could not overlap; a menu of projects makes double-entry one
  // stray double-click away, and two switches would each pass their read, each flush, and
  // each install. Released in `finally`, so a refusal never wedges the next one.
  if (switching) return;
  switching = true;
  try {
    await runSwitch(set, get, action, opts);
  } finally {
    switching = false;
  }
}

async function runSwitch(
  set: Setter,
  get: () => EditorState,
  action: SwitchAction,
  opts: { discard?: boolean },
): Promise<void> {
  // Every action lands on a real file now, so a switch always has somewhere to go.
  let next: { doc: ProjectDocument; path: string };

  if (action.kind === 'create') {
    // Nothing to read — the file does not exist yet. What stands in for the open branch's
    // "refuse a file we cannot read" is `create` itself, further down: it is the write that
    // refuses, atomically, if the name has been taken since it was chosen.
    next = { doc: emptyDocument(), path: action.path };
  } else {
    let picked: string | null = null;
    if (action.kind === 'openPath') {
      picked = action.path;
    } else {
      try {
        picked = await backend.pickProjectFile();
      } catch (error) {
        get().pushToast({
          tone: 'error',
          title: 'Could not open the file picker',
          detail: message(error),
        });
        return;
      }
    }
    if (!picked) return;
    // Already open. Reading it and then flushing over it would write the live timeline to
    // the file and put the bytes read *before* that flush back on screen — the edits since
    // the last autosave gone from both.
    if (picked === get().projectPath) return;

    let raw: unknown;
    try {
      raw = await backend.readProject(picked);
    } catch (error) {
      get().pushToast({
        tone: 'error',
        title: 'That project could not be opened',
        detail: message(error),
      });
      return;
    }

    const read = readProjectFile(raw);
    if (read.kind !== 'project') {
      get().pushToast({
        tone: 'error',
        title:
          read.kind === 'newer'
            ? 'That project was saved by a newer SolCut'
            : 'That file is not a SolCut project',
        detail: 'It is left untouched, and the project you were in is still open.',
      });
      return;
    }
    next = { doc: hydrate(read.file, { resolveSrc: backend.assetSrc }), path: picked };
  }

  if (opts.discard) {
    // Discarded means discarded. The untitled project also has a copy in the scratch, and
    // clearing only what is in memory would leave that copy on disk for a later New to
    // destroy without ever asking — and would have made the word a lie in the meantime.
    try {
      await backend.saveProject(toProjectFile(emptyDocument()), null);
    } catch {
      // The scratch is a convenience, not the user's file. Failing to clear it is not
      // worth refusing the switch they asked for.
    }
  } else if (!(await get().persistProject())) {
    // The outgoing project could not be written — an unplugged drive, a full disk. Wiping
    // it off screen anyway would lose everything since the last autosave landed, so it
    // stays, with the toast the failed write already raised.
    return;
  }

  // The new file is written *before* the document is installed, and the switch is refused
  // if that write fails. The order is the whole of the safety, for a reason that is not
  // obvious: `installDocument` stamps `savedSnapshot` with what is on screen, asserting
  // that screen and disk agree. Install first and that assertion is a lie — `unsavedChanges`
  // would report the project clean, `App.tsx`'s heartbeat would never retry the creation,
  // and the user would be left editing a project that does not exist while `current.txt`
  // still named the old one, which is what the next launch would reopen.
  //
  // It is also why this cannot go through `persistProject`: that writes `documentOf(get())`,
  // which at this moment is still the *outgoing* document, and it reports success without
  // writing at all while `saveBlocked` is up.
  if (action.kind === 'create') {
    const path = next.path;
    const written = writeQueue.then(() =>
      backend.createProject(toProjectFile(emptyDocument()), path),
    );
    writeQueue = written.then(
      () => {},
      () => {},
    );
    try {
      await written;
    } catch (error) {
      get().pushToast({
        tone: 'error',
        title: 'The project could not be created',
        detail: message(error),
      });
      return;
    }
  }

  installDocument(set, get, next.doc, next.path);
  const epoch = documentEpoch;
  // One write straight away, so the pointer to the current project follows the switch even
  // if the user quits without touching anything.
  void get().persistProject();
  // A project that was just created has no media to have gone missing since.
  if (action.kind !== 'create') void probeRestoredMedia(set, get, epoch);
}

/** One accepted import: a clip bound for the visual track, or a sound bound for a lane. */
type Imported = { asset: MediaAsset; clip?: Clip; track?: AudioTrack };

function placed(asset: MediaAsset, audioStartMs: number, sourceDurationMs?: number): Imported {
  if (asset.kind === 'audio') {
    return {
      asset,
      track: audioTrack(asset, audioStartMs, sourceDurationMs ?? DEFAULT_AUDIO_DURATION_MS),
    };
  }
  return {
    asset,
    clip:
      asset.kind === 'photo'
        ? photoClip(asset, DEFAULT_PHOTO_DURATION_MS)
        : videoClip(asset, sourceDurationMs ?? DEFAULT_VIDEO_DURATION_MS),
  };
}

/**
 * Clips appear at their default length straight away and correct themselves once the real
 * duration is known — an import that blocks on decoding feels broken.
 */
function commitImport(
  set: Setter,
  epoch: number,
  accepted: Imported[],
  problems: ImportProblem[],
  index?: number,
) {
  if (accepted.length === 0 && problems.length === 0) return;
  // The choke point every import lands through, which is why the epoch is checked here
  // rather than at each caller: a rule kept in three places is one a fourth caller forgets.
  // `import_media` stats every path on the main thread, so a large import is seconds long
  // and a project switch inside that window is ordinary.
  if (!stillCurrent(epoch)) return;

  set((s) => {
    const assets = { ...s.assets };
    for (const { asset } of accepted) assets[asset.id] = asset;
    const at = index ?? s.clips.length;
    const clips = insertClips(
      s.clips,
      at,
      accepted.flatMap((a) => (a.clip ? [a.clip] : [])),
    );
    const audioTracks = [...s.audioTracks, ...accepted.flatMap((a) => (a.track ? [a.track] : []))];
    const first = accepted[0];
    return {
      assets,
      clips,
      audioTracks,
      // An insertion is an edit like any other: landing a clip between two photos breaks
      // their cut, and a failed generation keyed on that pair would be left with no chip and
      // no card to dismiss it from. Nothing else is dropped — an insertion removes no clip.
      ...prunedAfterEdit(clips, s.generations, s.cutPrompts, s.cutModes),
      importProblems: [...s.importProblems, ...problems],
      selection: first?.clip
        ? { kind: 'clip', clipId: first.clip.id }
        : first?.track
          ? { kind: 'audio', trackId: first.track.id }
          : s.selection,
    };
  });
}

async function probeDurations(set: Setter, epoch: number, accepted: Imported[]) {
  await Promise.all(
    accepted.map(async ({ asset, clip, track }) => {
      if (asset.kind === 'photo') return;
      const durationMs =
        asset.kind === 'video'
          ? await probeVideoDurationMs(asset.src, DEFAULT_VIDEO_DURATION_MS)
          : await probeAudioDurationMs(asset.src, DEFAULT_AUDIO_DURATION_MS);
      if (!stillCurrent(epoch)) return;
      set((s) => {
        // A trim that landed while the probe was in flight is the user's, not ours: they
        // have said what length they want and the measurement is only news. Where they
        // dragged it to is a separate question and stays theirs either way — retiming
        // moves what is *behind* a clip, never the clip itself.
        const landed = clip ? s.clips.find((c) => c.id === clip.id) : undefined;
        const ours =
          landed !== undefined &&
          landed.durationMs === DEFAULT_VIDEO_DURATION_MS &&
          landed.trimStartMs === 0;
        return {
          // The asset keeps the source length for good: it is what bounds a later trim.
          assets: s.assets[asset.id]
            ? { ...s.assets, [asset.id]: { ...s.assets[asset.id], durationMs } }
            : s.assets,
          // The reel closes up behind the correction. Writing the real length in place
          // left black behind a file shorter than the guess and two clips on one instant
          // behind a longer one — neither of which the user asked for.
          clips: ours ? retimeClip(s.clips, landed.id, durationMs) : s.clips,
          // A sound is not a clip: its lane holds one sound and moves nothing, so its
          // length is corrected where it stands.
          audioTracks: s.audioTracks.map((t) =>
            t.id === track?.id && t.durationMs === DEFAULT_AUDIO_DURATION_MS && t.trimStartMs === 0
              ? { ...t, durationMs }
              : t,
          ),
        };
      });
    }),
  );
}

/**
 * Ask the filesystem which restored media is actually still where it was left.
 *
 * Runs *after* the project is on screen, deliberately: `import_media` is a synchronous
 * Tauri command doing a blocking stat per path, so probing first would hold the window
 * shut while a sleeping drive or an unmounted share woke up. It imports nothing — the
 * command only reads — so this is a question, not an edit.
 */
async function probeRestoredMedia(
  set: Setter,
  get: () => EditorState,
  epoch: number,
): Promise<void> {
  const paths = [
    ...new Set(
      Object.values(get().assets)
        .map((asset) => asset.path)
        .filter(Boolean),
    ),
  ];

  let gone: Set<string> = new Set();
  if (paths.length > 0) {
    try {
      const result = await backend.importPaths(paths);
      const found = new Set((result?.imported ?? []).map((item) => item.path));
      gone = new Set(paths.filter((path) => !found.has(path)));
    } catch {
      // Only the probe failed. The media is probably exactly where it was, and calling all
      // of it missing would make a working project look broken.
    }
  }

  // The answer is about the project that asked. Folding it into a project opened since
  // would clear `missing` from media this probe never looked at.
  if (!stillCurrent(epoch)) return;

  const marked = markMissing(get().assets, gone);
  // `markMissing` hands back the same object when nothing changed, so a project whose
  // media is all present does not look like an edit and does not cost a write.
  if (marked.assets !== get().assets) set({ assets: marked.assets });
  if (marked.missing.length > 0) reportMissingMedia(get, marked.missing);
}

/** One toast for everything the restore could not find, however many files that is. */
function reportMissingMedia(get: () => EditorState, missing: MediaAsset[]): void {
  const names = missing.map((asset) => asset.name);
  const shown = names.slice(0, 3).join(', ');
  const rest = names.length - 3;
  get().pushToast({
    tone: 'error',
    title: `${names.length} ${names.length === 1 ? 'file is' : 'files are'} no longer on disk`,
    detail: `${rest > 0 ? `${shown} and ${rest} more` : shown} — re-import ${
      names.length === 1 ? 'it' : 'them'
    } and put ${names.length === 1 ? 'it' : 'them'} back on the track. Export is blocked until then.`,
  });
}

function safeObjectUrl(file: File): string {
  try {
    return URL.createObjectURL(file);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- generation plumbing

function cutKey(afterClipId: string, beforeClipId: string): string {
  return `${afterClipId}:${beforeClipId}`;
}

/**
 * The mode a cut launch stamps — and the mode its card displays. One expression for both,
 * so the card can never promise one landing and get another. The pair has the final say:
 * with no still on either side there is nothing for a replace to stand in for. Otherwise an
 * explicit `mode` (the animate-all queue's forced insert) wins, then the cut's own stored
 * pick; only the *fallback* changes with the weather — replace by default, insert while an
 * Animate all run is live, because a replace landing would consume clips out from under the
 * legs still behind it.
 */
export function resolveCutMode(
  s: Pick<EditorState, 'cutModes' | 'animateRun'>,
  a: Clip,
  b: Clip,
  mode?: TransitionMode,
): TransitionMode {
  // Two videos have no still to stand in for, so `replace` is not a choice they can make —
  // not from a stored pick, and not from the animate queue. It is the pair that decides.
  if (!cutOffersReplace(a, b)) return 'insert';
  return (
    mode ??
    s.cutModes[cutKey(a.id, b.id)] ??
    (s.animateRun !== null ? 'insert' : DEFAULT_TRANSITION_MODE)
  );
}

function liveGeneration(g: Generation): boolean {
  return g.status === 'queued' || g.status === 'running';
}

/**
 * Whether this cut could start a generation right now: the pair still forms a cut (side by
 * side, touching or across a gap — whatever the two clips are), both sources on hand, and
 * no job already running for it. Settings are checked separately — an
 * unconfigured app changes what the UI says, not what a cut is.
 */
export function cutEligible(
  s: Pick<EditorState, 'clips' | 'assets' | 'generations'>,
  afterClipId: string,
  beforeClipId: string,
): boolean {
  const cut = bridgeableCuts(s.clips).find(
    (c) => c.afterClipId === afterClipId && c.beforeClipId === beforeClipId,
  );
  if (!cut) return false;
  const a = s.clips.find((c) => c.id === afterClipId);
  const b = s.clips.find((c) => c.id === beforeClipId);
  if (!a || !b) return false;
  const assetA = s.assets[a.assetId];
  const assetB = s.assets[b.assetId];
  if (!assetA || !assetB || assetA.missing || assetB.missing) return false;
  return !Object.values(s.generations).some(
    (g) =>
      liveGeneration(g) &&
      g.target.kind === 'cut' &&
      g.target.replacesClipId === undefined &&
      g.target.afterClipId === afterClipId &&
      g.target.beforeClipId === beforeClipId,
  );
}

/**
 * The cuts "✦ Animate all" would fill right now — photo→photo only, though a chip stands on
 * every kind of cut.
 *
 * One tap must not start a paid render at every boundary of a reel of footage. Bridging
 * video is a deliberate act, taken one cut at a time from its own chip; filling the stills
 * between photos in one go is the thing worth a button.
 */
export function animatableCuts(s: Pick<EditorState, 'clips' | 'assets' | 'generations'>): Cut[] {
  const byId = new Map(s.clips.map((c) => [c.id, c]));
  return bridgeableCuts(s.clips).filter(
    (cut) =>
      byId.get(cut.afterClipId)?.kind === 'photo' &&
      byId.get(cut.beforeClipId)?.kind === 'photo' &&
      cutEligible(s, cut.afterClipId, cut.beforeClipId),
  );
}

/**
 * After any edit that removes clips or moves their edges apart: prompts and mode picks for
 * cuts whose clips are gone go, and so do FAILED cut generations whose pair no longer
 * forms a cut — those have no chip and no card left to dismiss them from, so keeping them
 * would leak invisible state.
 */
function prunedAfterEdit(
  clips: Clip[],
  generations: Record<string, Generation>,
  cutPrompts: Record<string, string>,
  cutModes: Record<string, TransitionMode>,
): Pick<EditorState, 'generations' | 'cutPrompts' | 'cutModes'> {
  const ids = new Set(clips.map((c) => c.id));
  const cuts = new Set(bridgeableCuts(clips).map((c) => cutKey(c.afterClipId, c.beforeClipId)));

  const bothStand = ([key]: [string, unknown]) => {
    const [a, b] = key.split(':');
    return ids.has(a) && ids.has(b);
  };
  return {
    cutPrompts: Object.fromEntries(Object.entries(cutPrompts).filter(bothStand)),
    cutModes: Object.fromEntries(Object.entries(cutModes).filter(bothStand)),
    generations: Object.fromEntries(
      Object.entries(generations).filter(([, g]) => {
        if (g.status !== 'failed' || g.target.kind !== 'cut') return true;
        if (g.target.replacesClipId !== undefined) return ids.has(g.target.replacesClipId);
        return cuts.has(cutKey(g.target.afterClipId, g.target.beforeClipId));
      }),
    ),
  };
}

/**
 * The one place a generation is written.
 *
 * A film leg's state lives in two places — the generation board and the film — and this
 * keeps them from drifting: update the generation and the leg follows, always.
 */
function writeGeneration(set: Setter, generation: Generation): void {
  set((s) => ({
    generations: { ...s.generations, [generation.id]: generation },
    film:
      generation.target.kind === 'film' && s.film
        ? applyGenerationToFilm(s.film, generation as FilmGeneration)
        : s.film,
  }));
}

/**
 * Send one leg of the film out: photo A, then photo B, each drawn straight — the photos
 * themselves are the frames, with nothing baked in beyond the cover-crop every still gets.
 */
function launchFilmSegment(set: Setter, get: () => EditorState, index: number): void {
  const segment = get().film?.segments.find((s) => s.index === index);
  if (!segment) return;

  const { assets } = get();
  const start = assets[segment.startAssetId];
  const end = assets[segment.endAssetId];
  if (!start || !end) {
    const gone: GenerationError = {
      title: 'Photo missing',
      message: 'One of the two photos for this transition is no longer in the media bin.',
      retryable: false,
    };
    set((s) => (s.film ? { film: markFilmSegmentFailed(s.film, index, gone) } : s));
    get().pushToast({ tone: 'error', title: gone.title, detail: gone.message });
    return;
  }

  launchGeneration(
    set,
    get,
    {
      kind: 'film',
      startAssetId: segment.startAssetId,
      endAssetId: segment.endAssetId,
      filmSegmentIndex: index,
    },
    segment.prompt.trim() || defaultFilmPrompt(index),
    get().modelId,
    // A film is made of photos only, so both ends are stills already.
    {
      kind: 'frames',
      from: { kind: 'photo', src: start.src },
      to: { kind: 'photo', src: end.src },
    },
    // The leg claims the id before anything is sent, so a straggling update from the run
    // this one replaces is recognisably stale.
    (id) => set((s) => (s.film ? { film: markFilmSegmentQueued(s.film, index, id) } : s)),
  );
}

/**
 * The film onto the track: one clip per leg, in segment order, appended after the last clip.
 *
 * The one place a film is assembled, and it happens **once**. Two things make that matter:
 * the position is resolved here rather than when the film was started — the editor stays
 * usable through a multi-minute render, so any position captured earlier is already stale —
 * and a leg can still be retried after the film has landed, which must not lay down a
 * second copy. `false` means there was nothing whole to place, or it is already placed.
 */
function assembleFilmOnTimeline(set: Setter, get: () => EditorState): boolean {
  const film = get().film;
  if (!film || isFilmAssembled(film)) return false;

  const assembled = assembleFilm(film, backend.assetSrc);
  if (!assembled) return false;

  set((s) => {
    const assets = { ...s.assets };
    for (const asset of assembled.assets) assets[asset.id] = asset;
    const first = assembled.clips[0];
    return {
      assets,
      // Laid end to end after whatever is on the track, gaps in front of them kept.
      clips: insertClips(s.clips, insertIndexAtTime(s.clips, trackEndMs(s.clips)), assembled.clips),
      selection: first ? { kind: 'clip', clipId: first.id } : s.selection,
      film: s.film ? markFilmAssembled(s.film, assembled.clips.map((c) => c.id)) : s.film,
    };
  });
  get().pushToast({
    tone: 'ok',
    title: 'Film on the timeline',
    detail: `${assembled.clips.length} transitions — ready to export`,
  });
  return true;
}

/** A leg's real length, read off the file Higgsfield actually returned. */
async function probeFilmSegmentDuration(
  set: Setter,
  epoch: number,
  index: number,
  outputPath: string,
): Promise<void> {
  const durationMs = await probeVideoDurationMs(
    backend.assetSrc(outputPath),
    FILM_SEGMENT_DURATION_MS,
  );
  if (!stillCurrent(epoch)) return;
  set((s) => {
    // Retried while the probe was in flight: that run's file owns the leg's length now.
    if (!s.film || s.film.segments.find((x) => x.index === index)?.outputPath !== outputPath) {
      return s;
    }
    return { film: patchFilmSegment(s.film, index, { durationMs }) };
  });
}

/**
 * What one end of a generation is rendered from.
 *
 * Higgsfield animates between two stills, and where a still comes from depends on what is
 * standing there: a photo is already one and is drawn in the webview, while a video has to
 * give up the frame at its edge, which is pulled off the file by ffmpeg. Two shapes rather
 * than one with optional fields, so a video source can never reach the backend without the
 * moment it was taken from.
 */
type FrameSource =
  | { kind: 'photo'; src: string }
  | { kind: 'video'; path: string; atMs: number };

/** The frame a clip on the track contributes at one of its edges. */
function frameOfClip(asset: MediaAsset, clip: Clip, edge: 'out' | 'in'): FrameSource {
  return clip.kind === 'video'
    ? { kind: 'video', path: asset.path, atMs: anchorMs(clip, edge) ?? 0 }
    : { kind: 'photo', src: asset.src };
}

/**
 * The frame a recorded source contributes once its clip is gone — what a replace-mode
 * regeneration has left to work from. A record written before transitions could involve
 * video carries no `atMs`, and never needed one: its sources were photos.
 */
function frameOfSource(asset: MediaAsset, source: TransitionSource): FrameSource {
  return asset.kind === 'video'
    ? { kind: 'video', path: asset.path, atMs: source.atMs ?? 0 }
    : { kind: 'photo', src: asset.src };
}

/**
 * One still, whichever kind of source it came from, as the data URL the backend takes.
 *
 * `size` is the project's frame, scaled down: the two stills are the *ends of one motion*,
 * so they have to be the same shape as each other and as the frame the result will be shown
 * in — a 16:9 anchor animated into a 9:16 project comes back as a letterboxed strip.
 */
async function renderFrame(source: FrameSource, size: FrameSize): Promise<string> {
  return source.kind === 'photo'
    ? renderPhotoJpeg(source.src, size.width, size.height)
    : backend.captureVideoFrame(source.path, source.atMs, size.width, size.height);
}

/**
 * What a launch actually sends — the one thing the two kinds of generation differ on.
 *
 * A transition renders each end to a still and posts the two as data URLs; a photo sends
 * the paths of the bin files it works from and lets the CLI upload them. Everything around
 * it — the record, the id, the failure tail — is shared, so the two cannot drift.
 */
/**
 * How much track a transition between these two clips will occupy.
 *
 * The whole stretch from where the left clip starts to where the right one ends, gap
 * included — because a replace landing consumes both stills and stands in for exactly that.
 * Only the local backends read it, to pick a length that keeps the film's pacing.
 */
function spanOf(a: Clip, b: Clip): number {
  return Math.max(0, b.startMs + b.durationMs - a.startMs);
}

type Submission =
  | {
      kind: 'frames';
      from: FrameSource;
      to: FrameSource;
      /**
       * How long the stretch of track this transition will occupy currently runs. Only the
       * local backends read it, and only to choose a length — a film leg has no track to
       * measure, so it sends none rather than a made-up number.
       */
      spanMs?: number;
    }
  | { kind: 'references'; paths: string[]; aspect: string }
  /** A prompt-only video: the words are the whole submission. */
  | { kind: 'prompt' };

/**
 * Record a generation and submit it. The record lands synchronously (so callers get an id
 * to track); the submission runs behind it, and a failure to even start — which emits no
 * backend event — marks the record failed and nudges the animate-all queue so it cannot
 * stall on the silence.
 */
function launchGeneration(
  set: Setter,
  get: () => EditorState,
  target: GenerationTarget,
  prompt: string,
  /**
   * The model this generation records and sends. Read at the call site, so a render
   * carries the model that was showing when its button was pressed — switching a selector
   * afterwards changes the next render only.
   */
  modelId: string,
  submission: Submission,
  /**
   * Runs before the record is written, with the id it is about to get. A film leg uses it
   * to claim the id, so the leg recognises this run's updates and not the one it replaced.
   */
  claim?: (generationId: string) => void,
): string {
  const generationId = makeId('gen');
  claim?.(generationId);
  const generation: Generation = {
    id: generationId,
    target,
    prompt,
    modelId,
    status: 'queued',
    progress: 0,
    elapsedSecs: 0,
    slow: false,
  };
  writeGeneration(set, generation);

  void (async () => {
    try {
      if (submission.kind === 'frames') {
        const provider = backend.providerOf(modelId);
        // `modelJob` throws for a local backend rather than resolving to a Higgsfield job,
        // so it is asked only when Higgsfield is the one rendering. That order is the guard:
        // getting it wrong is a paid render for a cut the user asked to composite locally.
        const model =
          provider === 'higgsfield'
            ? backend.modelJob(modelId, get().settings?.customModel)
            : undefined;
        // Read at launch, not at record time: the frame is what the user is looking at
        // when they press the button, and a reshape between the two would be a lie.
        const still = stillSize(get().aspectRatio);
        const startFrame = await renderFrame(submission.from, still);
        const endFrame = await renderFrame(submission.to, still);
        await backend.generateAnimation({
          generationId,
          prompt,
          startFrame,
          endFrame,
          model,
          provider,
          spanMs: submission.spanMs,
        });
      } else if (submission.kind === 'references') {
        await backend.generateImage({
          generationId,
          prompt,
          references: submission.paths,
          model: backend.imageModelJob(modelId),
          aspectRatio: submission.aspect,
        });
      } else {
        // `modelJob` throws rather than resolving a local backend's id to a Higgsfield
        // job, which is the guard that matters here: those backends composite between two
        // stills and cannot make a shot from words, so an id that reached this line would
        // otherwise start a paid render nobody asked for. It also normalises `custom` to
        // the model id Settings holds.
        await backend.generateVideo({
          generationId,
          prompt,
          model: backend.modelJob(modelId, get().settings?.customModel),
        });
      }
    } catch (error) {
      const existing = get().generations[generationId];
      if (existing) {
        writeGeneration(set, {
          ...existing,
          status: 'failed',
          error: { title: 'Could not start', message: message(error), retryable: true },
        });
      }
      get().pushToast({ tone: 'error', title: 'Generation could not start', detail: message(error) });
      maybeAdvanceAnimateQueue(set, get, generationId);
      maybeCollapseAnimateRun(set, get);
    }
  })();

  return generationId;
}

/**
 * A finished cut render: insert the transition at its cut, stand it in the place of the
 * pair's stills (replace mode), or — for a regeneration — swap it over the existing
 * transition clip. The timeline may have been edited mid-render, so the landing is
 * guarded: if the place is gone the clip is never put somewhere wrong, the MP4 stays in
 * the cache, and a toast says what to do instead.
 *
 * A replace landing consumes the pair's stills, which is an edit like any other: prompts,
 * mode picks and failed records for cuts those clips took with them are pruned, and a live
 * render whose own clips were just consumed is cancelled — nothing is left to land it on.
 */
/**
 * A finished photo: put it in the media bin, and nowhere else.
 *
 * Nothing on the timeline moves — the user drags it on when they want it, exactly like an
 * import — so a generation completing mid-edit can never rearrange what they were doing.
 * It is an ordinary photo asset with a real path, which is the whole of its persistence:
 * it round-trips through `project.json` like any imported file.
 */
function landImageResult(
  set: Setter,
  get: () => EditorState,
  generation: Generation,
  outputPath: string,
): void {
  const asset: MediaAsset = {
    id: makeId('asset'),
    // The file's own name. The backend chose the extension from what the server actually
    // served, so taking the name from the path is what keeps the bin's label and the file
    // on disk from ever disagreeing.
    name: outputPath.split(/[\\/]/).pop() || `ai-${generation.id}.png`,
    kind: 'photo',
    path: outputPath,
    src: backend.assetSrc(outputPath),
    // Unmeasured, like every generated asset: nothing reads it, and stat-ing the file
    // would be a round trip for a number the bin does not show.
    sizeBytes: 0,
  };
  set((s) => ({ assets: { ...s.assets, [asset.id]: asset } }));
  get().pushToast({ tone: 'ok', title: 'Photo ready', detail: generation.prompt });
}

/**
 * A generated video, landing in the bin — and then measured.
 *
 * The same promise `landImageResult` makes: nothing on the timeline moves, and the user
 * drags it on when they want it. The difference is the probe, and it is not optional.
 *
 * A video clip needs a length, and the bin-drag path is the one place nothing would ever
 * supply one later: `placeAssetOnTimeline` passes the asset's own `durationMs` straight
 * through, and `probeDurations` only ever patches the clip its own import created. So an
 * unmeasured generated video would land at the 5 s default **and stay there for good**,
 * however long the file really is. Measuring it here, once, is what makes it behave like
 * any imported video — and `durationMs` persists with the project, so this never has to
 * run again.
 *
 * Both guards on the probe's result are load-bearing:
 *
 * - `stillCurrent(epoch)` — the answer is about the project that asked. A probe resolving
 *   after the user opened another project would otherwise write a length into whichever
 *   one is open now.
 * - the asset-presence check — a probe resolving after the user deleted the tile would
 *   otherwise put the asset back as a `{ durationMs }`-only husk with no path and no name.
 */
function landVideoResult(
  set: Setter,
  get: () => EditorState,
  generation: Generation,
  outputPath: string,
): void {
  const asset: MediaAsset = {
    id: makeId('asset'),
    // The file's own name, as with a photo. The backend named it `.mp4` itself rather than
    // from what the server said it served, which is what keeps the bin — whose only way of
    // telling media apart is the extension — from reading this back as a photo.
    name: outputPath.split(/[\\/]/).pop() || `ai-${generation.id}.mp4`,
    kind: 'video',
    path: outputPath,
    src: backend.assetSrc(outputPath),
    sizeBytes: 0,
  };
  set((s) => ({ assets: { ...s.assets, [asset.id]: asset } }));
  get().pushToast({ tone: 'ok', title: 'Video ready', detail: generation.prompt });

  const epoch = documentEpoch;
  void probeVideoDurationMs(asset.src, DEFAULT_VIDEO_DURATION_MS).then((durationMs) => {
    if (!stillCurrent(epoch)) return;
    set((s) => ({
      assets: s.assets[asset.id]
        ? { ...s.assets, [asset.id]: { ...s.assets[asset.id], durationMs } }
        : s.assets,
    }));
  });
}

function landCutResult(
  set: Setter,
  get: () => EditorState,
  generation: Generation,
  target: Extract<GenerationTarget, { kind: 'cut' }>,
  outputPath: string,
): void {
  const asset: MediaAsset = {
    id: makeId('asset'),
    name: `ai-${generation.id}.mp4`,
    kind: 'video',
    path: outputPath,
    src: backend.assetSrc(outputPath),
    sizeBytes: 0,
  };
  const generated: GeneratedTransition = {
    assetId: asset.id,
    name: asset.name,
    prompt: generation.prompt,
    durationMs: DEFAULT_TRANSITION_DURATION_MS,
    from: target.from,
    to: target.to,
    mode: target.mode,
  };
  const replacesPair = target.replacesClipId === undefined && target.mode === 'replace';

  let landedClipId: string | null = null;
  const cancelledIds: string[] = [];
  set((s) => {
    const clips =
      target.replacesClipId !== undefined
        ? replaceTransitionClip(s.clips, target.replacesClipId, generated)
        : replacesPair
          ? replacePairWithTransition(s.clips, target.afterClipId, target.beforeClipId, generated)
          : insertTransitionClip(s.clips, target.afterClipId, target.beforeClipId, generated);
    if (clips === s.clips) return s;
    const landed = clips.find((c) => c.assetId === asset.id);
    landedClipId = landed?.id ?? null;
    // A landing can leave the reel shorter than it found it — a replace one stands a 5 s
    // render where ten seconds of stills were. The playhead comes with it rather than
    // being left out past the end, exactly as every other edit that shortens the track.
    const playheadMs = Math.min(s.playheadMs, timelineEndMs(clips, s.audioTracks));
    if (!replacesPair) {
      return {
        assets: { ...s.assets, [asset.id]: asset },
        clips,
        playheadMs,
        selection: landed ? { kind: 'clip', clipId: landed.id } : s.selection,
      };
    }

    // Only what the landing actually took off the track. A mixed pair keeps its video, and
    // cancelling a paid render over footage that is still standing would be a real loss.
    const after = s.clips.find((c) => c.id === target.afterClipId);
    const before = s.clips.find((c) => c.id === target.beforeClipId);
    const doomed = new Set(after && before ? consumedByReplace(after, before) : []);
    const generations = { ...s.generations };
    for (const [id, g] of Object.entries(generations)) {
      if (id === generation.id || g.target.kind !== 'cut' || !liveGeneration(g)) continue;
      if (
        doomed.has(g.target.afterClipId) ||
        doomed.has(g.target.beforeClipId) ||
        (g.target.replacesClipId !== undefined && doomed.has(g.target.replacesClipId))
      ) {
        generations[id] = { ...g, status: 'cancelled' };
        cancelledIds.push(id);
      }
    }
    return {
      assets: { ...s.assets, [asset.id]: asset },
      clips,
      playheadMs,
      selection: landed ? { kind: 'clip', clipId: landed.id } : s.selection,
      ...prunedAfterEdit(clips, generations, s.cutPrompts, s.cutModes),
    };
  });

  // An animate-run leg keeps hold of what it placed, so the run's collapse can tell a
  // landing that still stands from one the user deleted or split away.
  const legLanded = landedClipId;
  if (legLanded !== null) {
    set((s) => ({
      animateRun:
        s.animateRun && s.animateRun.legs.some((l) => l.generationId === generation.id)
          ? {
              legs: s.animateRun.legs.map((l) =>
                l.generationId === generation.id ? { ...l, landedClipId: legLanded } : l,
              ),
            }
          : s.animateRun,
    }));
  }

  // Stop paying for renders whose clips were just consumed — and if one of them was the
  // animate-all queue's in-flight submission, move the queue along past it.
  for (const id of cancelledIds) {
    void backend.cancelGeneration(id).catch(() => {});
    maybeAdvanceAnimateQueue(set, get, id);
  }

  if (landedClipId === null) {
    get().pushToast({
      tone: 'error',
      title:
        target.replacesClipId !== undefined
          ? 'Transition finished, but its clip was deleted'
          : 'Transition finished, but its clips moved',
      detail: 'Tap the ✦ on the new cut to regenerate.',
    });
    return;
  }
  get().pushToast({ tone: 'ok', title: 'Transition ready', detail: generation.prompt });

  // The model chose the real length; correct the provisional 5 s once the file's metadata
  // loads, rippling what follows along with it. A trim the user landed first wins, exactly
  // as with imports.
  const clipId: string = landedClipId;
  const epoch = documentEpoch;
  void probeVideoDurationMs(asset.src, DEFAULT_TRANSITION_DURATION_MS).then((durationMs) => {
    if (!stillCurrent(epoch)) return;
    set((s) => {
      const clip = s.clips.find((c) => c.id === clipId);
      const untouched =
        clip && clip.durationMs === DEFAULT_TRANSITION_DURATION_MS && clip.trimStartMs === 0;
      return {
        assets: s.assets[asset.id]
          ? { ...s.assets, [asset.id]: { ...s.assets[asset.id], durationMs } }
          : s.assets,
        clips: untouched ? setTransitionDuration(s.clips, clipId, durationMs) : s.clips,
      };
    });
  });
}

/**
 * Move the animate-all queue along once its in-flight submission is resolved — accepted
 * (has a `jobId`), finished, or dead. Any other generation's update is not the queue's
 * business.
 */
function maybeAdvanceAnimateQueue(set: Setter, get: () => EditorState, generationId: string): void {
  const s = get();
  if (s.animateSubmittingId !== generationId) return;
  const generation = s.generations[generationId];
  const submitted = Boolean(generation?.jobId);
  const gone = !generation || !liveGeneration(generation);
  if (!submitted && !gone) return;
  set({ animateSubmittingId: null });
  get().advanceAnimateQueue();
}

/**
 * The end of an "Animate all" run: once its queue has fully drained and every leg is
 * terminal, the photos whose every touching leg has motion standing in for them leave the
 * track — spans closing behind them — and each standing landing is stamped `replace`, so
 * the chain ends exactly where a single default cut does: pure motion, photos in the bin.
 * Cheap and idempotent, so it is called after every event that could be the run's last.
 *
 * A leg is terminal when its record reached `succeeded`, `failed` or `cancelled` — or when
 * the record is gone entirely (swept by `removeAsset`, dismissed, or pruned): nothing will
 * ever arrive for it again. The queue check is load-bearing: the queue lingers as `[]`
 * between the last launch and the next advance, so "empty" is not "drained" — without it,
 * an early cancel could collapse a half-built run.
 */
function maybeCollapseAnimateRun(set: Setter, get: () => EditorState): void {
  const s = get();
  if (!s.animateRun || s.animateQueue !== null) return;
  const legs = s.animateRun.legs;
  const record = (leg: AnimateLeg) => s.generations[leg.generationId];
  if (legs.some((leg) => record(leg) !== undefined && liveGeneration(record(leg)!))) return;

  if (legs.length === 0) {
    // Every cut was skipped before a single launch: nothing ran, nothing to say.
    set({ animateRun: null });
    return;
  }

  const clipById = new Map(s.clips.map((c) => [c.id, c]));
  // A leg whose motion genuinely stands in for its photos: it succeeded, its landing was
  // placed, and that clip is still on the track wearing `transition` — a delete or a split
  // dropped the motion, so the stills it covered must stay.
  const standing = (leg: AnimateLeg): boolean =>
    record(leg)?.status === 'succeeded' &&
    leg.landedClipId !== undefined &&
    Boolean(clipById.get(leg.landedClipId)?.transition);

  const legsByPhoto = new Map<string, AnimateLeg[]>();
  for (const leg of legs) {
    for (const id of [leg.afterClipId, leg.beforeClipId]) {
      legsByPhoto.set(id, [...(legsByPhoto.get(id) ?? []), leg]);
    }
  }
  // A photo leaves only when every leg touching it stands — and only when it is still on
  // the track itself: one consumed mid-run by an explicit replace landing is simply
  // absent, a no-op here.
  const doomed = new Set(
    [...legsByPhoto]
      .filter(([id, touching]) => clipById.has(id) && touching.every(standing))
      .map(([id]) => id),
  );
  const stamped = new Set(
    legs.flatMap((leg) => (standing(leg) && leg.landedClipId !== undefined ? [leg.landedClipId] : [])),
  );

  set((state) => {
    const clips = removeClipsClosingSpans(
      state.clips.map((c) =>
        c.transition && stamped.has(c.id)
          ? { ...c, transition: { ...c.transition, mode: 'replace' as const } }
          : c,
      ),
      [...doomed],
    );
    const selectionDoomed =
      state.selection.kind === 'clip'
        ? doomed.has(state.selection.clipId)
        : state.selection.kind === 'cut'
          ? doomed.has(state.selection.afterClipId) || doomed.has(state.selection.beforeClipId)
          : false;
    return {
      clips,
      animateRun: null,
      selection: selectionDoomed ? { kind: 'none' } : state.selection,
      playheadMs: Math.min(state.playheadMs, timelineEndMs(clips, state.audioTracks)),
      ...prunedAfterEdit(clips, state.generations, state.cutPrompts, state.cutModes),
    };
  });

  const landed = stamped.size;
  if (landed === legs.length) {
    get().pushToast({
      tone: 'ok',
      title: `${landed} transition${landed === 1 ? '' : 's'} — pure motion`,
      detail: 'The photos left the track; they stay in the media bin.',
    });
  } else if (landed > 0) {
    get().pushToast({
      tone: 'ok',
      title: `${landed} of ${legs.length} transitions in`,
      detail: 'The photos stay where a transition did not land.',
    });
  } else {
    get().pushToast({
      tone: 'error',
      title: 'No transitions landed',
      detail: 'The photos stay on the track.',
    });
  }
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/**
 * Shape expected by `solcut_render::ExportSpec`.
 *
 * The frame comes from the project's own ratio rather than a constant. Everything inside it
 * is unchanged by that: a photo still fills the frame and is cropped to it, a video still
 * fits inside it and is letterboxed — see `photo_filter`/`video_filter` on the Rust side —
 * so turning the frame on its side never silently throws footage away.
 */
export function buildExportSpec(
  clips: Clip[],
  assets: Record<string, MediaAsset>,
  audioTracks: AudioTrack[] = [],
  aspectRatio: string = DEFAULT_ASPECT_RATIO,
) {
  const frame = frameSize(aspectRatio);
  return {
    width: frame.width,
    height: frame.height,
    fps: 30,
    // Muted lanes stay out of the spec entirely — the exporter never needs to know.
    audio: audioTracks
      .filter((t) => !t.muted)
      .map((t) => ({
        path: assets[t.assetId]?.path ?? '',
        startMs: t.startMs,
        trimStartMs: t.trimStartMs,
        durationMs: t.durationMs,
        volume: t.volume,
      })),
    clips: sortClips(clips).map((clip) => {
      const asset = assets[clip.assetId];
      const common = { name: clip.name, startMs: clip.startMs, durationMs: clip.durationMs };
      if (clip.kind === 'photo') {
        return { ...common, kind: 'photo', path: asset?.path ?? '' };
      }
      return { ...common, kind: 'video', path: asset?.path ?? '', trimStartMs: clip.trimStartMs };
    }),
  };
}
