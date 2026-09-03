import { describe, expect, it } from 'vitest';
import {
  FULL_CROP,
  clipTransform,
  croppingTransform,
  dragCrop,
  isIdentityTransform,
  normalizeCrop,
  normalizeTransform,
  previewGeometry,
  withCrop,
  withFlip,
  withRotation,
  withZoom,
} from './transform';
import {
  IDENTITY_TRANSFORM,
  MAX_CLIP_ZOOM,
  MIN_CROP_FRACTION,
  type ClipTransform,
} from '../types/project';
import { aspectValue } from './aspect';

const identity = IDENTITY_TRANSFORM;

/** The frame the geometry below is worked out in, unless a test says otherwise. */
const WIDE = aspectValue('16:9');
const TALL = aspectValue('9:16');

describe('clipTransform', () => {
  it('reads an absent transform as the identity', () => {
    expect(clipTransform({})).toEqual(identity);
    expect(isIdentityTransform(clipTransform({}))).toBe(true);
  });

  it('reads the one the clip carries', () => {
    const t = withZoom(identity, 2);
    expect(clipTransform({ transform: t })).toBe(t);
  });
});

describe('normalizeTransform', () => {
  it('is the identity for nothing at all', () => {
    expect(normalizeTransform(undefined)).toEqual(identity);
    expect(normalizeTransform(null)).toEqual(identity);
  });

  it('clamps a zoom to the slider it came from', () => {
    expect(normalizeTransform({ zoom: 99 }).zoom).toBe(MAX_CLIP_ZOOM);
    expect(normalizeTransform({ zoom: 0.1 }).zoom).toBe(1);
    expect(normalizeTransform({ zoom: Number.NaN }).zoom).toBe(1);
    expect(normalizeTransform({ zoom: Number.POSITIVE_INFINITY }).zoom).toBe(1);
  });

  it('clamps a pan to the overhang it is a fraction of', () => {
    expect(normalizeTransform({ offsetX: 4, offsetY: -4 })).toMatchObject({
      offsetX: 1,
      offsetY: -1,
    });
  });

  it('refuses a rotation that is not a right angle', () => {
    expect(normalizeTransform({ rotation: 45 as never }).rotation).toBe(0);
    expect(normalizeTransform({ rotation: 270 }).rotation).toBe(270);
  });

  it('takes only true for a flip', () => {
    expect(normalizeTransform({ flipH: 'yes' as never }).flipH).toBe(false);
    expect(normalizeTransform({ flipV: true }).flipV).toBe(true);
  });
});

describe('normalizeCrop', () => {
  it('is the whole picture for nothing at all', () => {
    expect(normalizeCrop(undefined)).toEqual(FULL_CROP);
  });

  it('holds a crop to the smallest one there is', () => {
    expect(normalizeCrop({ x: 0, y: 0, width: 0, height: -1 })).toMatchObject({
      width: MIN_CROP_FRACTION,
      height: MIN_CROP_FRACTION,
    });
  });

  it('pulls a rectangle that hangs off the edge back inside', () => {
    expect(normalizeCrop({ x: 0.9, y: 0.8, width: 0.5, height: 0.5 })).toEqual({
      x: 0.5,
      y: 0.5,
      width: 0.5,
      height: 0.5,
    });
  });

  it('sizes before it positions, so an oversized crop is not parked off screen', () => {
    expect(normalizeCrop({ x: 0.5, y: 0.5, width: 2, height: 2 })).toEqual(FULL_CROP);
  });
});

