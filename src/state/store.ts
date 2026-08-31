/**
 * Editor state.
 *
 * Deliberately one flat store: the timeline is a single track, and nearly every action
 * touches both the clip list and the selection, so splitting it up would mostly create
 * synchronisation work. Anything that is pure arithmetic lives in `lib/timeline`.
 */

import { create } from 'zustand';
import * as backend from '../lib/backend';
import { probeAudioDurationMs, probeVideoDurationMs, renderPhotoJpeg } from '../lib/frames';
import {
  AUDIO_EXTS,
  DEFAULT_AUDIO_DURATION_MS,
  DEFAULT_PHOTO_DURATION_MS,
  DEFAULT_TRANSITION_DURATION_MS,
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
  audioTrack,
  canSplitAt,
  clipAt,
  insertClips,
  insertIndexAtTime,
  insertTransitionClip,
  makeId,
  moveAudio,
  photoClip,
  photoCuts,
  placeClip,
  replacePairWithTransition,
  replaceTransitionClip,
  resizeAudio,
  resizeClipInList,
  setTransitionDuration,
  sortClips,
  timelineEndMs,
  trackEndMs,
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

  generations: Record<string, Generation>;
  /**
   * The model the next render uses — a `RenderModel` id, or `custom` for the model id
   * Settings stores. Chosen at any render entry point and sent with every request; never
   * persisted, so a fresh session is back on the default (MiniMax Hailuo-02 Standard).
   */
  modelId: string;
  /** The three-photo film currently being made, if there is one. */
  film: Film | null;
  /** The wizard panel. It outlives the film it starts, and the film outlives it. */
  filmWizardOpen: boolean;
  /** Prompts typed for cuts that have not generated yet, keyed `${afterClipId}:${beforeClipId}`. */
  cutPrompts: Record<string, string>;
  /** Insert/replace picked per cut, keyed like `cutPrompts`. A cut with no entry inserts. */
  cutModes: Record<string, TransitionMode>;
  /** Cuts still waiting their turn in an "Animate all" run. `null` when no run is active. */
  animateQueue: Cut[] | null;
  /** The queue's generation whose submission has not been accepted (no `jobId`) yet. */
  animateSubmittingId: string | null;
  importing: number;
  importProblems: ImportProblem[];

  settings: backend.SettingsView | null;
  settingsOpen: boolean;
  /**
   * The last thing a connection or key check said. `title` overrides the box's heading —
   * the API key check reports its own, because "Could not connect" is the wrong words for
   * a key on a machine whose CLI is fine.
   */
  connectionMessage: { ok: boolean; text: string; title?: string } | null;

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

  // ---- audio tracks
  moveAudioTrack: (trackId: string, startMs: number) => void;
  resizeAudioTrack: (trackId: string, edge: ClipEdge, deltaMs: number) => void;
  setAudioVolume: (trackId: string, volume: number) => void;
  toggleAudioMute: (trackId: string) => void;

  // ---- selection & editing
  select: (selection: Selection) => void;
  deleteSelection: () => void;
  splitAtPlayhead: () => void;
  moveClipTo: (clipId: string, startMs: number) => void;
  resizeClip: (clipId: string, edge: ClipEdge, deltaMs: number) => void;
  toggleSnapping: () => void;

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
  pxPerSecond: 46,
  snapping: true,

  generations: {},
  modelId: backend.DEFAULT_MODEL_ID,
  film: null,
  filmWizardOpen: false,
  cutPrompts: {},
  cutModes: {},
  animateQueue: null,
  animateSubmittingId: null,
  importing: 0,
  importProblems: [],

  settings: null,
  settingsOpen: false,
  connectionMessage: null,

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

    commitImport(set, accepted, problems, index);
    await probeDurations(set, accepted);
  },

  async addPaths(paths, index, audioStartMs) {
    if (paths.length === 0) return;
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
      commitImport(set, accepted, result.rejected, index);
      await probeDurations(set, accepted);
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
    // Film legs animate between photos, not clips, so no clip on the track speaks for them.
    const generationDoomed = (g: Generation) =>
      g.target.kind === 'film'
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

    // A browser drop owns an object URL, and this was the last reference to it.
    if (asset.src.startsWith('blob:')) URL.revokeObjectURL(asset.src);
  },

  dismissImportProblems: () => set({ importProblems: [] }),

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

  toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),

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
    const { selection } = get();
    if (selection.kind !== 'cut') return;
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
    if (!s.settings?.configured) return null;
    if (!cutEligible(s, afterClipId, beforeClipId)) return null;

    const clipA = s.clips.find((c) => c.id === afterClipId);
    const clipB = s.clips.find((c) => c.id === beforeClipId);
    if (!clipA || !clipB) return null;
    const prompt =
      (s.cutPrompts[cutKey(afterClipId, beforeClipId)] ?? '').trim() || DEFAULT_TRANSITION_PROMPT;
    const from: TransitionSource = { clipId: clipA.id, assetId: clipA.assetId };
    const to: TransitionSource = { clipId: clipB.id, assetId: clipB.assetId };
    const target: GenerationTarget = {
      kind: 'cut',
      afterClipId,
      beforeClipId,
      from,
      to,
      mode: mode ?? s.cutModes[cutKey(afterClipId, beforeClipId)] ?? 'insert',
    };
    return launchGeneration(set, get, target, prompt, {
      fromSrc: s.assets[clipA.assetId].src,
      toSrc: s.assets[clipB.assetId].src,
    });
  },

  /**
   * Re-render an existing transition. An insert-mode clip renders from whatever photos
   * stand around it NOW — that is what makes stale → Regenerate correct after a reorder or
   * a replacement — and has nothing to do when orphaned: there are no longer two photos to
   * span. A replace-mode clip consumed its photos, so it renders from its recorded source
   * *assets*, still in the media bin; only a missing asset stops it.
   */
  regenerateTransition(clipId) {
    const s = get();
    if (!s.settings?.configured) return;
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
      const assetA = s.assets[from.assetId];
      const assetB = s.assets[to.assetId];
      if (!assetA || !assetB || assetA.missing || assetB.missing) return;
      const prompt = clip.transition.prompt.trim() || DEFAULT_TRANSITION_PROMPT;
      // The pair's clip ids are long gone; the landing only reads `replacesClipId`.
      const target: GenerationTarget = {
        kind: 'cut',
        afterClipId: from.clipId,
        beforeClipId: to.clipId,
        from,
        to,
        replacesClipId: clipId,
        mode: 'replace',
      };
      launchGeneration(set, get, target, prompt, {
        fromSrc: assetA.src,
        toSrc: assetB.src,
      });
      return;
    }

    const left = placedClips[at - 1];
    const right = placedClips[at + 1];
    if (!left || !right || left.kind !== 'photo' || right.kind !== 'photo') return;
    const assetA = s.assets[left.assetId];
    const assetB = s.assets[right.assetId];
    if (!assetA || !assetB || assetA.missing || assetB.missing) return;

    const prompt = clip.transition.prompt.trim() || DEFAULT_TRANSITION_PROMPT;
    const from: TransitionSource = { clipId: left.id, assetId: left.assetId };
    const to: TransitionSource = { clipId: right.id, assetId: right.assetId };
    const target: GenerationTarget = {
      kind: 'cut',
      afterClipId: left.id,
      beforeClipId: right.id,
      from,
      to,
      replacesClipId: clipId,
    };
    launchGeneration(set, get, target, prompt, {
      fromSrc: assetA.src,
      toSrc: assetB.src,
    });
  },

  /** Resubmit a failed generation from its own target — never from whatever is selected. */
  retryGeneration(generationId) {
    const generation = get().generations[generationId];
    if (!generation || generation.status !== 'failed') return;
    get().dismissGeneration(generationId);

    const target = generation.target;
    if (target.kind === 'film') {
      // A film leg is retried from the film panel, which is where its state is shown.
      void get().retryFilmSegment(target.filmSegmentIndex);
    } else if (target.replacesClipId !== undefined) {
      get().regenerateTransition(target.replacesClipId);
    } else {
      get().startCutGeneration(target.afterClipId, target.beforeClipId);
    }
  },

  animateAll() {
    const s = get();
    if (!s.settings?.configured) return;
    const eligible = photoCuts(s.clips).filter((cut) =>
      cutEligible(s, cut.afterClipId, cut.beforeClipId),
    );
    if (eligible.length === 0) return;
    set({ animateQueue: eligible });
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
        set({ animateQueue: rest, animateSubmittingId: id });
        return;
      }
    }
    set({ animateQueue: null, animateSubmittingId: null });
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
        void probeFilmSegmentDuration(set, next.target.filmSegmentIndex, update.outputPath).then(
          () => assembleFilmOnTimeline(set, get),
        );
      } else {
        landCutResult(set, get, next, next.target, update.outputPath);
      }
    }

    maybeAdvanceAnimateQueue(set, get, update.generationId);
  },

  async cancelGeneration(id) {
    await backend.cancelGeneration(id);
    const existing = get().generations[id];
    if (existing) writeGeneration(set, { ...existing, status: 'cancelled' });
    maybeAdvanceAnimateQueue(set, get, id);
  },

  dismissGeneration(id) {
    set((s) => {
      const generations = { ...s.generations };
      delete generations[id];
      return { generations };
    });
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
    const { assets, settings, pushToast } = get();

    if (!settings?.configured) {
      pushToast({
        tone: 'error',
        title: 'Connect Higgsfield first',
        detail: 'A film is made of Higgsfield transitions — there is nothing to render it with yet.',
      });
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
    const { clips, audioTracks, assets, pushToast, exporting } = get();
    if (clips.length === 0) return;
    // One render at a time. The dialog can be dismissed while ffmpeg runs, so `exportState`
    // is no evidence either way — without this a second click starts a second save dialog
    // and a second encode of the same timeline.
    if (exporting) return;

    const offline =
      clips.find((c) => !assets[c.assetId]?.path) ??
      audioTracks.find((t) => !t.muted && !assets[t.assetId]?.path);
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
      const written = await backend.exportTimeline(buildExportSpec(clips, assets, audioTracks), outPath);
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

/** One accepted import: a clip bound for the visual track, or a sound bound for a lane. */
type Imported = { asset: MediaAsset; clip?: Clip; track?: AudioTrack };

function placed(asset: MediaAsset, audioStartMs: number): Imported {
  if (asset.kind === 'audio') {
    return { asset, track: audioTrack(asset, audioStartMs, DEFAULT_AUDIO_DURATION_MS) };
  }
  return {
    asset,
    clip:
      asset.kind === 'photo'
        ? photoClip(asset, DEFAULT_PHOTO_DURATION_MS)
        : videoClip(asset, DEFAULT_VIDEO_DURATION_MS),
  };
}

/**
 * Clips appear at their default length straight away and correct themselves once the real
 * duration is known — an import that blocks on decoding feels broken.
 */
function commitImport(set: Setter, accepted: Imported[], problems: ImportProblem[], index?: number) {
  if (accepted.length === 0 && problems.length === 0) return;

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
      importProblems: [...s.importProblems, ...problems],
      selection: first?.clip
        ? { kind: 'clip', clipId: first.clip.id }
        : first?.track
          ? { kind: 'audio', trackId: first.track.id }
          : s.selection,
    };
  });
}

