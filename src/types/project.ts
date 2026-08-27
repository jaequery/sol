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

export interface Generation {
  id: string;
  clipId: string;
  fromKeyframeId: string;
  toKeyframeId: string;
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
