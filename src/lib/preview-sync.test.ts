import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MediaSync,
  nextPlayheadMs,
  registerMedia,
  resetPreviewSync,
  videoKey,
  videoPoolAt,
  type SyncableMedia,
} from './preview-sync';
import type { Clip } from '../types/project';

/**
 * A media element reduced to what the sync layer touches. `currentTime` records every
 * assignment — a "seek" here — and `advanceTo` plays the role of the media pipeline
 * actually presenting frames.
 */
class FakeMedia implements SyncableMedia {
  readyState = 0;
  ended = false;
  error: unknown = null;
  seeks: number[] = [];
  playCalls = 0;
  pauseCalls = 0;
  private time = 0;
  private listeners = new Map<string, Set<() => void>>();

  get currentTime(): number {
    return this.time;
  }
  set currentTime(t: number) {
    this.time = t;
    this.seeks.push(t);
  }

  /** The pipeline presents a frame at `t`: position moves and `timeupdate` fires. */
  advanceTo(t: number): void {
    this.time = t;
    this.emit('timeupdate');
  }

  play(): Promise<void> {
    this.playCalls += 1;
    return Promise.resolve();
  }
  pause(): void {
    this.pauseCalls += 1;
  }

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

function videoClipAt(startMs: number, durationMs: number, id = 'v1', trimStartMs = 0): Clip {
  return { id, assetId: `asset-${id}`, kind: 'video', name: `${id}.mp4`, startMs, durationMs, trimStartMs };
}

function photoClipAt(startMs: number, durationMs: number, id = 'p1'): Clip {
  return { id, assetId: `asset-${id}`, kind: 'photo', name: `${id}.jpg`, startMs, durationMs, trimStartMs: 0 };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetPreviewSync();
  vi.useRealTimers();
});

describe('MediaSync', () => {
  it('never seeks during steady playback — the seek storm regression', () => {
    const el = new FakeMedia();
    const sync = new MediaSync(el);

    sync.update(0, true);
    // Sixty ticks of the element presenting frames and the derived playhead following.
    for (let i = 1; i <= 60; i++) {
      el.advanceTo(i / 30);
      sync.update(i / 30, true);
    }

    expect(el.seeks).toEqual([]);
    expect(el.playCalls).toBe(1);
    expect(el.pauseCalls).toBe(0);
  });

  it('calls play once per start and pause once per stop, however often updated', () => {
    const el = new FakeMedia();
    const sync = new MediaSync(el);

    sync.update(0, true);
    sync.update(0.1, true);
    sync.update(0.2, true);
    expect(el.playCalls).toBe(1);

    sync.update(0.2, false);
    sync.update(0.2, false);
    sync.deactivate();
    expect(el.pauseCalls).toBe(1);

    sync.update(0.2, true);
    expect(el.playCalls).toBe(2);
  });

  it('seeks once on a real discontinuity and holds further targets until it settles', () => {
    const el = new FakeMedia();
    const sync = new MediaSync(el);
    sync.update(0, true);

    sync.update(5, true); // a scrub
    expect(el.seeks).toEqual([5]);

    // The seek has not settled; bigger and bigger wants must not pile more seeks on.
    sync.update(7, true);
    sync.update(9, true);
    expect(el.seeks).toEqual([5]);

    // It settles — and the latest queued target goes out, once.
    el.emit('seeked');
    expect(el.seeks).toEqual([5, 9]);
  });

  it('treats timeupdate near the target as the seek arriving', () => {
    const el = new FakeMedia();
    const sync = new MediaSync(el);
    sync.update(0, true);

    sync.update(5, true);
    expect(el.seeks).toEqual([5]);

    // `seeked` was swallowed (WebKit abort), but playback resumes at the target anyway.
    el.advanceTo(5.05);
    sync.update(6, true);
    expect(el.seeks).toEqual([5, 6]);
  });

  it('times a pending seek out so a swallowed seeked cannot block seeking forever', () => {
    const el = new FakeMedia();
    const sync = new MediaSync(el);
    sync.update(0, true);

    sync.update(5, true);
    expect(el.seeks).toEqual([5]);

    vi.advanceTimersByTime(1100);
    sync.update(9, true);
    expect(el.seeks).toEqual([5, 9]);
  });

  it('follows the playhead closely while paused, coalescing scrub seeks', () => {
    const el = new FakeMedia();
    const sync = new MediaSync(el);

    sync.update(1, false);
    expect(el.seeks).toEqual([1]);

    // Dragging on: targets pile up behind the pending seek, only the last one lands.
    sync.update(2, false);
    sync.update(3, false);
    el.emit('seeked');
    expect(el.seeks).toEqual([1, 3]);
    expect(el.playCalls).toBe(0);
  });

  it('primes to the in-point once metadata arrives', () => {
    const el = new FakeMedia();
    const sync = new MediaSync(el);

    sync.prime(1.5);
    expect(el.seeks).toEqual([]); // nothing to seek in yet

    el.readyState = 1;
    el.emit('loadedmetadata');
    expect(el.seeks).toEqual([1.5]);
  });

  it('primes immediately when metadata is already there', () => {
    const el = new FakeMedia();
    el.readyState = 1;
    const sync = new MediaSync(el);

    sync.prime(1.5);
    expect(el.seeks).toEqual([1.5]);
  });

  it('is untrusted after ended or error — the wall clock takes over', () => {
    const el = new FakeMedia();
    const sync = new MediaSync(el);
    el.advanceTo(2);
    expect(sync.trustedTimeSec(performance.now())).toBe(2);

    el.ended = true;
    expect(sync.trustedTimeSec(performance.now())).toBeNull();

    el.ended = false;
    el.emit('error');
    expect(sync.trustedTimeSec(performance.now())).toBeNull();
  });

  it('is untrusted after stalling, and trusted again on progress', () => {
    const el = new FakeMedia();
    const sync = new MediaSync(el);
    const t0 = performance.now();

    sync.update(0, true);
    expect(sync.trustedTimeSec(t0)).toBe(0);

    // Wants to play, nothing presented for longer than the watchdog tolerates.
    expect(sync.trustedTimeSec(t0 + 3500)).toBeNull();

    el.advanceTo(0.1);
    expect(sync.trustedTimeSec(performance.now() + 1)).toBe(0.1);
  });

  it('reads a pending seek as its destination, latest queued target first', () => {
    const el = new FakeMedia();
    const sync = new MediaSync(el);
    sync.update(0, true);

    sync.update(5, true);
    expect(sync.trustedTimeSec(performance.now())).toBe(5);

    sync.update(8, true); // queued behind the pending seek
    expect(sync.trustedTimeSec(performance.now())).toBe(8);
  });

  it('lets audio lanes drift inaudibly and snaps them only past the lane threshold', () => {
    const el = new FakeMedia();
    const sync = new MediaSync(el);

    el.advanceTo(1);
    sync.updateLane(1.3, true);
    expect(el.seeks).toEqual([]); // 0.3 s off — nobody can hear it
    expect(el.playCalls).toBe(1);

    sync.updateLane(1.7, true);
    expect(el.seeks).toEqual([1.7]);

    sync.updateLane(1.7, false);
    sync.updateLane(1.7, false);
    expect(el.pauseCalls).toBe(1);
  });
});