async function probeDurations(set: Setter, accepted: Imported[]) {
  await Promise.all(
    accepted.map(async ({ asset, clip, track }) => {
      if (asset.kind === 'photo') return;
      const durationMs =
        asset.kind === 'video'
          ? await probeVideoDurationMs(asset.src, DEFAULT_VIDEO_DURATION_MS)
          : await probeAudioDurationMs(asset.src, DEFAULT_AUDIO_DURATION_MS);
      set((s) => ({
        // The asset keeps the source length for good: it is what bounds a later trim.
        assets: s.assets[asset.id]
          ? { ...s.assets, [asset.id]: { ...s.assets[asset.id], durationMs } }
          : s.assets,
        clips: s.clips.map((c) =>
          // A trim that landed while the probe was in flight is the user's, not ours.
          c.id === clip?.id && c.durationMs === DEFAULT_VIDEO_DURATION_MS && c.trimStartMs === 0
            ? { ...c, durationMs }
            : c,
        ),
        audioTracks: s.audioTracks.map((t) =>
          t.id === track?.id && t.durationMs === DEFAULT_AUDIO_DURATION_MS && t.trimStartMs === 0
            ? { ...t, durationMs }
            : t,
        ),
      }));
    }),
  );
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

function liveGeneration(g: Generation): boolean {
  return g.status === 'queued' || g.status === 'running';
}

/**
 * Whether this cut could start a generation right now: the pair still forms a photo→photo
 * cut (side by side, touching or across a gap), both sources on hand, and no job already
 * running for it. Settings are checked separately — an unconfigured app changes what the
 * UI says, not what a cut is.
 */
export function cutEligible(
  s: Pick<EditorState, 'clips' | 'assets' | 'generations'>,
  afterClipId: string,
  beforeClipId: string,
): boolean {
  const cut = photoCuts(s.clips).find(
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

/** The cuts "✦ Animate all" would fill right now. */
export function animatableCuts(s: Pick<EditorState, 'clips' | 'assets' | 'generations'>): Cut[] {
  return photoCuts(s.clips).filter((cut) => cutEligible(s, cut.afterClipId, cut.beforeClipId));
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
  const cuts = new Set(photoCuts(clips).map((c) => cutKey(c.afterClipId, c.beforeClipId)));

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
    {
      fromSrc: start.src,
      toSrc: end.src,
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
  index: number,
  outputPath: string,
): Promise<void> {
  const durationMs = await probeVideoDurationMs(
    backend.assetSrc(outputPath),
    FILM_SEGMENT_DURATION_MS,
  );
  set((s) => {
    // Retried while the probe was in flight: that run's file owns the leg's length now.
    if (!s.film || s.film.segments.find((x) => x.index === index)?.outputPath !== outputPath) {
      return s;
    }
    return { film: patchFilmSegment(s.film, index, { durationMs }) };
  });
}

/**
 * Record a generation and submit it: render both frames, hand them to the backend. The
 * record lands synchronously (so callers get an id to track); the submission runs behind
 * it, and a failure to even start — which emits no backend event — marks the record failed
 * and nudges the animate-all queue so it cannot stall on the silence.
 */
function launchGeneration(
  set: Setter,
  get: () => EditorState,
  target: GenerationTarget,
  prompt: string,
  frames: { fromSrc: string; toSrc: string },
  /**
   * Runs before the record is written, with the id it is about to get. A film leg uses it
   * to claim the id, so the leg recognises this run's updates and not the one it replaced.
   */
  claim?: (generationId: string) => void,
): string {
  const generationId = makeId('gen');
  claim?.(generationId);
  // The choice is read at launch, so a render carries the model that was showing when its
  // button was pressed — switching the selector afterwards changes the next render only.
  const { modelId, settings } = get();
  const model = backend.modelJob(modelId, settings?.customModel);
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
      const startFrame = await renderPhotoJpeg(frames.fromSrc);
      const endFrame = await renderPhotoJpeg(frames.toSrc);
      await backend.generateAnimation({ generationId, prompt, startFrame, endFrame, model });
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
    }
  })();

  return generationId;
}

/**
 * A finished cut render: insert the transition at its cut, stand it in the place of its
 * two photos (replace mode), or — for a regeneration — swap it over the existing
 * transition clip. The timeline may have been edited mid-render, so the landing is
 * guarded: if the place is gone the clip is never put somewhere wrong, the MP4 stays in
 * the cache, and a toast says what to do instead.
 *
 * A replace landing consumes the pair, which is an edit like any other: prompts, mode
 * picks and failed records for cuts the photos took with them are pruned, and a live
 * render whose own clips were just consumed is cancelled — nothing is left to land it on.
 */
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
    if (!replacesPair) {
      return {
        assets: { ...s.assets, [asset.id]: asset },
        clips,
        selection: landed ? { kind: 'clip', clipId: landed.id } : s.selection,
      };
    }

    const doomed = new Set([target.afterClipId, target.beforeClipId]);
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
      selection: landed ? { kind: 'clip', clipId: landed.id } : s.selection,
      ...prunedAfterEdit(clips, generations, s.cutPrompts, s.cutModes),
    };
  });

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
          : 'Transition finished, but its photos moved',
      detail: 'Tap the ✦ on the new cut to regenerate.',
    });
    return;
  }
  get().pushToast({ tone: 'ok', title: 'Transition ready', detail: generation.prompt });

  // The model chose the real length; correct the provisional 5 s once the file's metadata
  // loads, rippling what follows along with it. A trim the user landed first wins, exactly
  // as with imports.
  const clipId: string = landedClipId;
  void probeVideoDurationMs(asset.src, DEFAULT_TRANSITION_DURATION_MS).then((durationMs) => {
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

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/** Shape expected by `solcut_render::ExportSpec`. */
export function buildExportSpec(
  clips: Clip[],
  assets: Record<string, MediaAsset>,
  audioTracks: AudioTrack[] = [],
) {
  return {
    width: 1920,
    height: 1080,
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