describe('withRotation', () => {
  it('turns clockwise and wraps at the fourth turn', () => {
    expect(withRotation(identity, 1).rotation).toBe(90);
    expect(withRotation(withRotation(identity, 1), 1).rotation).toBe(180);
    expect(withRotation(identity, 4)).toBe(identity);
    expect(withRotation(identity, -1).rotation).toBe(270);
  });

  it('carries the crop rectangle round with the picture', () => {
    // The top-left quarter is at the top-right once the picture has turned clockwise.
    const cropped = withCrop(identity, { x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(withRotation(cropped, 1).crop).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
  });

  it('brings a crop back where it started after four turns', () => {
    const cropped = withCrop(identity, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
    expect(withRotation(cropped, 4).crop).toEqual(cropped.crop);
  });

  it('carries the pan round too, so a punch-in stays on its subject', () => {
    const panned = { ...withZoom(identity, 2), offsetX: 0, offsetY: -1 };
    expect(withRotation(panned, 1)).toMatchObject({ offsetX: 1, offsetY: 0 });
  });
});

describe('withFlip', () => {
  it('mirrors, and mirrors back', () => {
    expect(withFlip(identity, 'h').flipH).toBe(true);
    expect(withFlip(withFlip(identity, 'h'), 'h')).toEqual(identity);
    expect(withFlip(identity, 'v').flipV).toBe(true);
  });

  it('mirrors the crop rectangle with the picture', () => {
    const cropped = withCrop(identity, { x: 0, y: 0.25, width: 0.25, height: 0.5 });
    expect(withFlip(cropped, 'h').crop).toEqual({ x: 0.75, y: 0.25, width: 0.25, height: 0.5 });
    expect(withFlip(cropped, 'v').crop).toEqual({ x: 0, y: 0.25, width: 0.25, height: 0.5 });
  });

  it('mirrors the pan on the axis it flipped and leaves the other alone', () => {
    const panned = { ...withZoom(identity, 2), offsetX: 0.5, offsetY: 0.25 };
    expect(withFlip(panned, 'h')).toMatchObject({ offsetX: -0.5, offsetY: 0.25 });
    expect(withFlip(panned, 'v')).toMatchObject({ offsetX: 0.5, offsetY: -0.25 });
  });
});

describe('isIdentityTransform', () => {
  it('is true only when nothing has been asked for', () => {
    expect(isIdentityTransform(identity)).toBe(true);
    expect(isIdentityTransform(withZoom(identity, 1.5))).toBe(false);
    expect(isIdentityTransform(withFlip(identity, 'v'))).toBe(false);
    expect(isIdentityTransform(withRotation(identity, 2))).toBe(false);
    expect(isIdentityTransform(withCrop(identity, { width: 0.5 }))).toBe(false);
  });
});

describe('previewGeometry', () => {
  it('draws an untransformed clip as the plain frame, with no transforms at all', () => {
    const geo = previewGeometry(identity, WIDE);
    expect(geo.zoom.transform).toBeUndefined();
    expect(geo.pic.transform).toBeUndefined();
    expect(geo.fit).toEqual({ width: '100%', height: '100%', left: '0%', top: '0%' });
    expect(geo.rot).toEqual({ width: '100%', height: '100%', left: '0%', top: '0%' });
    expect(geo.pic).toMatchObject({ width: '100%', height: '100%', left: '0%', top: '0%' });
  });

  it('scales about the centre and pans by the overhang the zoom made', () => {
    const geo = previewGeometry({ ...identity, zoom: 2, offsetX: 1, offsetY: -1 }, WIDE);
    // At 2× the picture overhangs the frame by half its width on each side; +1 gives the
    // whole right-hand overhang up, which means moving the picture left by it.
    expect(geo.zoom.transform).toBe('translate(-50%, 50%) scale(2)');
  });

  it('turns and mirrors the picture layer, rotation first', () => {
    const geo = previewGeometry({ ...identity, rotation: 90, flipH: true }, WIDE);
    expect(geo.pic.transform).toBe('scale(-1, 1) rotate(90deg)');
  });

  it('pillarboxes a quarter turn rather than stretching it', () => {
    const geo = previewGeometry({ ...identity, rotation: 90 }, WIDE);
    // A 16:9 frame stood on end is 9:16, which fits the frame by its height and is
    // pillarboxed into the middle of it.
    expect(geo.fit).toEqual({
      width: '31.640625%',
      height: '100%',
      left: '34.179688%',
      top: '0%',
    });
    // The unturned picture, measured against the box it turns inside — wider than that box,
    // so its offset is negative and auto margins would have parked it against the left.
    expect(geo.pic).toMatchObject({
      width: '177.777778%',
      height: '56.25%',
      left: '-38.888889%',
      top: '21.875%',
    });
  });

  it('blows a crop up to fill the frame and hangs the picture off it', () => {
    const geo = previewGeometry(
      withCrop(identity, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }),
      WIDE,
    );
    // Half by half of a 16:9 picture is still 16:9, so it fills the frame exactly.
    expect(geo.fit).toEqual({ width: '100%', height: '100%', left: '0%', top: '0%' });
    expect(geo.rot).toEqual({ width: '200%', height: '200%', left: '-50%', top: '-50%' });
  });

  it('letterboxes a crop whose shape the frame does not have', () => {
    const geo = previewGeometry(withCrop(identity, { x: 0, y: 0, width: 0.5, height: 1 }), WIDE);
    // 8:9 is taller than the frame, so it fits by its height and leaves black either side.
    expect(geo.fit.height).toBe('100%');
    expect(geo.fit.width).toBe('50%');
  });

  /**
   * The frame's shape is the project's, not this module's. A quarter turn in a vertical
   * project is the mirror image of one in a wide project — letterboxed above and below
   * rather than pillarboxed left and right — and getting that from the same code is the
   * whole reason `previewGeometry` is handed the aspect instead of assuming one.
   */
  it('follows the project\'s frame rather than assuming a wide one', () => {
    const turned = previewGeometry({ ...identity, rotation: 90 }, TALL);
    expect(turned.fit).toEqual({
      width: '100%',
      height: '31.640625%',
      left: '0%',
      top: '34.179688%',
    });

    // And an untouched clip is still the whole frame, whatever shape the frame is.
    for (const id of ['16:9', '9:16', '1:1', '4:5', '21:9']) {
      const geo = previewGeometry(identity, aspectValue(id));
      expect(geo.fit).toEqual({ width: '100%', height: '100%', left: '0%', top: '0%' });
      expect(geo.pic.transform).toBeUndefined();
    }
  });
});

describe('croppingTransform', () => {
  it('stands the crop and the zoom down so the whole picture is reachable', () => {
    const t: ClipTransform = {
      crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      zoom: 3,
      offsetX: 1,
      offsetY: 1,
      rotation: 90,
      flipH: true,
      flipV: false,
    };
    expect(croppingTransform(t)).toEqual({
      crop: FULL_CROP,
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
      rotation: 90,
      flipH: true,
      flipV: false,
    });
  });
});

describe('dragCrop', () => {
  const half = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };

  it('slides the whole rectangle without resizing it', () => {
    expect(dragCrop(half, 'move', 0.1, -0.1)).toEqual({
      x: 0.35,
      y: 0.15,
      width: 0.5,
      height: 0.5,
    });
  });

  it('parks a slide at the picture edge rather than off it', () => {
    expect(dragCrop(half, 'move', 5, -5)).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
  });

  it('moves the two edges a corner owns and leaves the opposite ones', () => {
    expect(dragCrop(half, 'nw', 0.1, 0.1)).toEqual({
      x: 0.35,
      y: 0.35,
      width: 0.4,
      height: 0.4,
    });
    expect(dragCrop(half, 'se', -0.1, -0.1)).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.4,
      height: 0.4,
    });
  });

  it('stops a corner at the smallest crop rather than turning the rectangle inside out', () => {
    const pinched = dragCrop(half, 'nw', 5, 5);
    expect(pinched).toEqual({
      x: 0.75 - MIN_CROP_FRACTION,
      y: 0.75 - MIN_CROP_FRACTION,
      width: MIN_CROP_FRACTION,
      height: MIN_CROP_FRACTION,
    });
    expect(dragCrop(half, 'se', -5, -5)).toMatchObject({
      x: 0.25,
      y: 0.25,
      width: MIN_CROP_FRACTION,
      height: MIN_CROP_FRACTION,
    });
  });

  it('stops a corner at the picture edge', () => {
    expect(dragCrop(half, 'ne', 5, -5)).toEqual({ x: 0.25, y: 0, width: 0.75, height: 0.75 });
  });
});
