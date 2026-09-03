/**
 * How a clip is framed, as maths.
 *
 * A clip carries a `ClipTransform` — a crop rectangle, a quarter turn, two flips, and a
 * zoom with a pan. Two very different renderers have to agree about what that means: the
 * preview, which is CSS on a stack of divs, and the export, which is an ffmpeg filter
 * graph in `src-tauri/crates/render`. This module is the one place the order of operations
 * is written down, and the only place the preview's geometry is worked out — pure, like
 * `timeline.ts` and `project.ts`, so every rule below is a unit test rather than a click.
 *
 * **The order, once:** rotate → flip → crop → fit → zoom + pan.
 *
 * - **rotate/flip first** so everything after is in the coordinates the user is looking at.
 *   "Flip horizontally" then means left-for-right *on screen* whatever the rotation is, and
 *   a crop rectangle dragged over a sideways clip is a rectangle of what they can see.
 * - **fit** puts the cropped picture back inside the export frame without stretching it, so
 *   a crop of a shape the frame does not have — or a quarter turn, which is always one —
 *   sits on black rather than being squashed into 16:9.
 * - **zoom last**, on the composed frame, so the number means the same thing whatever is
 *   under it: 2× is twice as close, black bars and all.
 *
 * The thing being transformed is **the framed picture**: the source already fitted to the
 * export frame — a photo cover-cropped to it, a video letterboxed into it, exactly as
 * `photo_filter` and `video_filter` do it and exactly as the preview shows it. So a crop is
 * a fraction of a 16:9 picture on both sides of the app, and no part of this has to know
 * how many pixels the source file happened to have.
 */

import {
  IDENTITY_TRANSFORM,
  MAX_CLIP_ZOOM,
  MIN_CLIP_ZOOM,
  MIN_CROP_FRACTION,
  type Clip,
  type ClipRotation,
  type ClipTransform,
  type CropRect,
} from '../types/project';

/** The export frame's shape, and the preview canvas's. 1920×1080, and `.canvas` in the CSS. */
export const FRAME_ASPECT = 16 / 9;

/** The whole picture — what `crop` is until something narrows it. */
export const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/** How the transform a clip is drawn with is read: absent is the identity, never a null check. */
export function clipTransform(clip: Pick<Clip, 'transform'>): ClipTransform {
  return clip.transform ?? IDENTITY_TRANSFORM;
}

const ROTATIONS: ClipRotation[] = [0, 90, 180, 270];

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Rounded to a place where a float's last bits cannot show up in a CSS string or a filter. */
function tidy(v: number): number {
  const rounded = Math.round(v * 1e6) / 1e6;
  // A negated zero is still zero — and it is not the identity's `0` to anything comparing
  // with `Object.is`, which is what decides whether a clip is stored as reframed.
  return rounded === 0 ? 0 : rounded;
}

/**
 * A transform that can be trusted: every number in range, every rectangle inside the
 * picture, and the rotation one of the four there are.
 *
 * Everything that produces a transform goes through here — the store's actions, the
 * project reader, and the readers on the far side of a hand-edited file — so no other code
 * has to defend itself against a crop of negative width or a zoom of `Infinity`.
 */
export function normalizeTransform(raw: Partial<ClipTransform> | undefined | null): ClipTransform {
  if (!raw) return IDENTITY_TRANSFORM;
  return {
    crop: normalizeCrop(raw.crop),
    zoom: tidy(clamp(finite(raw.zoom, 1), MIN_CLIP_ZOOM, MAX_CLIP_ZOOM)),
    offsetX: tidy(clamp(finite(raw.offsetX, 0), -1, 1)),
    offsetY: tidy(clamp(finite(raw.offsetY, 0), -1, 1)),
    rotation: ROTATIONS.includes(raw.rotation as ClipRotation) ? (raw.rotation as ClipRotation) : 0,
    flipH: raw.flipH === true,
    flipV: raw.flipV === true,
  };
}

function finite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * A crop rectangle pulled back inside the picture.
 *
 * Width and height are clamped before the offsets, because it is the size that decides how
 * far the rectangle can travel: a crop wider than the picture would otherwise be dragged to
 * a position that shows nothing at all.
 */
export function normalizeCrop(raw: Partial<CropRect> | undefined | null): CropRect {
  if (!raw) return FULL_CROP;
  const width = clamp(finite(raw.width, 1), MIN_CROP_FRACTION, 1);
  const height = clamp(finite(raw.height, 1), MIN_CROP_FRACTION, 1);
  return {
    x: tidy(clamp(finite(raw.x, 0), 0, 1 - width)),
    y: tidy(clamp(finite(raw.y, 0), 0, 1 - height)),
    width: tidy(width),
    height: tidy(height),
  };
}

