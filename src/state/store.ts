/**
 * Editor state.
 *
 * Deliberately one flat store: the timeline is a single track, and nearly every action
 * touches both the clip list and the selection, so splitting it up would mostly create
 * synchronisation work. Anything that is pure arithmetic lives in `lib/timeline`.
 */

import { create } from 'zustand';
import * as backend from '../lib/backend';
import { probeAudioDurationMs, probeVideoDurationMs, renderKeyframeJpeg } from '../lib/frames';
import {
  AUDIO_EXTS,
  DEFAULT_AUDIO_DURATION_MS,
  DEFAULT_PHOTO_DURATION_MS,
  DEFAULT_VIDEO_DURATION_MS,
  type AudioTrack,
  type Clip,
  type ClipEdge,
  type Generation,
  type MediaAsset,
  type MediaKind,
  type Selection,
  type Transform2D,
} from '../types/project';
import {
  addKeyframe,
  audioTrack,
  clipAt,
  findSegment,
  insertClips,
  makeId,
  moveAudio,
  moveKeyframe,
  photoClip,
  placeClip,
  removeKeyframe,
  replaceSegment,
  resizeAudio,
  resizeClipInList,
  segmentsOf,
  setPrompt,
  sortClips,
  timelineEndMs,
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
  importing: number;
  importProblems: ImportProblem[];

  settings: backend.SettingsView | null;
  settingsOpen: boolean;
  connectionMessage: { ok: boolean; text: string } | null;

  exportState: ExportState | null;
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
  addKeyframeAtPlayhead: () => void;
  updateSelectedKeyframe: (patch: Partial<Transform2D>) => void;
  moveSelectedKeyframe: (timeMs: number) => void;
  deleteSelection: () => void;
  setSegmentPrompt: (prompt: string) => void;
  splitAtPlayhead: () => void;
  moveClipTo: (clipId: string, startMs: number) => void;
  resizeClip: (clipId: string, edge: ClipEdge, deltaMs: number) => void;
  toggleSnapping: () => void;

  // ---- playback
  setPlayhead: (ms: number) => void;
  togglePlay: () => void;
  advance: (deltaMs: number) => void;

  // ---- generation
  startGeneration: () => Promise<void>;
  applyGenerationUpdate: (update: backend.GenerationUpdate) => void;
  cancelGeneration: (id: string) => Promise<void>;
  dismissGeneration: (id: string) => void;

  // ---- settings, export, chrome
  loadSettings: () => Promise<void>;
  openSettings: () => void;
  closeSettings: () => void;
  saveSettings: (input: backend.SettingsInput) => Promise<void>;
  testConnection: (input: backend.SettingsInput) => Promise<void>;
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
  importing: 0,
  importProblems: [],

  settings: null,
  settingsOpen: false,
  connectionMessage: null,

  exportState: null,
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
    const { assets, clips, audioTracks, selection, generations, playheadMs, playing } = get();
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
        : selection.kind !== 'none' && doomed.has(selection.clipId);
    set({
      assets: nextAssets,
      clips: nextClips,
      audioTracks: nextAudio,
      generations: Object.fromEntries(
        Object.entries(generations).filter(([, g]) => !doomed.has(g.clipId)),
      ),
      selection: selectionDoomed ? { kind: 'none' } : selection,
      playheadMs: Math.min(playheadMs, total),
      playing: total === 0 ? false : playing,
    });

    // Nothing is left to put the result on, so stop paying for the render.
    for (const generation of Object.values(generations)) {
      if (!doomed.has(generation.clipId)) continue;
      if (generation.status !== 'queued' && generation.status !== 'running') continue;
      void backend.cancelGeneration(generation.id).catch(() => {});
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
    const { selection, clips, audioTracks } = get();
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
      return;
    }
    if (selection.kind === 'audio') {
      set({
        audioTracks: audioTracks.filter((t) => t.id !== selection.trackId),
        selection: { kind: 'none' },
      });
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
      // The two halves fill exactly the span the clip held, so nothing else moves.
      startMs: clip.startMs + hit.localMs,
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

  /** Drag along the track: `startMs` is where the clip should begin, gaps and all. */
  moveClipTo(clipId, startMs) {
    const { clips } = get();
    const next = placeClip(clips, clipId, startMs);
    if (next === clips) return;
    set({ clips: next, selection: { kind: 'clip', clipId } });
  },

  /** Drag an edge: `deltaMs` is how far it moved to the right, whichever edge it is. */
  resizeClip(clipId, edge, deltaMs) {
    const { clips, audioTracks, assets, playheadMs } = get();
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;

    const next = resizeClipInList(clips, clipId, edge, deltaMs, assets[clip.assetId]?.durationMs);
    if (next === clips) return;

    set({
      clips: next,
      // The track just got shorter under the playhead, or it did not — either way it stays on it.
      playheadMs: Math.min(playheadMs, timelineEndMs(next, audioTracks)),
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

  async startGeneration() {
    const { selection, clips, assets, pushToast } = get();
    if (selection.kind !== 'segment') return;

    const clip = clips.find((c) => c.id === selection.clipId);
    if (!clip) return;
    const segment = findSegment(clip, selection.fromKeyframeId, selection.toKeyframeId);
    if (!segment) return;

    const prompt = (clip.prompts[selection.fromKeyframeId] ?? '').trim();
    if (!prompt) return;

    const asset = assets[clip.assetId];
    if (!asset) return;

    const generationId = makeId('gen');
    const generation: Generation = {
      id: generationId,
      clipId: clip.id,
      fromKeyframeId: selection.fromKeyframeId,
      toKeyframeId: selection.toKeyframeId,
      prompt,
      status: 'queued',
      progress: 0,
      elapsedSecs: 0,
      slow: false,
    };
    set((s) => ({ generations: { ...s.generations, [generationId]: generation } }));

    try {
      const from = clip.keyframes.find((k) => k.id === selection.fromKeyframeId);
      const to = clip.keyframes.find((k) => k.id === selection.toKeyframeId);
      const startFrame = await renderKeyframeJpeg(
        asset.src,
        from?.transform ?? transformAt(clip, segment.startMs),
      );
      const endFrame = await renderKeyframeJpeg(
        asset.src,
        to?.transform ?? transformAt(clip, segment.endMs),
      );

      await backend.generateAnimation({ generationId, prompt, startFrame, endFrame });
    } catch (error) {
      set((s) => ({
        generations: {
          ...s.generations,
          [generationId]: {
            ...generation,
            status: 'failed',
            error: { title: 'Could not start', message: message(error), retryable: true },
          },
        },
      }));
      pushToast({ tone: 'error', title: 'Generation could not start', detail: message(error) });
    }
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
    set((s) => ({ generations: { ...s.generations, [update.generationId]: next } }));

    if (update.status !== 'succeeded' || !update.outputPath) return;

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
    set((s) => {
      const existing = s.generations[id];
      if (!existing) return s;
      return { generations: { ...s.generations, [id]: { ...existing, status: 'cancelled' } } };
    });
  },

  dismissGeneration(id) {
    set((s) => {
      const generations = { ...s.generations };
      delete generations[id];
      return { generations };
    });
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

  async testConnection(input) {
    try {
      set({ connectionMessage: { ok: true, text: await backend.testConnection(input) } });
    } catch (error) {
      set({ connectionMessage: { ok: false, text: message(error) } });
    }
  },

  async runExport() {
    const { clips, audioTracks, assets, pushToast } = get();
    if (clips.length === 0) return;

    const offline =
      clips.find((c) => !assets[c.assetId]?.path) ??
      audioTracks.find((t) => !t.muted && !assets[t.assetId]?.path);
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
      const written = await backend.exportTimeline(buildExportSpec(clips, assets, audioTracks), outPath);
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

function selectedClipId(selection: Selection): string | null {
  return selection.kind === 'none' || selection.kind === 'audio' ? null : selection.clipId;
}

function startOf(clips: Clip[], clipId: string): number {
  return clips.find((c) => c.id === clipId)?.startMs ?? 0;
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
