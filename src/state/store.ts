/**
 * Editor state.
 *
 * Deliberately one flat store: the timeline is a single track, and nearly every action
 * touches both the clip list and the selection, so splitting it up would mostly create
 * synchronisation work. Anything that is pure arithmetic lives in `lib/timeline`.
 */

import { create } from 'zustand';
import * as backend from '../lib/backend';
import { probeVideoDurationMs, renderKeyframeJpeg } from '../lib/frames';
import {
  DEFAULT_PHOTO_DURATION_MS,
  DEFAULT_VIDEO_DURATION_MS,
  IDENTITY_TRANSFORM,
  type Clip,
  type ClipEdge,
  type FilmGeneration,
  type Generation,
  type GenerationError,
  type MediaAsset,
  type MediaKind,
  type Segment,
  type SegmentGeneration,
  type Selection,
  type Transform2D,
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
  markFilmSegmentFailed,
  markFilmSegmentQueued,
  patchFilmSegment,
  setFilmPrompt,
  type Film,
} from '../lib/film';
import {
  addKeyframe,
  clipAt,
  findSegment,
  insertClips,
  makeId,
  moveClip as moveClipInList,
  moveKeyframe,
  photoClip,
  removeKeyframe,
  replaceSegment,
  resizeClip as resizeClipEdge,
  segmentsOf,
  setPrompt,
  totalDurationMs,
  transformAt,
  updateKeyframe,
  videoClip,
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
}

const PHOTO_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'avif'];
const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'm4v', 'mkv', 'avi'];

export function kindOf(name: string, mime = ''): MediaKind | null {
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (PHOTO_EXTS.includes(ext)) return 'photo';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  return null;
}

export interface EditorState {
  assets: Record<string, MediaAsset>;
  clips: Clip[];
  selection: Selection;
  playheadMs: number;
  playing: boolean;
  pxPerSecond: number;

  generations: Record<string, Generation>;
  /** The three-photo film currently being made, if there is one. */
  film: Film | null;
  importing: number;
  importProblems: ImportProblem[];

  settings: backend.SettingsView | null;
  settingsOpen: boolean;
  connectionMessage: { ok: boolean; text: string } | null;

  exportState: ExportState | null;
  ffmpegAvailable: boolean | null;
  toasts: Toast[];

  // ---- media
  addFiles: (files: File[], index?: number) => Promise<void>;
  addPaths: (paths: string[], index?: number) => Promise<void>;
  importViaDialog: () => Promise<void>;
  removeAsset: (assetId: string) => void;
  dismissImportProblems: () => void;

  // ---- selection & editing
  select: (selection: Selection) => void;
  addKeyframeAtPlayhead: () => void;
  updateSelectedKeyframe: (patch: Partial<Transform2D>) => void;
  moveSelectedKeyframe: (timeMs: number) => void;
  deleteSelection: () => void;
  setSegmentPrompt: (prompt: string) => void;
  splitAtPlayhead: () => void;
  moveClip: (clipId: string, toIndex: number) => void;
  resizeClip: (clipId: string, edge: ClipEdge, deltaMs: number) => void;

  // ---- playback
  setPlayhead: (ms: number) => void;
  togglePlay: () => void;
  advance: (deltaMs: number) => void;

  // ---- generation
  startGeneration: () => Promise<void>;
  applyGenerationUpdate: (update: backend.GenerationUpdate) => void;
  cancelGeneration: (id: string) => Promise<void>;
  dismissGeneration: (id: string) => void;

  // ---- film (three photos, two AI transitions)
  startFilm: (assetIds: string[], prompts?: string[]) => Promise<void>;
  setFilmSegmentPrompt: (index: number, prompt: string) => void;
  retryFilmSegment: (index: number) => Promise<void>;
  cancelFilm: () => Promise<void>;
  placeFilmOnTimeline: (index?: number) => void;
  dismissFilm: () => void;

  // ---- settings, export, chrome
  loadSettings: () => Promise<void>;
  openSettings: () => void;
  closeSettings: () => void;
  saveSettings: (input: backend.SettingsInput) => Promise<void>;
  testConnection: () => Promise<void>;
  runExport: () => Promise<void>;
  setExportProgress: (stage: string, fraction: number) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
}

