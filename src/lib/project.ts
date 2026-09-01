/**
 * What a saved project is.
 *
 * The app autosaves one project and restores it at launch, so this module is the whole
 * contract for it: what goes on disk, what is refused when it comes back, and how a stored
 * project becomes editor state again. Pure by design, like `timeline.ts` and `film.ts` —
 * no React, no Tauri, no clock — so every rule below is a unit test rather than a click.
 *
 * Two things are deliberately *not* stored, and both are the same mistake:
 *
 * - **`MediaAsset.src`** is a handle on this session, not data. It is either an `asset:`
 *   URL minted by `convertFileSrc` or a `blob:` URL that dies with the process. What
 *   survives a restart is the `path` the media came from, so that is what is written and
 *   `src` is recomputed at load.
 * - **`MediaAsset.missing`** is a fact about the disk *right now*, not about the project.
 *   It is recomputed too, by probing the paths after the project is back on screen.
 *
 * Most of what belongs to a running session — films, playback, selection, dialogs, toasts
 * — is still left out entirely. Two things are deliberately kept, and both are about
 * walking back into the room you left:
 *
 * - **Where you were**: the playhead, the zoom and the snap toggle (`view`). Position, not
 *   document, but a restart that opens at 0:00 and default zoom does not feel like the same
 *   project.
 * - **What was rendering** (`generations`): the *record* of a generation that was still in
 *   flight, and nothing a dead process owned. Its job cannot be resumed — there is no job
 *   id on disk and no re-attach entry point on the Rust side — so a restored one is stamped
 *   `failed` with an **Interrupted** error and offers Retry. It never re-sends itself.
 */

import {
  MAX_PX_PER_SECOND,
  MIN_CLIP_DURATION_MS,
  MIN_PX_PER_SECOND,
  type AudioTrack,
  type Clip,
  type Generation,
  type GenerationError,
  type GenerationTarget,
  type MediaAsset,
  type MediaKind,
  type TransitionMode,
  type TransitionSource,
} from '../types/project';

/**
 * What a restored generation says about itself.
 *
 * Without an explicit error the existing cards would read "Generation failed" and "The
 * photo could not be generated" — both untrue. Nothing failed; the app went away
 * mid-render. `build` is deliberately unset: no backend reported this, and stamping the
 * running build would attribute the report to something that never made it.
 */
export const INTERRUPTED: GenerationError = {
  title: 'Interrupted',
  message:
    'SolCut closed while this was rendering. Nothing was sent again — Retry to start it over.',
  retryable: true,
};

/**
 * The stored schema's version.
 *
 * A file from an *older* version this build no longer understands is refused rather than
 * half-read; a file from a *newer* one turns saving off rather than overwriting work a
 * later build is holding.
 *
 * **An additive field is not a new version.** Every reader below keys off a named field and
 * ignores what it does not know, so a build that predates `view`/`generations` reads a file
 * carrying them, and this build reads one without them. Bumping for that would be actively
 * destructive: a lower version is `unreadable` (there is no migration path), and for the
 * untitled scratch an unreadable read means "starting empty — anything you do now replaces
 * it", which arms the next edit to overwrite the user's whole project.
 */
export const PROJECT_VERSION = 1;

/** One asset as it is stored: identity, and the path it came from. Never a session handle. */
export interface SavedAsset {
  id: string;
  name: string;
  kind: MediaKind;
  path: string;
  sizeBytes: number;
  durationMs?: number;
}

/** Where the user was looking, as opposed to what they were looking at. */
export interface SavedView {
  playheadMs: number;
  pxPerSecond: number;
  snapping: boolean;
}

/**
 * One in-flight generation as it is stored: exactly what a later Retry needs, and nothing
 * that belonged to the process that died.
 *
 * `jobId` is the pointed omission. It is a handle on a Higgsfield job nothing can re-attach
 * to, and writing it down is the one thing that would make a restored record *look*
 * resumable. `status` and `error` are omitted for a different reason: the only status a
 * restore is allowed to produce is `failed`, so it is stamped on the way in rather than
 * read from a file a user can hand-edit into resurrecting a card that never finishes.
 */
