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
 * What a generation is for: the cut between two adjacent photos, one leg of a
 * three-photo film, or a photo or a video asked for in the media bin. Success routes on
 * this — a cut result is inserted at the cut (or swapped over `replacesClipId` when it is a
 * regeneration of an existing transition clip), a film leg's result is parked in film
 * state until every leg is in, and an image or a video lands in the bin and nowhere else.
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
    }
  | {
      kind: 'image';
      /**
       * The bin photos this one was generated on top of, in the order they were sent.
       * Empty is a plain text-to-image generation. Kept so a retry can re-send exactly
       * what the first attempt did, and dangling ids are simply skipped.
       */
      referenceAssetIds: string[];
      /** The aspect ratio the request carried. */
      aspect: string;
    }
  | {
      /**
       * A video made from words alone, asked for in the media bin.
       *
       * It carries no fields, and that is the honest shape rather than an omission: a
       * prompt-only request has no references and no aspect ratio, and the model a retry
       * must re-send is already on `Generation.modelId`. Notably it has **no clip** on the
       * track either — see `generationDoomed`, where that is what keeps deleting an
       * unrelated asset from cancelling a paid render.
       */
      kind: 'video';
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

/**
 * A photo asked for in the media bin.
 *
 * Its result lands in the bin as an ordinary photo asset and nowhere else — the timeline
 * is never edited on the user's behalf, so a generation finishing mid-edit changes
 * nothing they were working on.
 */
export type ImageGeneration = GenerationOf<'image'>;

/** A video made from a prompt alone — the media bin's other generation. */
export type VideoGeneration = GenerationOf<'video'>;

/**
 * A quarter turn, clockwise, in degrees. Only right angles: a free-angle rotation would
 * have to letterbox its own corners into the frame and there is no honest default for what
 * fills them, while a quarter turn is exactly what a phone clip held the wrong way needs.
 */
export type ClipRotation = 0 | 90 | 180 | 270;

/**
 * The rectangle of the framed picture a crop keeps, in fractions of that frame — `x`/`y`
 * from its top-left corner, `width`/`height` across it. The whole frame is
 * `{ x: 0, y: 0, width: 1, height: 1 }`.
 *
 * Fractions rather than pixels because the thing being cropped is *the picture as the
 * preview shows it*, which is the export frame's shape whatever the source's was — a photo
 * is already cover-cropped to it and a video already letterboxed into it. That keeps one
 * number meaning one thing on both sides of the app, and keeps a crop from having to be
 * re-derived when a source turns out to be a different size than the probe first said.
 */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How a clip is framed: what part of the picture is kept, which way up it stands, and how
 * far into it the frame is pushed.
 *
 * The five operations compose in one fixed order, and it is the same order in the preview's
 * CSS and in the exporter's filter graph — see `lib/transform.ts`, which is the only place
 * that order is written down:
 *
 * 1. **crop** the framed picture to `crop`,
 * 2. **rotate** what is left by `rotation`,
 * 3. **flip** it in screen space (`flipH` then `flipV` — they commute),
 * 4. **fit** the result back into the export frame, black where it does not reach,
 * 5. **zoom** by `zoom` about the centre and **pan** by `offsetX`/`offsetY`.
 *
 * Flips come after the rotation on purpose: the buttons mirror what is on screen, so
 * "flip horizontally" always means left-for-right *as you see it*, never left-for-right in
 * some earlier coordinate system the user cannot see.
 */
export interface ClipTransform {
  crop: CropRect;
  /** 1 shows the whole frame; above that the frame is pushed into the picture. */
  zoom: number;
  /**
   * Which part of the zoomed picture is centred, as a fraction of the overflow the zoom
   * created: `0` is the middle, `-1` the left/top edge, `+1` the right/bottom.
   *
   * Expressed against the overflow rather than in pixels so it cannot fall out of range:
   * at zoom 1 there is no overflow and every offset is the same picture, and a zoom
   * *out* of a pan the user set keeps that pan proportionally rather than jumping.
   */
  offsetX: number;
  offsetY: number;
  rotation: ClipRotation;
  flipH: boolean;
  flipV: boolean;
}

/** The whole frame, the right way up, unmirrored — what a clip is framed as until it is not. */
export const IDENTITY_TRANSFORM: ClipTransform = {
  crop: { x: 0, y: 0, width: 1, height: 1 },
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  flipH: false,
  flipV: false,
};

/** Zoom's ends. 1 is the whole frame — there is no zooming *out* of a frame that is the film. */
export const MIN_CLIP_ZOOM = 1;
export const MAX_CLIP_ZOOM = 4;

/**
 * The smallest a crop rectangle may get, as a fraction of the frame. Small enough for a
 * real punch-in, large enough that the handles never overlap each other and that what
 * survives is still a picture rather than a few upscaled pixels.
 */
export const MIN_CROP_FRACTION = 0.05;

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
  /**
   * How the clip is framed — crop, zoom, rotation, flips. Absent means
   * `IDENTITY_TRANSFORM`, which is what every clip that has never been reframed is and what
   * every project written before there was such a thing holds: the field is only ever
   * written once a user has moved one of its controls, so an untouched project file gains
   * nothing to read back.
   */
  transform?: ClipTransform;
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

/**
 * How far the timeline zooms, in pixels per second — the ends of the zoom slider.
 *
 * Shared with the saved project rather than left as literals on the slider: a stored zoom
 * is read back off a hand-editable file, and one outside this range would draw a timeline
 * the control that produced it cannot represent.
 */
export const MIN_PX_PER_SECOND = 12;
export const MAX_PX_PER_SECOND = 160;
/** 100% on the zoom readout, and what a project with no stored zoom opens at. */
export const DEFAULT_PX_PER_SECOND = 46;
