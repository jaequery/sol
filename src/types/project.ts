/**
 * The editor's data model. One visual track whose clips are placed by time — free to sit
 * anywhere, with gaps between them, but never overlapping, because one track means no
 * compositing. Plus any number of audio tracks, each its own lane below holding one sound.
 */

export type MediaKind = 'photo' | 'video' | 'audio';

/** What can sit on the visual track. Audio lives on its own lanes, never here. */
export type ClipKind = 'photo' | 'video';

export interface MediaAsset {
  id: string;
  name: string;
  kind: MediaKind;
  /** Absolute path on disk. Empty for assets that only exist as an object URL. */
  path: string;
  /** Something an `<img>`/`<video>` can load: an `asset:` URL or an object URL. */
  src: string;
  sizeBytes: number;
  /**
   * Videos only: the source's real length, once it has been probed. It is the wall a clip
   * on this asset cannot be trimmed past; while it is unknown, that clip can only shrink.
   */
  durationMs?: number;
  /** Set when the source file has gone missing since it was imported. */
  missing?: boolean;
}

/**
 * One audio lane: a single sound placed somewhere on the timeline. It starts wherever the
 * user puts it, exactly like a clip on the visual track — music rarely wants to begin
 * where a clip boundary happens to fall.
 */
export interface AudioTrack {
  id: string;
  assetId: string;
  name: string;
  /** Where on the timeline the sound starts playing. */
  startMs: number;
  durationMs: number;
  /** Where playback starts inside the source file — walks with a head trim, like video. */
  trimStartMs: number;
  /** 0..1 */
  volume: number;
  muted: boolean;
}

export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface GenerationError {
  title: string;
  message: string;
  retryable: boolean;
  /** `version+commit` of the backend that produced the report. Absent from builds that predate the stamp. */
  build?: string;
}

/**
 * One side of a generated transition: which clip stood there and what media it showed —
 * for a photo, the image itself is the frame sent to Higgsfield. Kept on the finished clip
 * so a later edit to either neighbour can be detected (staleness) and regenerated from.
 */
export interface TransitionSource {
  clipId: string;
  assetId: string;
  /**
   * Videos only: where in the source the anchor frame was taken — the outgoing clip's
   * trimmed-out point, or the incoming clip's trimmed-in point.
   *
   * A photo has one frame and needs none, and neither does any record written before
   * transitions could involve video. Without it a replace landing could never be
   * regenerated: it consumes its still side, so the clip that knew the trim is gone and
   * only what is written here survives.
   */
  atMs?: number;
}

/**
 * Where a finished cut render goes: `insert` slots it between the pair, `replace` stands it
 * in the place of the **stills** — the photos leave the track and the clip holds their
 * span, so playback there is pure motion rather than a held frame.
 *
 * Only stills leave, which is what makes `replace` mean one thing across every pair: two
 * photos both go, a photo beside a video leaves the video's own footage exactly where it
 * was, and two videos have no still to give up at all, so they are never offered it.
 * Absent anywhere it may appear means `insert` — the only behaviour older records knew.
 */
export type TransitionMode = 'insert' | 'replace';

/**
 * What a cut lands as when nothing picked otherwise: the finished clip stands in the
 * photos' place, so the transition costs no still time. Only a *fallback* — a stored
 * record with no `mode` still means `insert` (see above), because every launch since this
 * default stamps its mode explicitly. A pair with no still on either side resolves to
 * `insert` whatever is stored; see `cutOffersReplace`.
 */
export const DEFAULT_TRANSITION_MODE: TransitionMode = 'replace';

/**
 * What a generation is for: the cut between two adjacent photos, or one leg of a
 * three-photo film. Success routes on this — a cut result is inserted at the cut (or
 * swapped over `replacesClipId` when it is a regeneration of an existing transition clip),
 * and a film leg's result is parked in film state until every leg is in.
 */
