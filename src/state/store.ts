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
  type Selection,
  type Transform2D,
  type TransitionSource,
} from '../types/project';
import {
  addKeyframe,
  audioTrack,
  clipAt,
  findSegment,
  insertClips,
  insertTransitionClip,
  makeId,
  moveAudio,
  moveClip as moveClipInList,
  moveKeyframe,
  photoClip,
  photoCuts,
  removeKeyframe,
  replaceSegment,
  replaceTransitionClip,
  resizeAudio,
  resizeClip as resizeClipEdge,
  segmentsOf,
  setPrompt,
  timelineEndMs,
  transformAt,
  updateKeyframe,
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

  generations: Record<string, Generation>;
  /** Prompts typed for cuts that have not generated yet, keyed `${afterClipId}:${beforeClipId}`. */
  cutPrompts: Record<string, string>;
  /** Cuts still waiting their turn in an "Animate all" run. `null` when no run is active. */
  animateQueue: Cut[] | null;
  /** The queue's generation whose submission has not been accepted (no `jobId`) yet. */
  animateSubmittingId: string | null;
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
  moveClip: (clipId: string, toIndex: number) => void;
  resizeClip: (clipId: string, edge: ClipEdge, deltaMs: number) => void;

  // ---- playback
  setPlayhead: (ms: number) => void;
  togglePlay: () => void;
  advance: (deltaMs: number) => void;

  // ---- generation
  startGeneration: () => Promise<void>;
  setCutPrompt: (prompt: string) => void;
  setTransitionPrompt: (clipId: string, prompt: string) => void;
  startCutGeneration: (afterClipId: string, beforeClipId: string) => string | null;
  regenerateTransition: (clipId: string) => void;
  retryGeneration: (generationId: string) => void;
  animateAll: () => void;
  advanceAnimateQueue: () => void;
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

  generations: {},
  cutPrompts: {},
  animateQueue: null,
  animateSubmittingId: null,
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
    const { assets, clips, audioTracks, selection, generations, cutPrompts, playheadMs, playing, animateSubmittingId } =
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

    // A generation is doomed when any clip it works for is: the segment's clip, either
    // side of the cut, or the transition clip it would replace.
    const generationDoomed = (g: Generation) =>
      g.target.kind === 'segment'
        ? doomed.has(g.target.clipId)
        : doomed.has(g.target.afterClipId) ||
          doomed.has(g.target.beforeClipId) ||
          (g.target.replacesClipId !== undefined && doomed.has(g.target.replacesClipId));

    const kept = Object.fromEntries(
      Object.entries(generations).filter(([, g]) => !generationDoomed(g)),
    );
    const pruned = prunedAfterEdit(nextClips, kept, cutPrompts);
    set({
      assets: nextAssets,
      clips: nextClips,
      audioTracks: nextAudio,
      generations: pruned.generations,
      cutPrompts: pruned.cutPrompts,
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
    const { selection, clips, audioTracks, generations, cutPrompts } = get();
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
      const nextClips = clips.filter((c) => c.id !== selection.clipId);
      set({
        clips: nextClips,
        selection: { kind: 'none' },
        ...prunedAfterEdit(nextClips, generations, cutPrompts),
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
    const { clips, playheadMs, generations, cutPrompts } = get();
    const hit = clipAt(clips, playheadMs);
    if (!hit || hit.localMs <= 0 || hit.localMs >= hit.placed.clip.durationMs) return;

    // Half a transition no longer runs first frame to last, so neither half can honestly
    // claim its sources; both keep `ai` (still generated footage) but drop `transition`.
    const clip = hit.placed.clip;
    const head: Clip = {
      ...clip,
      id: makeId('clip'),
      transition: undefined,
      durationMs: hit.localMs,
      keyframes: clip.keyframes.filter((k) => k.timeMs < hit.localMs),
    };
    const tail: Clip = {
      ...clip,
      id: makeId('clip'),
      transition: undefined,
      durationMs: clip.durationMs - hit.localMs,
      trimStartMs: clip.trimStartMs + (clip.kind === 'video' ? hit.localMs : 0),
      keyframes: clip.keyframes
        .filter((k) => k.timeMs >= hit.localMs)
        .map((k) => ({ ...k, timeMs: k.timeMs - hit.localMs })),
    };
    const index = clips.findIndex((c) => c.id === clip.id);
    const nextClips = [...clips.slice(0, index), head, tail, ...clips.slice(index + 1)];
    set({
      clips: nextClips,
      selection: { kind: 'clip', clipId: tail.id },
      ...prunedAfterEdit(nextClips, generations, cutPrompts),
    });
  },

  /** Drag along the track: `toIndex` counts positions among the clips it leaves behind. */
  moveClip(clipId, toIndex) {
    const { clips, generations, cutPrompts } = get();
    const next = moveClipInList(clips, clipId, toIndex);
    if (next === clips) return;
    set({
      clips: next,
      selection: { kind: 'clip', clipId },
      ...prunedAfterEdit(next, generations, cutPrompts),
    });
  },

  /** Drag an edge: `deltaMs` is how far it moved to the right, whichever edge it is. */
  resizeClip(clipId, edge, deltaMs) {
    const { clips, audioTracks, assets, playheadMs } = get();
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;

    const resized = resizeClipEdge(clip, edge, deltaMs, assets[clip.assetId]?.durationMs);
    if (resized === clip) return;

    const next = clips.map((c) => (c.id === clipId ? resized : c));
    set({
      clips: next,
      // The track just got shorter under the playhead, or it did not — either way it stays on it.
      playheadMs: Math.min(playheadMs, timelineEndMs(next, audioTracks)),
    });
  },

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
    const { selection } = get();
    if (selection.kind !== 'segment') return;
    startSegmentGeneration(set, get, selection.clipId, selection.fromKeyframeId, selection.toKeyframeId);
  },

  setCutPrompt(prompt) {
    const { selection } = get();
    if (selection.kind !== 'cut') return;
    const key = cutKey(selection.afterClipId, selection.beforeClipId);
    set((s) => ({ cutPrompts: { ...s.cutPrompts, [key]: prompt } }));
  },

  setTransitionPrompt(clipId, prompt) {
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId && c.transition ? { ...c, transition: { ...c.transition, prompt } } : c,
      ),
    }));
  },

  startCutGeneration(afterClipId, beforeClipId) {
    const s = get();
    if (!s.settings?.configured) return null;
    if (!cutEligible(s, afterClipId, beforeClipId)) return null;

    const at = s.clips.findIndex((c) => c.id === afterClipId);
    const clipA = s.clips[at];
    const clipB = s.clips[at + 1];
    const prompt =
      (s.cutPrompts[cutKey(afterClipId, beforeClipId)] ?? '').trim() || DEFAULT_TRANSITION_PROMPT;
    const from: TransitionSource = {
      clipId: clipA.id,
      assetId: clipA.assetId,
      transform: transformAt(clipA, clipA.durationMs),
    };
    const to: TransitionSource = {
      clipId: clipB.id,
      assetId: clipB.assetId,
      transform: transformAt(clipB, 0),
    };
    const target: GenerationTarget = { kind: 'cut', afterClipId, beforeClipId, from, to };
    return launchGeneration(set, get, target, prompt, {
      fromSrc: s.assets[clipA.assetId].src,
      fromTransform: from.transform,
      toSrc: s.assets[clipB.assetId].src,
      toTransform: to.transform,
    });
  },

  /**
   * Re-render an existing transition from whatever stands around it NOW — that is what
   * makes stale → Regenerate correct after a reorder or a reframe. Nothing to do when the
   * clip is orphaned: there are no longer two photos to span.
   */
  regenerateTransition(clipId) {
    const s = get();
    if (!s.settings?.configured) return;
    const at = s.clips.findIndex((c) => c.id === clipId);
    const clip = at === -1 ? undefined : s.clips[at];
    if (!clip?.transition) return;

    const left = s.clips[at - 1];
    const right = s.clips[at + 1];
    if (!left || !right || left.kind !== 'photo' || right.kind !== 'photo') return;
    const assetA = s.assets[left.assetId];
    const assetB = s.assets[right.assetId];
    if (!assetA || !assetB || assetA.missing || assetB.missing) return;
    const alreadyLive = Object.values(s.generations).some(
      (g) => liveGeneration(g) && g.target.kind === 'cut' && g.target.replacesClipId === clipId,
    );
    if (alreadyLive) return;

    const prompt = clip.transition.prompt.trim() || DEFAULT_TRANSITION_PROMPT;
    const from: TransitionSource = {
      clipId: left.id,
      assetId: left.assetId,
      transform: transformAt(left, left.durationMs),
    };
    const to: TransitionSource = {
      clipId: right.id,
      assetId: right.assetId,
      transform: transformAt(right, 0),
    };
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
      fromTransform: from.transform,
      toSrc: assetB.src,
      toTransform: to.transform,
    });
  },

  /** Resubmit a failed generation from its own target — never from whatever is selected. */
  retryGeneration(generationId) {
    const generation = get().generations[generationId];
    if (!generation || generation.status !== 'failed') return;
    get().dismissGeneration(generationId);

    const target = generation.target;
    if (target.kind === 'segment') {
      startSegmentGeneration(set, get, target.clipId, target.fromKeyframeId, target.toKeyframeId);
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
      const id = get().startCutGeneration(head.afterClipId, head.beforeClipId);
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
    set((s) => ({ generations: { ...s.generations, [update.generationId]: next } }));

    if (update.status === 'succeeded' && update.outputPath) {
      if (next.target.kind === 'segment') {
        landSegmentResult(set, get, next, next.target, update.outputPath);
      } else {
        landCutResult(set, get, next, next.target, update.outputPath);
      }
    }

    maybeAdvanceAnimateQueue(set, get, update.generationId);
  },

  async cancelGeneration(id) {
    await backend.cancelGeneration(id);
    set((s) => {
      const existing = s.generations[id];
      if (!existing) return s;
      return { generations: { ...s.generations, [id]: { ...existing, status: 'cancelled' } } };
    });
    maybeAdvanceAnimateQueue(set, get, id);
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
  return selection.kind === 'none' || selection.kind === 'audio' || selection.kind === 'cut'
    ? null
    : selection.clipId;
}

// ---------------------------------------------------------------- generation plumbing

function cutKey(afterClipId: string, beforeClipId: string): string {
  return `${afterClipId}:${beforeClipId}`;
}

function liveGeneration(g: Generation): boolean {
  return g.status === 'queued' || g.status === 'running';
}

/**
 * Whether this cut could start a generation right now: the pair still adjacent and in
 * order, both photos, both sources on hand, and no job already running for it. Settings
 * are checked separately — an unconfigured app changes what the UI says, not what a cut is.
 */
export function cutEligible(
  s: Pick<EditorState, 'clips' | 'assets' | 'generations'>,
  afterClipId: string,
  beforeClipId: string,
): boolean {
  const at = s.clips.findIndex((c) => c.id === afterClipId);
  const a = at === -1 ? undefined : s.clips[at];
  const b = s.clips[at + 1];
  if (!a || b?.id !== beforeClipId) return false;
  if (a.kind !== 'photo' || b.kind !== 'photo') return false;
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
 * After any edit that removes clips or changes their order: prompts for cuts whose clips
 * are gone go, and so do FAILED cut generations whose pair broke — those have no chip and
 * no card left to dismiss them from, so keeping them would leak invisible state.
 */
function prunedAfterEdit(
  clips: Clip[],
  generations: Record<string, Generation>,
  cutPrompts: Record<string, string>,
): Pick<EditorState, 'generations' | 'cutPrompts'> {
  const ids = new Set(clips.map((c) => c.id));
  const adjacent = new Set<string>();
  for (let i = 0; i < clips.length - 1; i += 1) adjacent.add(cutKey(clips[i].id, clips[i + 1].id));

  return {
    cutPrompts: Object.fromEntries(
      Object.entries(cutPrompts).filter(([key]) => {
        const [a, b] = key.split(':');
        return ids.has(a) && ids.has(b);
      }),
    ),
    generations: Object.fromEntries(
      Object.entries(generations).filter(([, g]) => {
        if (g.status !== 'failed' || g.target.kind !== 'cut') return true;
        if (g.target.replacesClipId !== undefined) return ids.has(g.target.replacesClipId);
        return adjacent.has(cutKey(g.target.afterClipId, g.target.beforeClipId));
      }),
    ),
  };
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
  frames: { fromSrc: string; fromTransform: Transform2D; toSrc: string; toTransform: Transform2D },
): string {
  const generationId = makeId('gen');
  const generation: Generation = {
    id: generationId,
    target,
    prompt,
    status: 'queued',
    progress: 0,
    elapsedSecs: 0,
    slow: false,
  };
  set((s) => ({ generations: { ...s.generations, [generationId]: generation } }));

  void (async () => {
    try {
      const startFrame = await renderKeyframeJpeg(frames.fromSrc, frames.fromTransform);
      const endFrame = await renderKeyframeJpeg(frames.toSrc, frames.toTransform);
      await backend.generateAnimation({ generationId, prompt, startFrame, endFrame });
    } catch (error) {
      set((s) => {
        const existing = s.generations[generationId];
        if (!existing) return s;
        return {
          generations: {
            ...s.generations,
            [generationId]: {
              ...existing,
              status: 'failed',
              error: { title: 'Could not start', message: message(error), retryable: true },
            },
          },
        };
      });
      get().pushToast({ tone: 'error', title: 'Generation could not start', detail: message(error) });
      maybeAdvanceAnimateQueue(set, get, generationId);
    }
  })();

  return generationId;
}

/** The segment path shared by "Generate animation" and a retry: prompt and frames from the clip. */
function startSegmentGeneration(
  set: Setter,
  get: () => EditorState,
  clipId: string,
  fromKeyframeId: string,
  toKeyframeId: string,
): string | null {
  const { clips, assets } = get();
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return null;
  const segment = findSegment(clip, fromKeyframeId, toKeyframeId);
  if (!segment) return null;

  const prompt = (clip.prompts[fromKeyframeId] ?? '').trim();
  if (!prompt) return null;

  const asset = assets[clip.assetId];
  if (!asset) return null;

  const from = clip.keyframes.find((k) => k.id === fromKeyframeId);
  const to = clip.keyframes.find((k) => k.id === toKeyframeId);
  return launchGeneration(
    set,
    get,
    { kind: 'segment', clipId, fromKeyframeId, toKeyframeId },
    prompt,
    {
      fromSrc: asset.src,
      fromTransform: from?.transform ?? transformAt(clip, segment.startMs),
      toSrc: asset.src,
      toTransform: to?.transform ?? transformAt(clip, segment.endMs),
    },
  );
}

/** A finished segment render: put the video where the KF→KF segment was. */
function landSegmentResult(
  set: Setter,
  get: () => EditorState,
  generation: Generation,
  target: Extract<GenerationTarget, { kind: 'segment' }>,
  outputPath: string,
): void {
  const source = get().clips.find((c) => c.id === target.clipId);
  const asset: MediaAsset = {
    id: makeId('asset'),
    name: `ai-${generation.id}.mp4`,
    kind: 'video',
    path: outputPath,
    src: backend.assetSrc(outputPath),
    sizeBytes: 0,
    // Higgsfield rendered exactly the segment it was given, so that is the whole file.
    durationMs: source
      ? findSegment(source, target.fromKeyframeId, target.toKeyframeId)?.durationMs
      : undefined,
  };

  set((s) => {
    const clips = replaceSegment(s.clips, target.clipId, target.fromKeyframeId, target.toKeyframeId, {
      assetId: asset.id,
      name: asset.name,
      prompt: generation.prompt,
    });
    const generated = clips.find((c) => c.assetId === asset.id);
    return {
      assets: { ...s.assets, [asset.id]: asset },
      clips,
      selection: generated ? { kind: 'clip', clipId: generated.id } : s.selection,
    };
  });
  get().pushToast({ tone: 'ok', title: 'Animation ready', detail: generation.prompt });
}

/**
 * A finished cut render: insert the transition at its cut, or — for a regeneration — swap
 * it over the existing transition clip. The timeline may have been edited mid-render, so
 * the landing is guarded: if the place is gone the clip is never put somewhere wrong, the
 * MP4 stays in the cache, and a toast says what to do instead.
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
  };

  let landedClipId: string | null = null;
  set((s) => {
    const clips =
      target.replacesClipId !== undefined
        ? replaceTransitionClip(s.clips, target.replacesClipId, generated)
        : insertTransitionClip(s.clips, target.afterClipId, target.beforeClipId, generated);
    if (clips === s.clips) return s;
    const landed = clips.find((c) => c.assetId === asset.id);
    landedClipId = landed?.id ?? null;
    return {
      assets: { ...s.assets, [asset.id]: asset },
      clips,
      selection: landed ? { kind: 'clip', clipId: landed.id } : s.selection,
    };
  });

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
  // loads. A trim the user landed first wins, exactly as with imports.
  const clipId: string = landedClipId;
  void probeVideoDurationMs(asset.src, DEFAULT_TRANSITION_DURATION_MS).then((durationMs) => {
    set((s) => ({
      assets: s.assets[asset.id]
        ? { ...s.assets, [asset.id]: { ...s.assets[asset.id], durationMs } }
        : s.assets,
      clips: s.clips.map((c) =>
        c.id === clipId && c.durationMs === DEFAULT_TRANSITION_DURATION_MS && c.trimStartMs === 0
          ? { ...c, durationMs }
          : c,
      ),
    }));
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