/** Whether a transform asks for anything at all — the test every renderer's fast path uses. */
export function isIdentityTransform(t: ClipTransform): boolean {
  return (
    t.zoom === 1 &&
    t.offsetX === 0 &&
    t.offsetY === 0 &&
    t.rotation === 0 &&
    !t.flipH &&
    !t.flipV &&
    isFullCrop(t.crop)
  );
}

export function isFullCrop(crop: CropRect): boolean {
  return crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;
}

/**
 * Turn a clip by `quarterTurns` right angles — positive clockwise.
 *
 * The crop and the pan turn with it, and that is the point: a rectangle the user drew over
 * what they could see must still cover the same part of the picture once the picture is
 * sideways, and a punch-in on somebody's face must not slide off it. Crop coordinates live
 * in the rotated picture's space (see the order at the top), so turning the picture means
 * turning both of those the same way inside it.
 */
export function withRotation(t: ClipTransform, quarterTurns: number): ClipTransform {
  const turns = ((Math.round(quarterTurns) % 4) + 4) % 4;
  if (turns === 0) return t;
  let crop = t.crop;
  let offsetX = t.offsetX;
  let offsetY = t.offsetY;
  for (let i = 0; i < turns; i += 1) {
    crop = rotateCropOnce(crop);
    // What was at the top of the picture is at its right once it has turned.
    [offsetX, offsetY] = [tidy(-offsetY), tidy(offsetX)];
  }
  return {
    ...t,
    crop,
    offsetX,
    offsetY,
    rotation: ROTATIONS[(ROTATIONS.indexOf(t.rotation) + turns) % 4],
  };
}

/** One clockwise quarter turn of a rectangle inside the unit square it sits in. */
function rotateCropOnce(crop: CropRect): CropRect {
  return {
    x: tidy(1 - crop.y - crop.height),
    y: tidy(crop.x),
    width: tidy(crop.height),
    height: tidy(crop.width),
  };
}

/**
 * Mirror a clip along one axis, carrying the crop across with it for the same reason a
 * rotation carries it: the rectangle stays over the part of the picture it was drawn over.
 */
export function withFlip(t: ClipTransform, axis: 'h' | 'v'): ClipTransform {
  const crop =
    axis === 'h'
      ? { ...t.crop, x: tidy(1 - t.crop.x - t.crop.width) }
      : { ...t.crop, y: tidy(1 - t.crop.y - t.crop.height) };
  return axis === 'h'
    ? { ...t, crop, flipH: !t.flipH, offsetX: tidy(-t.offsetX) }
    : { ...t, crop, flipV: !t.flipV, offsetY: tidy(-t.offsetY) };
}

export function withZoom(t: ClipTransform, zoom: number): ClipTransform {
  return normalizeTransform({ ...t, zoom });
}

export function withPan(t: ClipTransform, offsetX: number, offsetY: number): ClipTransform {
  return normalizeTransform({ ...t, offsetX, offsetY });
}

export function withCrop(t: ClipTransform, crop: Partial<CropRect>): ClipTransform {
  return normalizeTransform({ ...t, crop: { ...t.crop, ...crop } });
}

// ------------------------------------------------------------------ preview geometry

/** One layer's inline style. Strings, because that is what lands in the DOM and in a test. */
export type LayerStyle = {
  width?: string;
  height?: string;
  left?: string;
  top?: string;
  transform?: string;
};

/**
 * The four layers the preview draws a transformed clip with, outermost first.
 *
 * - **zoom** covers the frame and carries the zoom and the pan. The frame clips it.
 * - **fit** is the cropped picture at the size it fits the frame at, centred, and it clips
 *   the crop.
 * - **rot** is the whole rotated picture, positioned so its crop rectangle lands exactly
 *   over `fit`.
 * - **pic** is the picture before it was turned: centred inside `rot` and carrying the
 *   rotation and the flips, with the media element filling it.
 *
 * Every one of them is placed by an explicit `left`/`top` rather than by `margin: auto`,
 * and that is load-bearing on the innermost: a layer wider than the box it sits in — which
 * `pic` always is once the picture is on its side — is exactly the case where CSS gives up
 * on auto margins and pins the element to the left instead of centring it.
 */
export interface PreviewGeometry {
  zoom: LayerStyle;
  fit: LayerStyle;
  rot: LayerStyle;
  pic: LayerStyle;
}

function pct(v: number): string {
  return `${tidy(v * 100)}%`;
}