export interface SavedGeneration {
  id: string;
  target: GenerationTarget;
  prompt: string;
  modelId: string;
}

export interface ProjectFile {
  version: number;
  assets: SavedAsset[];
  clips: Clip[];
  audioTracks: AudioTrack[];
  cutPrompts: Record<string, string>;
  cutModes: Record<string, TransitionMode>;
  /** Absent in a project written before there was anywhere to put it. */
  view?: SavedView;
  /** Only ever the live ones, and never a film leg. Absent when there were none. */
  generations?: SavedGeneration[];
}

/** The slice of the editor that *is* the project — everything else belongs to the session. */
export interface ProjectDocument {
  assets: Record<string, MediaAsset>;
  clips: Clip[];
  audioTracks: AudioTrack[];
  cutPrompts: Record<string, string>;
  cutModes: Record<string, TransitionMode>;
  view?: SavedView;
  generations?: Record<string, Generation>;
}

/**
 * What reading the stored blob produced.
 *
 * `unreadable` and `newer` are kept apart on purpose: the first is a file this build gets
 * to replace, the second is one it must not touch, because overwriting it would destroy a
 * project a later build can still open.
 */
export type ProjectRead =
  | { kind: 'project'; file: ProjectFile }
  | { kind: 'empty' }
  | { kind: 'unreadable' }
  | { kind: 'newer'; version: number };

// ---------------------------------------------------------------- writing

export function toProjectFile(doc: ProjectDocument): ProjectFile {
  const file: ProjectFile = {
    version: PROJECT_VERSION,
    assets: Object.values(doc.assets).map(toSavedAsset),
    clips: doc.clips,
    audioTracks: doc.audioTracks,
    cutPrompts: doc.cutPrompts,
    cutModes: doc.cutModes,
  };
  if (doc.view) file.view = { ...doc.view };

  // Only what is still running, and never a film leg. Both halves matter: a finished
  // generation is already an ordinary clip or an ordinary bin photo, and a film leg would
  // come back to a film that does not exist. Omitted entirely when there is nothing to
  // say, so an ordinary project's bytes are exactly what they were before.
  //
  // A restored record is `failed`, so it is *not* written again: the interrupted card is a
  // report about the session that was interrupted rather than a to-do the project carries
  // around for ever, and once it has been shown the next write lets it go. Nothing is lost
  // by that — the timeline is untouched and the cut is still one tap from generating.
  const live = Object.values(doc.generations ?? {}).filter(isPersistable).map(toSavedGeneration);
  if (live.length > 0) file.generations = live;
  return file;
}

/** A generation worth writing down: still running, and with somewhere to come back to. */
function isPersistable(generation: Generation): boolean {
  if (generation.target.kind === 'film') return false;
  return generation.status === 'queued' || generation.status === 'running';
}

function toSavedGeneration(generation: Generation): SavedGeneration {
  return {
    id: generation.id,
    target: generation.target,
    prompt: generation.prompt,
    modelId: generation.modelId,
  };
}

function toSavedAsset(asset: MediaAsset): SavedAsset {
  const saved: SavedAsset = {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    path: asset.path,
    sizeBytes: asset.sizeBytes,
  };
  // Kept so a restored video can be trimmed straight away, instead of being stuck at the
  // length it was drawn with until something re-probes the file.
  if (asset.durationMs !== undefined) saved.durationMs = asset.durationMs;
  return saved;
}

// ---------------------------------------------------------------- reading

/**
 * Read whatever was stored.
 *
 * Deliberately unforgiving: the file is hand-editable and survives app versions, so
 * anything that is not exactly a project of this version is refused whole rather than
 * half-applied. A clip missing its `startMs` is not a clip, and half a timeline on screen
 * would be worse than none.
 */