describe('nextPlayheadMs', () => {
  it('advances by the wall delta over photos and gaps', () => {
    const clips = [photoClipAt(0, 3000)];
    expect(nextPlayheadMs(1000, 17, clips, performance.now())).toBe(1017);
    expect(nextPlayheadMs(4000, 17, [], performance.now())).toBe(4017);
  });

  it('derives the playhead from the active video element', () => {
    const clip = videoClipAt(2000, 4000, 'v1', 500);
    const el = new FakeMedia();
    registerMedia(videoKey('v1'), el);
    el.advanceTo(1.5); // source time 1.5 s, in-point 0.5 s → 1 s into the clip

    expect(nextPlayheadMs(2200, 17, [clip], performance.now())).toBe(3000);
  });

  it('holds a not-yet-started element at the clip entry instead of going backwards', () => {
    const clip = videoClipAt(2000, 4000, 'v1', 500);
    const el = new FakeMedia(); // currentTime 0 < in-point
    registerMedia(videoKey('v1'), el);

    expect(nextPlayheadMs(2010, 17, [clip], performance.now())).toBe(2000);
  });

  it('does not jump after a stall resolves — the playhead resumes from the frame shown', () => {
    const clip = videoClipAt(0, 5000, 'v1');
    const el = new FakeMedia();
    registerMedia(videoKey('v1'), el);

    el.advanceTo(1);
    expect(nextPlayheadMs(1000, 17, [clip], performance.now())).toBe(1000); // frozen with the element
    expect(nextPlayheadMs(1000, 17, [clip], performance.now())).toBe(1000);
    el.advanceTo(1.033);
    expect(nextPlayheadMs(1000, 17, [clip], performance.now())).toBe(1033);
  });

  it('clamps a source outlasting its trim to the clip end so nothing after it is skipped', () => {
    const clip = videoClipAt(0, 2000, 'v1');
    const el = new FakeMedia();
    registerMedia(videoKey('v1'), el);
    el.advanceTo(3.5); // element ran past the out-point

    expect(nextPlayheadMs(1900, 17, [clip], performance.now())).toBe(2000);
  });

  it('falls back to the wall clock when the element ended before the clip did', () => {
    const clip = videoClipAt(0, 5000, 'v1');
    const el = new FakeMedia();
    registerMedia(videoKey('v1'), el);
    el.advanceTo(4.2);
    el.ended = true;

    expect(nextPlayheadMs(4200, 17, [clip], performance.now())).toBe(4217);
  });

  it('falls back to the wall clock when no element is mounted for the clip', () => {
    const clip = videoClipAt(0, 5000, 'v1');
    expect(nextPlayheadMs(1000, 17, [clip], performance.now())).toBe(1017);
  });
});

describe('videoPoolAt', () => {
  const photo = photoClipAt(0, 3000, 'p1');
  const video = videoClipAt(3000, 5000, 'v1');
  const later = videoClipAt(10000, 2000, 'v2');

  it('premounts the upcoming video while the playhead is on a photo', () => {
    expect(videoPoolAt([photo, video], 1000).map((c) => c.id)).toEqual(['v1']);
  });

  it('keeps the active video mounted and the next one primed', () => {
    expect(videoPoolAt([photo, video, later], 4000).map((c) => c.id)).toEqual(['v1', 'v2']);
  });

  it('premounts across a gap', () => {
    expect(videoPoolAt([photo, later], 5000).map((c) => c.id)).toEqual(['v2']);
  });

  it('holds only the last clip once the playhead sits at the very end', () => {
    expect(videoPoolAt([photo, video], 8000).map((c) => c.id)).toEqual(['v1']);
  });

  it('is empty on an empty track', () => {
    expect(videoPoolAt([], 0)).toEqual([]);
  });
});
