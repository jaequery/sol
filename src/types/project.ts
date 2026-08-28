/** The editor's data model. One track, clips laid end to end in order. */

export type MediaKind = 'photo' | 'video';

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
 * A photo's 2D framing. `x`/`y` are percentages of the canvas so they survive a change of
 * export resolution; `scale` is a multiple of "cover the frame".
 */
export interface Transform2D {
  scale: number;
  x: number;
  y: number;
  rotation: number;
  opacity: number;
}

export interface Keyframe {
  id: string;
  /** Milliseconds from the start of the clip. */
  timeMs: number;
  transform: Transform2D;
}

export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface GenerationError {
  title: string;
  message: string;
  retryable: boolean;
}

/** What every generation carries, whatever it was asked to animate between. */
interface GenerationBase {
  id: string;
  prompt: string;
  status: GenerationStatus;
  /** 0..1 */
  progress: number;
  jobId?: string;
  elapsedSecs: number;
  slow: boolean;
  outputPath?: string;
  error?: GenerationError;
}

/**
 * Motion between two keyframes of one photo. The result replaces that segment on the
 * timeline the moment it lands.
 */
export interface SegmentGeneration extends GenerationBase {
  kind: 'segment';
  clipId: string;
  fromKeyframeId: string;
  toKeyframeId: string;
}

/**
 * A transition between two *different* photos — one leg of a film.
 *
 * Its result is parked in film state rather than dropped on the timeline: a film goes onto
 * the track in one piece, once every leg has succeeded, so a half-finished film never
 * half-edits the project.
 */
export interface FilmGeneration extends GenerationBase {
  kind: 'film';
  startAssetId: string;
  endAssetId: string;
  /** 0 for photo 1 → 2, 1 for photo 2 → 3. Results are keyed by this, never by arrival. */
  filmSegmentIndex: number;
}

export type Generation = SegmentGeneration | FilmGeneration;

export interface Clip {
  id: string;
  assetId: string;
  kind: MediaKind;
  name: string;
  durationMs: number;
  /** Videos only: where playback starts inside the source. */
  trimStartMs: number;
  /** Photos only. Always sorted by `timeMs`. */
  keyframes: Keyframe[];
  /** Prompt for the segment that *starts* at each keyframe, keyed by that keyframe's id. */
  prompts: Record<string, string>;
  /** Present when this clip is a Higgsfield result rather than imported media. */
  ai?: {
    prompt: string;
    sourceAssetId: string;
  };
}

/** Which end of a clip a resize drag has hold of. */
export type ClipEdge = 'start' | 'end';

/** A gap between two consecutive keyframes — the thing a prompt is attached to. */
export interface Segment {
  fromKeyframeId: string;
  toKeyframeId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface PlacedClip {
  clip: Clip;
  startMs: number;
  endMs: number;
}

export type Selection =
  | { kind: 'none' }
  | { kind: 'clip'; clipId: string }
  | { kind: 'keyframe'; clipId: string; keyframeId: string }
  | { kind: 'segment'; clipId: string; fromKeyframeId: string; toKeyframeId: string };

export const IDENTITY_TRANSFORM: Transform2D = {
  scale: 1,
  x: 0,
  y: 0,
  rotation: 0,
  opacity: 1,
};

/** Matches `solcut_render::{MIN_SCALE, MAX_SCALE}` — zoompan cannot zoom out past the frame. */
export const MIN_SCALE = 1;
export const MAX_SCALE = 4;

export const DEFAULT_PHOTO_DURATION_MS = 5000;
export const DEFAULT_VIDEO_DURATION_MS = 5000;

/** A resize floor. Below this there is nothing left to grab, and barely a frame to show. */
export const MIN_CLIP_DURATION_MS = 100;
/**
 * A photo has no source length to run out of, so its only ceiling is a sane one — long
 * enough for any real hold, short enough that a runaway drag cannot make the track useless.
 */
export const MAX_PHOTO_DURATION_MS = 10 * 60 * 1000;