export function readProjectFile(raw: unknown): ProjectRead {
  if (raw === null || raw === undefined) return { kind: 'empty' };
  if (!isRecord(raw)) return { kind: 'unreadable' };

  const version = num(raw.version);
  if (version === null) return { kind: 'unreadable' };
  if (version > PROJECT_VERSION) return { kind: 'newer', version };
  if (version !== PROJECT_VERSION) return { kind: 'unreadable' };

  const assets = array(raw.assets).map(readAsset).filter(isPresent);
  const known = new Set(assets.map((a) => a.id));

  // A clip whose media is not in the bin has nothing to draw and nothing to export. It is
  // dropped rather than left dangling, exactly as `removeAsset` takes clips with an asset.
  const clips = array(raw.clips)
    .map(readClip)
    .filter(isPresent)
    .filter((c) => known.has(c.assetId));
  const audioTracks = array(raw.audioTracks)
    .map(readAudioTrack)
    .filter(isPresent)
    .filter((t) => known.has(t.assetId));

  const live = new Set(clips.map((c) => c.id));
  const file: ProjectFile = {
    version: PROJECT_VERSION,
    assets,
    clips,
    audioTracks,
    cutPrompts: prunedCutKeys(record(raw.cutPrompts), live, (v) => str(v)),
    cutModes: prunedCutKeys(record(raw.cutModes), live, (v) =>
      v === 'insert' || v === 'replace' ? v : null,
    ),
  };

  const view = readView(raw.view);
  if (view) file.view = view;

  // A record whose clips went with a dropped asset has no chip and no card to be dismissed
  // from, exactly like a cut prompt for a cut that no longer exists.
  const generations = array(raw.generations)
    .map(readGeneration)
    .filter(isPresent)
    .filter((g) => generationStands(g, live));
  if (generations.length > 0) file.generations = generations;

  return { kind: 'project', file };
}

/** Whether a stored generation still has the clips it would need to be retried onto. */
function generationStands(saved: SavedGeneration, liveClipIds: ReadonlySet<string>): boolean {
  // An image is retried from the prompt alone — dangling references are skipped by the
  // launch itself — so it never depends on the track.
  if (saved.target.kind !== 'cut') return true;
  if (saved.target.replacesClipId !== undefined) return liveClipIds.has(saved.target.replacesClipId);
  return (
    liveClipIds.has(saved.target.afterClipId) && liveClipIds.has(saved.target.beforeClipId)
  );
}

/**
 * Turn a stored project back into editor state.
 *
 * Nothing is asked of the filesystem here: the project goes on screen *before* the paths
 * are probed, because probing first would hold the window closed while a sleeping drive
 * woke up. The one absence knowable without asking is an asset with no path at all — a
 * browser drop, which only ever had an object URL, and can never come back.
 */
export function hydrate(
  file: ProjectFile,
  opts: { resolveSrc: (path: string) => string },
): ProjectDocument {
  const assets: Record<string, MediaAsset> = {};

  for (const saved of file.assets) {
    const asset: MediaAsset = {
      id: saved.id,
      name: saved.name,
      kind: saved.kind,
      path: saved.path,
      src: saved.path ? opts.resolveSrc(saved.path) : '',
      sizeBytes: saved.sizeBytes,
    };
    if (saved.durationMs !== undefined) asset.durationMs = saved.durationMs;
    if (!saved.path) asset.missing = true;
    assets[saved.id] = asset;
  }

  const doc: ProjectDocument = {
    assets,
    clips: file.clips,
    audioTracks: file.audioTracks,
    cutPrompts: file.cutPrompts,
    cutModes: file.cutModes,
  };
  if (file.view) doc.view = file.view;
  if (file.generations) doc.generations = hydrateGenerations(file.generations);
  return doc;
}

/**
 * A stored generation as a card the user can act on.
 *
 * `failed` is the only status a restore may produce, and it is stamped here rather than
 * read: the job it names is gone, so any other status would be a card that never finishes.
 * Everything a running one displays — progress, elapsed, slow, the job id — starts empty,
 * because it described a process that no longer exists.
 */
function hydrateGenerations(saved: SavedGeneration[]): Record<string, Generation> {
  const generations: Record<string, Generation> = {};
  for (const one of saved) {
    generations[one.id] = {
      id: one.id,
      target: one.target,
      prompt: one.prompt,
      modelId: one.modelId,
      status: 'failed',
      progress: 0,
      elapsedSecs: 0,
      slow: false,
      error: { ...INTERRUPTED },
    };
  }
  return generations;
}

