/**
 * The shape of the project's frame.
 *
 * One ratio belongs to the whole project rather than to a clip: the frame is what the
 * preview draws, what the export writes, and what an AI transition is generated into, and
 * three different answers to "what shape is this video" is how a vertical export ends up
 * with a horizontal transition sitting in the middle of it.
 *
 * Pure, like `timeline.ts` and `film.ts` — no React, no Tauri — so the pixel maths below is
 * a unit test rather than an export you have to watch finish.
 */

export interface AspectRatio {
  /** `w:h` — what the store holds, what the project file stores, and what the menu shows. */
  id: string;
  /** What the shape is *for*, since `4:5` alone tells most people nothing. */
  label: string;
  w: number;
  h: number;
}

/**
 * The ratios offered, in menu order: the two everything is actually delivered in first,
 * then square, then the rest.
 *
 * A closed list rather than a free-text field, because every entry has to survive being
 * read back off a hand-editable project file and turned into an even pixel size that H.264
 * will accept. `3:2` is here under its own name; `9:6` is the same shape.
 */
export const ASPECT_RATIOS: readonly AspectRatio[] = [
  { id: '16:9', label: 'Widescreen', w: 16, h: 9 },
  { id: '9:16', label: 'Vertical', w: 9, h: 16 },
  { id: '1:1', label: 'Square', w: 1, h: 1 },
  { id: '4:5', label: 'Portrait', w: 4, h: 5 },
  { id: '4:3', label: 'Classic', w: 4, h: 3 },
  { id: '3:2', label: 'Photo', w: 3, h: 2 },
  { id: '21:9', label: 'Cinemascope', w: 21, h: 9 },
];

/** What a project opens at, and what every project written before this setting existed is. */
export const DEFAULT_ASPECT_RATIO = '16:9';

/**
 * The frame's short edge, in pixels — 1080 whichever way up the frame stands.
 *
 * Anchoring the *short* edge is what makes the setting feel like turning the camera rather
 * than resizing the picture: 16:9 stays exactly the 1920×1080 every existing project
 * exports at, and 9:16 comes out 1080×1920 rather than a 607-line letterbox.
 */
export const EXPORT_SHORT_EDGE = 1080;

/**
 * The short edge of an anchor still handed to Higgsfield.
 *
 * Smaller than the export on purpose — it is a frame to animate from, not footage — and
 * 720 is what keeps 16:9 at exactly the 1280×720 stills this app has always sent.
 */
export const STILL_SHORT_EDGE = 720;

export interface FrameSize {
  width: number;
  height: number;
}

/** Whether `id` names a ratio this build offers. */
export function isAspectRatio(id: string): boolean {
  return ASPECT_RATIOS.some((a) => a.id === id);
}

/**
 * The ratio `id` names, or the default.
 *
 * Never throws and never returns undefined: the id arrives from a project file a user can
 * edit by hand, and a frame is needed to draw anything at all.
 */
export function aspectRatio(id: string): AspectRatio {
  return ASPECT_RATIOS.find((a) => a.id === id) ?? ASPECT_RATIOS[0];
}

/** How many times wider than tall the frame is — what the preview's `aspect-ratio` takes. */
export function aspectValue(id: string): number {
  const { w, h } = aspectRatio(id);
  return w / h;
}

/**
 * The pixel frame a ratio means: the short edge held at `shortEdge`, the long edge derived.
 *
 * Both edges come back **even**. That is not tidiness: the export encodes `yuv420p`, whose
 * chroma planes are half resolution, and an odd dimension there is an ffmpeg error rather
 * than a rounded-off pixel.
 */
export function frameSize(id: string, shortEdge = EXPORT_SHORT_EDGE): FrameSize {
  const { w, h } = aspectRatio(id);
  const short = even(shortEdge);
  const long = even((short * Math.max(w, h)) / Math.min(w, h));
  return w >= h ? { width: long, height: short } : { width: short, height: long };
}

/** The still an AI transition is generated from — the same shape as the frame, smaller. */
export function stillSize(id: string): FrameSize {
  return frameSize(id, STILL_SHORT_EDGE);
}

function even(px: number): number {
  return Math.max(2, Math.round(px / 2) * 2);
}