/** A box of this size, in the middle of the one above it. Negative offsets and all. */
function centred(width: number, height: number): LayerStyle {
  return {
    width: pct(width),
    height: pct(height),
    left: pct((1 - width) / 2),
    top: pct((1 - height) / 2),
  };
}

/**
 * Where each of the four layers goes, for one transform, in a frame of the given shape.
 *
 * Everything is a percentage of the layer above, so none of this needs to know how many
 * pixels the canvas is on screen — the same numbers are right on a laptop and on a 5K
 * display, and right in a test where nothing has been laid out at all.
 */
export function previewGeometry(t: ClipTransform, frameAspect = FRAME_ASPECT): PreviewGeometry {
  const turned = t.rotation === 90 || t.rotation === 270;
  // The rotated picture, in frame heights: the frame itself, or the frame on its side.
  const rotW = turned ? 1 : frameAspect;
  const rotH = turned ? frameAspect : 1;

  // The crop, and the largest copy of it that fits the frame without being stretched.
  const cropAspect = (t.crop.width * rotW) / (t.crop.height * rotH);
  const fitW = cropAspect >= frameAspect ? 1 : cropAspect / frameAspect;
  const fitH = cropAspect >= frameAspect ? frameAspect / cropAspect : 1;

  // Zoom is about the centre, so the picture overhangs the frame by half the growth on
  // each side; the pan says which of that overhang is given up. Negated because moving the
  // picture left is what brings its right-hand side into view.
  const overhang = (t.zoom - 1) / 2;

  const flipX = t.flipH ? -1 : 1;
  const flipY = t.flipV ? -1 : 1;

  return {
    zoom: {
      transform:
        t.zoom === 1 && t.offsetX === 0 && t.offsetY === 0
          ? undefined
          : `translate(${pct(-t.offsetX * overhang)}, ${pct(-t.offsetY * overhang)}) scale(${tidy(t.zoom)})`,
    },
    fit: centred(fitW, fitH),
    rot: {
      width: pct(1 / t.crop.width),
      height: pct(1 / t.crop.height),
      left: pct(-t.crop.x / t.crop.width),
      top: pct(-t.crop.y / t.crop.height),
    },
    pic: {
      // The unturned picture, measured against the turned box that holds it.
      ...centred(frameAspect / rotW, 1 / rotH),
      transform:
        t.rotation === 0 && !t.flipH && !t.flipV
          ? undefined
          : `scale(${flipX}, ${flipY}) rotate(${t.rotation}deg)`,
    },
  };
}

/**
 * What the preview shows while the crop rectangle is being dragged: the whole picture, the
 * right way up for the user, and no zoom.
 *
 * The crop and the zoom are the two things that would hide the part of the picture the user
 * is reaching for, so both stand down for as long as the tool is open. The rotation and the
 * flips stay, because the rectangle is dragged in the coordinates they produce.
 */
export function croppingTransform(t: ClipTransform): ClipTransform {
  return { ...t, crop: FULL_CROP, zoom: 1, offsetX: 0, offsetY: 0 };
}

/** Which part of the crop rectangle a drag has hold of. */
export type CropHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

/**
 * The rectangle a crop drag has arrived at: `dx`/`dy` are how far the pointer has moved as
 * a fraction of the picture it is being dragged over.
 *
 * A corner moves its own two edges and leaves the opposite ones where they are, stopping at
 * the picture's edge and at the smallest crop there is — so an over-eager drag parks the
 * corner rather than turning the rectangle inside out. **move** slides the whole rectangle
 * and keeps its size, which is what makes a punch-in repositionable without redrawing it.
 */
export function dragCrop(start: CropRect, handle: CropHandle, dx: number, dy: number): CropRect {
  if (handle === 'move') {
    return {
      x: tidy(clamp(start.x + dx, 0, 1 - start.width)),
      y: tidy(clamp(start.y + dy, 0, 1 - start.height)),
      width: start.width,
      height: start.height,
    };
  }

  const west = handle === 'nw' || handle === 'sw';
  const north = handle === 'nw' || handle === 'ne';
  const right = start.x + start.width;
  const bottom = start.y + start.height;

  let { x, y } = start;
  let width: number;
  let height: number;

  if (west) {
    x = clamp(start.x + dx, 0, right - MIN_CROP_FRACTION);
    width = right - x;
  } else {
    width = clamp(start.width + dx, MIN_CROP_FRACTION, 1 - start.x);
  }
  if (north) {
    y = clamp(start.y + dy, 0, bottom - MIN_CROP_FRACTION);
    height = bottom - y;
  } else {
    height = clamp(start.height + dy, MIN_CROP_FRACTION, 1 - start.y);
  }

  return { x: tidy(x), y: tidy(y), width: tidy(width), height: tidy(height) };
}