/**
 * Fold a finished existence probe into the media bin.
 *
 * Returns the *same* object when nothing changed, so a probe that finds every file where
 * it left it does not look like an edit and does not cost a write.
 */
export function markMissing(
  assets: Record<string, MediaAsset>,
  missingPaths: ReadonlySet<string>,
): { assets: Record<string, MediaAsset>; missing: MediaAsset[] } {
  const missing: MediaAsset[] = [];
  let changed = false;
  const next: Record<string, MediaAsset> = {};

  for (const [id, asset] of Object.entries(assets)) {
    const gone = !asset.path || missingPaths.has(asset.path);
    if (gone) missing.push(asset);
    if (gone === Boolean(asset.missing)) {
      next[id] = asset;
      continue;
    }
    changed = true;
    const patched: MediaAsset = { ...asset };
    if (gone) patched.missing = true;
    else delete patched.missing;
    next[id] = patched;
  }

  return { assets: changed ? next : assets, missing };
}

// ---------------------------------------------------------------- field readers

function readAsset(raw: unknown): SavedAsset | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const name = str(raw.name);
  const path = str(raw.path);
  const kind = raw.kind === 'photo' || raw.kind === 'video' || raw.kind === 'audio' ? raw.kind : null;
  if (!id || name === null || path === null || !kind) return null;

  const asset: SavedAsset = { id, name, kind, path, sizeBytes: num(raw.sizeBytes) ?? 0 };
  const durationMs = num(raw.durationMs);
  if (durationMs !== null && durationMs > 0) asset.durationMs = durationMs;
  return asset;
}

function readClip(raw: unknown): Clip | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const assetId = str(raw.assetId);
  const name = str(raw.name);
  const kind = raw.kind === 'photo' || raw.kind === 'video' ? raw.kind : null;
  const startMs = num(raw.startMs);
  const durationMs = num(raw.durationMs);
  const trimStartMs = num(raw.trimStartMs);
  if (!id || !assetId || name === null || !kind) return null;
  if (startMs === null || durationMs === null || trimStartMs === null) return null;

  const clip: Clip = {
    id,
    assetId,
    kind,
    name,
    startMs: Math.max(0, startMs),
    durationMs: Math.max(MIN_CLIP_DURATION_MS, durationMs),
    trimStartMs: Math.max(0, trimStartMs),
  };

  const ai = readAi(raw.ai);
  if (ai) clip.ai = ai;
  // Read whole or not at all: half a transition record would have the staleness check
  // reaching into a source that isn't there.
  const transition = readTransition(raw.transition);
  if (transition) clip.transition = transition;
  return clip;
}

function readAi(raw: unknown): Clip['ai'] | null {
  if (!isRecord(raw)) return null;
  const prompt = str(raw.prompt);
  const sourceAssetId = str(raw.sourceAssetId);
  if (prompt === null || !sourceAssetId) return null;
  return { prompt, sourceAssetId };
}

function readTransition(raw: unknown): Clip['transition'] | null {
  if (!isRecord(raw)) return null;
  const prompt = str(raw.prompt);
  const from = readTransitionSource(raw.from);
  const to = readTransitionSource(raw.to);
  if (prompt === null || !from || !to) return null;
  const transition: NonNullable<Clip['transition']> = { prompt, from, to };
  if (raw.mode === 'insert' || raw.mode === 'replace') transition.mode = raw.mode;
  return transition;
}

function readTransitionSource(raw: unknown): TransitionSource | null {
  if (!isRecord(raw)) return null;
  const clipId = str(raw.clipId);
  const assetId = str(raw.assetId);
  if (!clipId || !assetId) return null;
  const source: TransitionSource = { clipId, assetId };
  // Videos only, and only since transitions could involve them: a record without it is a
  // photo side, or one written before there was anything else to be.
  const atMs = num(raw.atMs);
  if (atMs !== null && atMs >= 0) source.atMs = Math.round(atMs);
  return source;
}

/**
 * Where the user was looking.
 *
 * Clamped rather than trusted: the file is hand-editable, and a zoom outside the slider's
 * own range would draw a timeline the control that produced it cannot represent. Read whole
 * or not at all — half a viewport is not a viewport, and the defaults are perfectly good.
 */