export type GenerationTarget =
  | {
      kind: 'cut';
      afterClipId: string;
      beforeClipId: string;
      from: TransitionSource;
      to: TransitionSource;
      replacesClipId?: string;
      mode?: TransitionMode;
    }
  | {
      kind: 'film';
      startAssetId: string;
      endAssetId: string;
      /** 0 for photo 1 -> 2, 1 for photo 2 -> 3. Results are keyed by this, never by arrival. */
      filmSegmentIndex: number;
    };

export interface Generation {
  id: string;
  target: GenerationTarget;
  prompt: string;
  /** The model that renders it: a `RenderModel` id, or `custom` for the Settings model id. */
  modelId: string;
  status: GenerationStatus;
  /** 0..1 */
  progress: number;
  jobId?: string;
  elapsedSecs: number;
  slow: boolean;
  outputPath?: string;
  error?: GenerationError;
}

/** A generation narrowed to one kind of target — what the code that only handles one takes. */
export type GenerationOf<K extends GenerationTarget['kind']> = Generation & {
  target: Extract<GenerationTarget, { kind: K }>;
};

export type CutGeneration = GenerationOf<'cut'>;

/**
 * A transition between two *different* photos — one leg of a film.
 *
 * Its result is parked in film state rather than dropped on the timeline: a film goes onto
 * the track in one piece, once every leg has succeeded, so a half-finished film never
 * half-edits the project.
 */
export type FilmGeneration = GenerationOf<'film'>;

export interface Clip {
  id: string;
  assetId: string;
  kind: ClipKind;
  name: string;
  /**
   * Where on the timeline the clip starts. Clips may leave gaps between them — a gap is
   * black in the preview and in the export — but two of them never overlap.
   */
  startMs: number;
  durationMs: number;
  /** Videos only: where playback starts inside the source. */
  trimStartMs: number;
  /** Present when this clip is a Higgsfield result rather than imported media. */
  ai?: {
    prompt: string;
    sourceAssetId: string;
  };
  /**
   * Present when this clip is a generated transition between two clips — photos, videos or
   * one of each. `ai` is set too so every AI-clip affordance applies; this records the
   * exact sources so the clip can be flagged stale when its neighbours change, and
   * regenerated in place. A `replace`-mode clip stands where the pair's *stills* used to:
   * a source it consumed is regenerated from its asset in the media bin, and a source that
   * is still on the track is read from that clip as it stands now.
   */
  transition?: {
    prompt: string;
    from: TransitionSource;
    to: TransitionSource;
    mode?: TransitionMode;
  };
}

/** Which end of a clip a resize drag has hold of. */
export type ClipEdge = 'start' | 'end';

export interface PlacedClip {
  clip: Clip;
  startMs: number;
  endMs: number;
}

export type Selection =
  | { kind: 'none' }
  | { kind: 'clip'; clipId: string }
  | { kind: 'cut'; afterClipId: string; beforeClipId: string }
  | { kind: 'audio'; trackId: string };

export const DEFAULT_PHOTO_DURATION_MS = 5000;
export const DEFAULT_VIDEO_DURATION_MS = 5000;
export const DEFAULT_AUDIO_DURATION_MS = 5000;

/** Used for a cut whose prompt box was left empty — generating must need zero typing. */
export const DEFAULT_TRANSITION_PROMPT = 'Smooth cinematic motion transition';
/**
 * The model decides the real length (DoP takes no duration parameter), so a transition is
 * inserted at this provisional length and probe-corrected once the file's metadata loads.
 */
export const DEFAULT_TRANSITION_DURATION_MS = 5000;

/**
 * Matches `AUDIO_EXTS` in `src-tauri/src/media.rs`. Shared here (not in the store) so the
 * file picker and the classifier read one list without importing each other.
 */
export const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'];

/** A resize floor. Below this there is nothing left to grab, and barely a frame to show. */
export const MIN_CLIP_DURATION_MS = 100;
/**
 * A photo has no source length to run out of, so its only ceiling is a sane one — long
 * enough for any real hold, short enough that a runaway drag cannot make the track useless.
 */
export const MAX_PHOTO_DURATION_MS = 10 * 60 * 1000;
