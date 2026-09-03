import { describe, expect, it } from 'vitest';
import {
  ASPECT_RATIOS,
  DEFAULT_ASPECT_RATIO,
  aspectRatio,
  aspectValue,
  frameSize,
  isAspectRatio,
  stillSize,
} from './aspect';

describe('the ratios on offer', () => {
  it('opens on 16:9, and offers it', () => {
    expect(ASPECT_RATIOS[0].id).toBe(DEFAULT_ASPECT_RATIO);
    expect(isAspectRatio(DEFAULT_ASPECT_RATIO)).toBe(true);
  });

  it('covers both readings of the ticket’s “9:6” — the 3:2 it reduces to, and 9:16', () => {
    expect(isAspectRatio('3:2')).toBe(true);
    expect(isAspectRatio('9:16')).toBe(true);
    // And the other example, verbatim.
    expect(isAspectRatio('4:5')).toBe(true);
  });

  it('names every ratio once, and every one has a label a person can read', () => {
    const ids = ASPECT_RATIOS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ASPECT_RATIOS) {
      expect(a.id).toBe(`${a.w}:${a.h}`);
      expect(a.label.length).toBeGreaterThan(0);
    }
  });

  it('falls back rather than throwing on an id a hand-edited file invented', () => {
    expect(isAspectRatio('7:3')).toBe(false);
    expect(aspectRatio('7:3').id).toBe(DEFAULT_ASPECT_RATIO);
    expect(aspectRatio('').id).toBe(DEFAULT_ASPECT_RATIO);
    expect(frameSize('nonsense')).toEqual({ width: 1920, height: 1080 });
  });
});

describe('the pixel frame a ratio means', () => {
  it('leaves 16:9 at exactly what every project has always exported', () => {
    expect(frameSize('16:9')).toEqual({ width: 1920, height: 1080 });
  });

  it('turns the frame on its side rather than shrinking it', () => {
    expect(frameSize('9:16')).toEqual({ width: 1080, height: 1920 });
    expect(frameSize('4:5')).toEqual({ width: 1080, height: 1350 });
    expect(frameSize('1:1')).toEqual({ width: 1080, height: 1080 });
    expect(frameSize('4:3')).toEqual({ width: 1440, height: 1080 });
    expect(frameSize('3:2')).toEqual({ width: 1620, height: 1080 });
    expect(frameSize('21:9')).toEqual({ width: 2520, height: 1080 });
  });

  it('holds the short edge at 1080 whichever way up the frame stands', () => {
    for (const a of ASPECT_RATIOS) {
      const { width, height } = frameSize(a.id);
      expect(Math.min(width, height)).toBe(1080);
    }
  });

  it('gives every frame even edges, because yuv420p refuses an odd one', () => {
    for (const a of ASPECT_RATIOS) {
      for (const size of [frameSize(a.id), stillSize(a.id)]) {
        expect(size.width % 2).toBe(0);
        expect(size.height % 2).toBe(0);
      }
    }
  });

  it('keeps the drawn frame within a rounded pixel of the ratio it names', () => {
    for (const a of ASPECT_RATIOS) {
      const { width, height } = frameSize(a.id);
      expect(width / height).toBeCloseTo(a.w / a.h, 2);
      expect(aspectValue(a.id)).toBeCloseTo(a.w / a.h, 6);
    }
  });
});

describe('the still an AI transition is generated from', () => {
  it('leaves 16:9 at the 1280×720 this app has always sent', () => {
    expect(stillSize('16:9')).toEqual({ width: 1280, height: 720 });
  });

  it('is the frame’s own shape, so the two ends of one motion are framed alike', () => {
    expect(stillSize('9:16')).toEqual({ width: 720, height: 1280 });
    expect(stillSize('4:5')).toEqual({ width: 720, height: 900 });
    expect(stillSize('3:2')).toEqual({ width: 1080, height: 720 });
    for (const a of ASPECT_RATIOS) {
      const still = stillSize(a.id);
      const frame = frameSize(a.id);
      expect(still.width / still.height).toBeCloseTo(frame.width / frame.height, 2);
    }
  });

  it('is smaller than the export frame — it is a frame to animate from, not footage', () => {
    for (const a of ASPECT_RATIOS) {
      expect(stillSize(a.id).width).toBeLessThan(frameSize(a.id).width);
    }
  });
});
