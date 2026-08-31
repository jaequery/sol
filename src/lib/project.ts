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
 * Anything belonging to a running session — generations, films, playback, selection,
 * dialogs, toasts — is left out entirely. A generation's job dies with the process, so a
 * restored one would be a card that never finishes.
 */

import {
  MIN_CLIP_DURATION_MS,
  type AudioTrack,
  type Clip,
  type MediaAsset,
  type MediaKind,
  type TransitionMode,
  type TransitionSource,
} from '../types/project';

/**
 * The stored schema's version.
 *
 * A file from an *older* version this build no longer understands is refused rather than
 * half-read; a file from a *newer* one turns saving off rather than overwriting work a
 * later build is holding.
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

export interface ProjectFile {
  version: number;
  assets: SavedAsset[];
  clips: Clip[];
  audioTracks: AudioTrack[];
  cutPrompts: Record<string, string>;
  cutModes: Record<string, TransitionMode>;
}

/** The slice of the editor that *is* the project — everything else belongs to the session. */
export interface ProjectDocument {
  assets: Record<string, MediaAsset>;
  clips: Clip[];
  audioTracks: AudioTrack[];
  cutPrompts: Record<string, string>;
  cutModes: Record<string, TransitionMode>;
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
  return {
    version: PROJECT_VERSION,
    assets: Object.values(doc.assets).map(toSavedAsset),
    clips: doc.clips,
    audioTracks: doc.audioTracks,
    cutPrompts: doc.cutPrompts,
    cutModes: doc.cutModes,
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
  return {
    kind: 'project',
    file: {
      version: PROJECT_VERSION,
      assets,
      clips,
      audioTracks,
      cutPrompts: prunedCutKeys(record(raw.cutPrompts), live, (v) => str(v)),
      cutModes: prunedCutKeys(record(raw.cutModes), live, (v) =>
        v === 'insert' || v === 'replace' ? v : null,
      ),
    },
  };
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

  return {
    assets,
    clips: file.clips,
    audioTracks: file.audioTracks,
    cutPrompts: file.cutPrompts,
    cutModes: file.cutModes,
  };
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
  return { clipId, assetId };
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