function readView(raw: unknown): SavedView | null {
  if (!isRecord(raw)) return null;
  const playheadMs = num(raw.playheadMs);
  const pxPerSecond = num(raw.pxPerSecond);
  if (playheadMs === null || pxPerSecond === null) return null;
  return {
    playheadMs: Math.max(0, Math.round(playheadMs)),
    pxPerSecond: Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, pxPerSecond)),
    // Snapping is on unless the file says otherwise, which is also the app's own default.
    snapping: raw.snapping !== false,
  };
}

function readGeneration(raw: unknown): SavedGeneration | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const prompt = str(raw.prompt);
  const modelId = str(raw.modelId);
  if (!id || prompt === null || !modelId) return null;
  const target = readGenerationTarget(raw.target);
  if (!target) return null;
  return { id, target, prompt, modelId };
}

/**
 * What the generation was for — and the one place a **film leg is refused**.
 *
 * A film's own state is not part of the project, so a restored leg would be a record no
 * component renders and whose Retry dismisses the card and then silently does nothing. It
 * is dropped where it enters, for the same reason a clip whose asset is missing is: the
 * file survives versions and is hand-editable, so the guarantee belongs at the door.
 */
function readGenerationTarget(raw: unknown): GenerationTarget | null {
  if (!isRecord(raw)) return null;

  if (raw.kind === 'cut') {
    const afterClipId = str(raw.afterClipId);
    const beforeClipId = str(raw.beforeClipId);
    const from = readTransitionSource(raw.from);
    const to = readTransitionSource(raw.to);
    if (!afterClipId || !beforeClipId || !from || !to) return null;
    const target: Extract<GenerationTarget, { kind: 'cut' }> = {
      kind: 'cut',
      afterClipId,
      beforeClipId,
      from,
      to,
    };
    const replacesClipId = str(raw.replacesClipId);
    if (replacesClipId) target.replacesClipId = replacesClipId;
    if (raw.mode === 'insert' || raw.mode === 'replace') target.mode = raw.mode;
    return target;
  }

  if (raw.kind === 'image') {
    const aspect = str(raw.aspect);
    if (aspect === null) return null;
    return {
      kind: 'image',
      referenceAssetIds: array(raw.referenceAssetIds).map(str).filter(isPresent),
      aspect,
    };
  }

  return null;
}

function readAudioTrack(raw: unknown): AudioTrack | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const assetId = str(raw.assetId);
  const name = str(raw.name);
  const startMs = num(raw.startMs);
  const durationMs = num(raw.durationMs);
  const trimStartMs = num(raw.trimStartMs);
  if (!id || !assetId || name === null) return null;
  if (startMs === null || durationMs === null || trimStartMs === null) return null;

  return {
    id,
    assetId,
    name,
    startMs: Math.max(0, startMs),
    durationMs: Math.max(MIN_CLIP_DURATION_MS, durationMs),
    trimStartMs: Math.max(0, trimStartMs),
    volume: Math.min(1, Math.max(0, num(raw.volume) ?? 1)),
    muted: raw.muted === true,
  };
}

/**
 * Keep only the cut entries whose cut still exists.
 *
 * They are keyed `${afterClipId}:${beforeClipId}` by the store, and a clip id never
 * contains a colon, so the key names its own two clips. Without this a clip dropped for a
 * dangling asset would leave its typed prompt behind for good — invisible, and rewritten
 * on every save.
 */
function prunedCutKeys<T>(
  raw: Record<string, unknown>,
  liveClipIds: ReadonlySet<string>,
  read: (value: unknown) => T | null,
): Record<string, T> {
  const kept: Record<string, T> = {};
  for (const [key, value] of Object.entries(raw)) {
    const [after, before, ...rest] = key.split(':');
    if (rest.length > 0 || !after || !before) continue;
    if (!liveClipIds.has(after) || !liveClipIds.has(before)) continue;
    const parsed = read(value);
    if (parsed !== null) kept[key] = parsed;
  }
  return kept;
}

// ---------------------------------------------------------------- primitives

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