export const useEditor = create<EditorState>((set, get) => ({
  assets: {},
  clips: [],
  selection: { kind: 'none' },
  playheadMs: 0,
  playing: false,
  pxPerSecond: 46,

  generations: {},
  film: null,
  importing: 0,
  importProblems: [],

  settings: null,
  settingsOpen: false,
  connectionMessage: null,

  exportState: null,
  ffmpegAvailable: null,
  toasts: [],

  // ------------------------------------------------------------------ media

  async addFiles(files, index) {
    const accepted: { asset: MediaAsset; clip: Clip }[] = [];
    const problems: ImportProblem[] = [];

    for (const file of files) {
      const kind = kindOf(file.name, file.type);
      if (!kind) {
        problems.push({
          name: file.name,
          reason: `unsupported format. Supported: ${[...PHOTO_EXTS, ...VIDEO_EXTS].join(', ')}`,
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
      accepted.push({ asset, clip: newClip(asset) });
    }

    commitImport(set, get, accepted, problems, index);
    await probeDurations(set, accepted);
  },

  async addPaths(paths, index) {
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
        return { asset, clip: newClip(asset) };
      });
      commitImport(set, get, accepted, result.rejected, index);
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

  /**
   * Take an imported asset back out of the bin. Its clips go with it — a clip whose media
   * is gone would only render as "media offline" and block export.
   */
  removeAsset(assetId) {
    const { assets, clips, selection, generations, playheadMs, playing } = get();
    const asset = assets[assetId];
    if (!asset) return;

    const doomed = new Set(clips.filter((c) => c.assetId === assetId).map((c) => c.id));
    const nextAssets = { ...assets };
    delete nextAssets[assetId];
    const nextClips = clips.filter((c) => !doomed.has(c.id));
    const total = totalDurationMs(nextClips);

    set({
      assets: nextAssets,
      clips: nextClips,
      generations: Object.fromEntries(
        // Film legs animate between photos, not clips, so nothing on the track speaks for them.
        Object.entries(generations).filter(([, g]) => !(g.kind === 'segment' && doomed.has(g.clipId))),
      ),
      selection:
        selection.kind !== 'none' && doomed.has(selection.clipId) ? { kind: 'none' } : selection,
      playheadMs: Math.min(playheadMs, total),
      playing: total === 0 ? false : playing,
    });

    // Nothing is left to put the result on, so stop paying for the render.
    for (const generation of Object.values(generations)) {
      if (generation.kind !== 'segment' || !doomed.has(generation.clipId)) continue;
      if (generation.status !== 'queued' && generation.status !== 'running') continue;
      void backend.cancelGeneration(generation.id).catch(() => {});
    }

    // A browser drop owns an object URL, and this was the last reference to it.
    if (asset.src.startsWith('blob:')) URL.revokeObjectURL(asset.src);
  },

  dismissImportProblems: () => set({ importProblems: [] }),

  // ------------------------------------------------------------------ editing

  select: (selection) => set({ selection }),

  addKeyframeAtPlayhead() {
    const { clips, playheadMs, selection } = get();
    const target = selectedClipId(selection) ?? clipAt(clips, playheadMs)?.placed.clip.id;
    if (!target) return;

    const placed = clips.find((c) => c.id === target);
    if (!placed || placed.kind !== 'photo') return;

    const start = startOf(clips, target);
    const localMs = Math.min(Math.max(playheadMs - start, 0), placed.durationMs);
    const updated = addKeyframe(placed, localMs);
    const added =
      updated.keyframes.find((k) => Math.abs(k.timeMs - Math.round(localMs)) < 1) ??
      updated.keyframes[0];

    set({
      clips: clips.map((c) => (c.id === target ? updated : c)),
      selection: { kind: 'keyframe', clipId: target, keyframeId: added.id },
    });
  },

  updateSelectedKeyframe(patch) {
    const { selection, clips } = get();
    if (selection.kind !== 'keyframe') return;
    set({
      clips: clips.map((c) =>
        c.id === selection.clipId ? updateKeyframe(c, selection.keyframeId, patch) : c,
      ),
    });
  },

  moveSelectedKeyframe(timeMs) {
    const { selection, clips } = get();
    if (selection.kind !== 'keyframe') return;
    set({
      clips: clips.map((c) =>
        c.id === selection.clipId ? moveKeyframe(c, selection.keyframeId, timeMs) : c,
      ),
    });
  },

  deleteSelection() {
    const { selection, clips } = get();
    if (selection.kind === 'keyframe') {
      set({
        clips: clips.map((c) =>
          c.id === selection.clipId ? removeKeyframe(c, selection.keyframeId) : c,
        ),
        selection: { kind: 'clip', clipId: selection.clipId },
      });
      return;
    }
    if (selection.kind === 'clip') {
      set({ clips: clips.filter((c) => c.id !== selection.clipId), selection: { kind: 'none' } });
    }
  },

  setSegmentPrompt(prompt) {
    const { selection, clips } = get();
    if (selection.kind !== 'segment') return;
    set({
      clips: clips.map((c) =>
        c.id === selection.clipId ? setPrompt(c, selection.fromKeyframeId, prompt) : c,
      ),
    });
  },

  splitAtPlayhead() {
    const { clips, playheadMs } = get();
    const hit = clipAt(clips, playheadMs);
    if (!hit || hit.localMs <= 0 || hit.localMs >= hit.placed.clip.durationMs) return;

    const clip = hit.placed.clip;
    const head: Clip = {
      ...clip,
      id: makeId('clip'),
      durationMs: hit.localMs,
      keyframes: clip.keyframes.filter((k) => k.timeMs < hit.localMs),
    };
    const tail: Clip = {
      ...clip,
      id: makeId('clip'),
      durationMs: clip.durationMs - hit.localMs,
      trimStartMs: clip.trimStartMs + (clip.kind === 'video' ? hit.localMs : 0),
      keyframes: clip.keyframes
        .filter((k) => k.timeMs >= hit.localMs)
        .map((k) => ({ ...k, timeMs: k.timeMs - hit.localMs })),
    };
    const index = clips.findIndex((c) => c.id === clip.id);
    set({
      clips: [...clips.slice(0, index), head, tail, ...clips.slice(index + 1)],
      selection: { kind: 'clip', clipId: tail.id },
    });
  },

  /** Drag along the track: `toIndex` counts positions among the clips it leaves behind. */
  moveClip(clipId, toIndex) {
    const { clips } = get();
    const next = moveClipInList(clips, clipId, toIndex);
    if (next === clips) return;
    set({ clips: next, selection: { kind: 'clip', clipId } });
  },

  /** Drag an edge: `deltaMs` is how far it moved to the right, whichever edge it is. */
  resizeClip(clipId, edge, deltaMs) {
    const { clips, assets, playheadMs } = get();
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;

    const resized = resizeClipEdge(clip, edge, deltaMs, assets[clip.assetId]?.durationMs);
    if (resized === clip) return;

    const next = clips.map((c) => (c.id === clipId ? resized : c));
    set({
      clips: next,
      // The track just got shorter under the playhead, or it did not — either way it stays on it.
      playheadMs: Math.min(playheadMs, totalDurationMs(next)),
    });
  },

  // ------------------------------------------------------------------ playback

  setPlayhead(ms) {
    const total = totalDurationMs(get().clips);
    set({ playheadMs: Math.min(Math.max(0, Math.round(ms)), total) });
  },

  togglePlay() {
    const { playing, playheadMs, clips } = get();
    const total = totalDurationMs(clips);
    if (total === 0) return;
    // Pressing play at the very end restarts rather than doing nothing.
    set({ playing: !playing, playheadMs: !playing && playheadMs >= total ? 0 : playheadMs });
  },

  advance(deltaMs) {
    const { playheadMs, clips, playing } = get();
    if (!playing) return;
    const total = totalDurationMs(clips);
    const next = playheadMs + deltaMs;
    if (next >= total) {
      set({ playheadMs: total, playing: false });
    } else {
      set({ playheadMs: next });
    }
  },

  // ------------------------------------------------------------------ generation

  async startGeneration() {
    const { selection, clips, assets } = get();
    if (selection.kind !== 'segment') return;

    const clip = clips.find((c) => c.id === selection.clipId);
    if (!clip) return;
    const segment = findSegment(clip, selection.fromKeyframeId, selection.toKeyframeId);
    if (!segment) return;

    const prompt = (clip.prompts[selection.fromKeyframeId] ?? '').trim();
    if (!prompt) return;

    const asset = assets[clip.assetId];
    if (!asset) return;

    const generation: SegmentGeneration = {
      kind: 'segment',
      id: makeId('gen'),
      clipId: clip.id,
      fromKeyframeId: selection.fromKeyframeId,
      toKeyframeId: selection.toKeyframeId,
      prompt,
      status: 'queued',
      progress: 0,
      elapsedSecs: 0,
      slow: false,
    };

    await launchGeneration(set, get, generation, () => segmentFrames(clip, segment, asset.src));
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
    putGeneration(set, next);

    if (update.status !== 'succeeded' || !update.outputPath) return;

    // A film leg is parked, not placed. The film goes onto the track in one piece once every
    // leg is in, so a leg landing early cannot leave half a film in the project.
    if (next.kind === 'film') {
      void probeFilmSegmentDuration(set, next.filmSegmentIndex, update.outputPath);
      return;
    }

    // The clip is on the timeline; put the rendered video where the segment was.
    const source = get().clips.find((c) => c.id === next.clipId);
    const asset: MediaAsset = {
      id: makeId('asset'),
      name: `ai-${update.generationId}.mp4`,
      kind: 'video',
      path: update.outputPath,
      src: backend.assetSrc(update.outputPath),
      sizeBytes: 0,
      // Higgsfield rendered exactly the segment it was given, so that is the whole file.
      durationMs: source
        ? findSegment(source, next.fromKeyframeId, next.toKeyframeId)?.durationMs
        : undefined,
    };

    set((s) => {
      const clips = replaceSegment(s.clips, next.clipId, next.fromKeyframeId, next.toKeyframeId, {
        assetId: asset.id,
        name: asset.name,
        prompt: next.prompt,
      });
      const generated = clips.find((c) => c.assetId === asset.id);
      return {
        assets: { ...s.assets, [asset.id]: asset },
        clips,
        selection: generated ? { kind: 'clip', clipId: generated.id } : s.selection,
      };
    });
    get().pushToast({ tone: 'ok', title: 'Animation ready', detail: next.prompt });
  },

  async cancelGeneration(id) {
    await backend.cancelGeneration(id);
    const existing = get().generations[id];
    if (existing) putGeneration(set, { ...existing, status: 'cancelled' });
  },

  dismissGeneration(id) {
    set((s) => {
      const generations = { ...s.generations };
      delete generations[id];
      return { generations };
    });
  },

  // ------------------------------------------------------------------ film

  /**
   * Three photos in, one film out: two Higgsfield transitions run side by side.
   *
   * Nothing is sent — and no film is created — without a credential. There is no local
   * renderer to fall back to, so a film with no Higgsfield behind it is refused where the
   * user asked for it rather than two legs later.
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
    await Promise.all(film.segments.map((segment) => launchFilmSegment(set, get, segment.index)));
  },

  setFilmSegmentPrompt(index, prompt) {
    set((s) => (s.film ? { film: setFilmPrompt(s.film, index, prompt) } : s));
  },

  /** Run one leg again. Whatever already rendered stays rendered — and stays paid for. */
  async retryFilmSegment(index) {
    const segment = get().film?.segments.find((s) => s.index === index);
    if (!segment || segment.status === 'queued' || segment.status === 'running') return;
    await launchFilmSegment(set, get, index);
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
   * The finished film onto the track, in one piece and in segment order — whichever leg
   * happened to come back first.
   */
  placeFilmOnTimeline(index) {
    const film = get().film;
    if (!film) return;

    const assembled = assembleFilm(film, backend.assetSrc);
    if (!assembled) {
      get().pushToast({
        tone: 'error',
        title: 'The film is not finished',
        detail: `${filmProgress(film).label} — every transition has to land before the film can go on the timeline.`,
      });
      return;
    }

    set((s) => {
      const assets = { ...s.assets };
      for (const asset of assembled.assets) assets[asset.id] = asset;
      const first = assembled.clips[0];
      return {
        assets,
        clips: insertClips(s.clips, index ?? s.clips.length, assembled.clips),
        selection: first ? { kind: 'clip', clipId: first.id } : s.selection,
      };
    });
    get().pushToast({ tone: 'ok', title: 'Film on the timeline', detail: `${assembled.clips.length} transitions` });
  },

  /** Put the film away. Cancel it first if its legs are still running — this only forgets it. */
  dismissFilm() {
    set({ film: null });
  },

  // ------------------------------------------------------------------ settings & export

  async loadSettings() {
    try {
      set({ settings: await backend.getSettings(), ffmpegAvailable: await backend.ffmpegAvailable() });
    } catch {
      set({ settings: null });
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

  async runExport() {
    const { clips, assets, pushToast } = get();
    if (clips.length === 0) return;

    const offline = clips.find((c) => !assets[c.assetId]?.path);
    if (offline) {
      set({
        exportState: {
          stage: 'Export blocked',
          fraction: 0,
          status: 'failed',
          error: `“${offline.name}” has no file on disk to render. Re-import it from the file picker.`,
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

    set({ exportState: { stage: 'Starting…', fraction: 0, status: 'running' } });
    try {
      const written = await backend.exportTimeline(buildExportSpec(clips, assets), outPath);
      set({ exportState: null });
      pushToast({
        tone: 'ok',
        title: 'Export complete',
        detail: written,
        action: { label: 'Reveal', path: written },
      });
    } catch (error) {
      set({
        exportState: { stage: 'Export failed', fraction: 0, status: 'failed', error: message(error) },
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

type Frames = { startFrame: string; endFrame: string };

/**
 * The one place a generation is written.
 *
 * A film leg's state lives in two places — the generation board and the film — and this
 * keeps them from drifting: update the generation and the leg follows, always.
 */
function putGeneration(set: Setter, generation: Generation): void {
  set((s) => ({
    generations: { ...s.generations, [generation.id]: generation },
    film: generation.kind === 'film' && s.film ? applyGenerationToFilm(s.film, generation) : s.film,
  }));
}

/**
 * Put a generation on the board and get it moving.
 *
 * The two callers differ only in which stills they send: a segment renders one photo at two
 * keyframe framings, a film leg renders two different photos. Everything after that — the
 * bridge call, the shape of a failure, the toast — is the same job, so it is written once.
 */
async function launchGeneration(
  set: Setter,
  get: () => EditorState,
  generation: Generation,
  renderFrames: () => Promise<Frames>,
): Promise<void> {
  putGeneration(set, generation);
  try {
    const { startFrame, endFrame } = await renderFrames();
    await backend.generateAnimation({
      generationId: generation.id,
      prompt: generation.prompt,
      startFrame,
      endFrame,
    });
  } catch (error) {
    const failure: GenerationError = {
      title: 'Could not start',
      message: message(error),
      retryable: true,
    };
    putGeneration(set, { ...generation, status: 'failed', error: failure });
    get().pushToast({ tone: 'error', title: 'Generation could not start', detail: message(error) });
  }
}

/** One photo, framed as each end of the segment asks for it. */
async function segmentFrames(clip: Clip, segment: Segment, src: string): Promise<Frames> {
  const from = clip.keyframes.find((k) => k.id === segment.fromKeyframeId);
  const to = clip.keyframes.find((k) => k.id === segment.toKeyframeId);
  return {
    startFrame: await renderKeyframeJpeg(src, from?.transform ?? transformAt(clip, segment.startMs)),
    endFrame: await renderKeyframeJpeg(src, to?.transform ?? transformAt(clip, segment.endMs)),
  };
}

/**
 * Send one leg of the film out: photo A, then photo B, each drawn straight — the photos are
 * the keyframes here, so there is no framing to bake in beyond the cover-crop every still
 * already gets.
 */
async function launchFilmSegment(set: Setter, get: () => EditorState, index: number): Promise<void> {
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

  const generation: FilmGeneration = {
    kind: 'film',
    id: makeId('gen'),
    startAssetId: segment.startAssetId,
    endAssetId: segment.endAssetId,
    filmSegmentIndex: index,
    prompt: segment.prompt.trim() || defaultFilmPrompt(index),
    status: 'queued',
    progress: 0,
    elapsedSecs: 0,
    slow: false,
  };

  // The leg claims the id before anything is sent, so a straggling update from the run this
  // one replaces is recognisably stale.
  set((s) => (s.film ? { film: markFilmSegmentQueued(s.film, index, generation.id) } : s));

  await launchGeneration(set, get, generation, async () => ({
    startFrame: await renderKeyframeJpeg(start.src, IDENTITY_TRANSFORM),
    endFrame: await renderKeyframeJpeg(end.src, IDENTITY_TRANSFORM),
  }));
}

/** A leg's real length, read off the file Higgsfield actually returned. */
async function probeFilmSegmentDuration(set: Setter, index: number, outputPath: string): Promise<void> {
  const durationMs = await probeVideoDurationMs(backend.assetSrc(outputPath), FILM_SEGMENT_DURATION_MS);
  set((s) => {
    // Retried while the probe was in flight: that run's file owns the leg's length now.
    if (!s.film || s.film.segments.find((x) => x.index === index)?.outputPath !== outputPath) return s;
    return { film: patchFilmSegment(s.film, index, { durationMs }) };
  });
}

function newClip(asset: MediaAsset): Clip {
  return asset.kind === 'photo'
    ? photoClip(asset, DEFAULT_PHOTO_DURATION_MS)
    : videoClip(asset, DEFAULT_VIDEO_DURATION_MS);
}

/**
 * Clips appear at their default length straight away and correct themselves once the real
 * duration is known — an import that blocks on decoding feels broken.
 */
function commitImport(
  set: Setter,
  get: () => EditorState,
  accepted: { asset: MediaAsset; clip: Clip }[],
  problems: ImportProblem[],
  index?: number,
) {
  if (accepted.length === 0 && problems.length === 0) return;

  set((s) => {
    const assets = { ...s.assets };
    for (const { asset } of accepted) assets[asset.id] = asset;
    const at = index ?? s.clips.length;
    const clips = insertClips(
      s.clips,
      at,
      accepted.map((a) => a.clip),
    );
    return {
      assets,
      clips,
      importProblems: [...s.importProblems, ...problems],
      selection: accepted[0] ? { kind: 'clip', clipId: accepted[0].clip.id } : s.selection,
    };
  });
  void get;
}

async function probeDurations(set: Setter, accepted: { asset: MediaAsset; clip: Clip }[]) {
  const videos = accepted.filter((a) => a.asset.kind === 'video');
  await Promise.all(
    videos.map(async ({ asset, clip }) => {
      const durationMs = await probeVideoDurationMs(asset.src, DEFAULT_VIDEO_DURATION_MS);
      set((s) => ({
        // The asset keeps the source length for good: it is what bounds a later trim.
        assets: s.assets[asset.id]
          ? { ...s.assets, [asset.id]: { ...s.assets[asset.id], durationMs } }
          : s.assets,
        clips: s.clips.map((c) =>
          // A trim that landed while the probe was in flight is the user's, not ours.
          c.id === clip.id && c.durationMs === DEFAULT_VIDEO_DURATION_MS && c.trimStartMs === 0
            ? { ...c, durationMs }
            : c,
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

function selectedClipId(selection: Selection): string | null {
  return selection.kind === 'none' ? null : selection.clipId;
}

function startOf(clips: Clip[], clipId: string): number {
  let cursor = 0;
  for (const clip of clips) {
    if (clip.id === clipId) return cursor;
    cursor += clip.durationMs;
  }
  return 0;
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/** Shape expected by `solcut_render::ExportSpec`. */
export function buildExportSpec(clips: Clip[], assets: Record<string, MediaAsset>) {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    clips: clips.map((clip) => {
      const asset = assets[clip.assetId];
      const common = { name: clip.name, durationMs: clip.durationMs };
      if (clip.kind === 'photo') {
        return {
          ...common,
          kind: 'photo',
          path: asset?.path ?? '',
          keyframes: (clip.keyframes.length > 0
            ? clip.keyframes
            : [{ timeMs: 0, transform: transformAt(clip, 0) }]
          ).map((k) => ({
            timeMs: k.timeMs,
            scale: k.transform.scale,
            x: k.transform.x,
            y: k.transform.y,
            rotationDeg: k.transform.rotation,
            opacity: k.transform.opacity,
          })),
        };
      }
      return { ...common, kind: 'video', path: asset?.path ?? '', trimStartMs: clip.trimStartMs };
    }),
  };
}

/** Segments of the currently selected clip, for the timeline and inspector. */
export function selectedSegments(state: EditorState) {
  const id = selectedClipId(state.selection);
  const clip = id ? state.clips.find((c) => c.id === id) : undefined;
  return clip ? segmentsOf(clip) : [];
}
