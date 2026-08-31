/**
 * Preview playback sync.
 *
 * The old preview slaved every media element to the wall-clock playhead: a hard seek
 * whenever the element drifted past 0.25 s, re-checked every animation frame, plus a
 * `play()` call per frame. A video mounts at clip entry already behind the wall clock by
 * its load latency, and in WebKit every committed seek flushes the decode pipeline — so
 * the correction recreated the drift it corrected, and playback degenerated into one
 * visible frame per completed seek: the ~0.5 fps slideshow.
 *
 * The cure is structural, not a better threshold:
 *
 * - **The active video owns the clock.** While the playhead is inside a playing video
 *   clip, `nextPlayheadMs` derives it from the element's own `currentTime`, so the frame
 *   on screen and the timeline time cannot disagree, and a buffering element simply holds
 *   the playhead instead of falling behind it. The wall clock drives photos, gaps, and
 *   any element that cannot be trusted (ended, errored, or stalled past the watchdog).
 * - **Seeks are guarded.** Setting `currentTime` mid-seek aborts the previous seek, which
 *   then never fires `seeked` — so a new target is queued, not issued, until the pending
 *   one settles: by `seeked`, by `timeupdate` arriving near the target, or by a timeout,
 *   so one swallowed event cannot brick seeking for the session.
 * - **`play()` and `pause()` fire on transitions only** — never per frame.
 */

import type { Clip } from '../types/project';
import { clipAt, layout } from './timeline';

/** The slice of HTMLMediaElement the sync layer touches — a fake stands in for tests. */
export interface SyncableMedia {
  currentTime: number;
  readyState: number;
  ended: boolean;
  error: unknown;
  play(): Promise<void> | undefined;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * A discontinuity while playing — a scrub, never clock jitter: in steady state the
 * playhead is *derived from* the element, so their difference is essentially zero, and the
 * wall clock's boundary overshoot into a clip is under two frames.
 */
const PLAYING_SEEK_S = 0.3;
/** While paused the preview is a frame inspector, so it follows the playhead closely. */
const PAUSED_SEEK_S = 0.05;
/** Audio lanes ride the wall clock; under this much drift the offset is inaudible. */
const LANE_SEEK_S = 0.5;
/** A pending seek must settle somehow, or the guard would block seeking forever. */
const SEEK_TIMEOUT_MS = 1000;
/** `timeupdate` landing this near the target counts as the seek arriving. */
const SEEK_ARRIVED_S = 0.3;
/** An element wanting to play but making no progress this long hands back the clock. */
const STALL_MS = 3000;

/**
 * One media element's sync discipline. Everything stateful about seeking and playing
 * lives here, so the components stay declarative and the rules stay unit-testable.
 */
export class MediaSync {
  private readonly el: SyncableMedia;
  private readonly listeners: Array<[string, () => void]>;
  private wantsPlay = false;
  private failed = false;
  private lastProgressAt: number;
  /** The seek in flight, if any — `queued` is the latest target asked for meanwhile. */
  private pending: { target: number; queued: number | null; timer: ReturnType<typeof setTimeout> } | null =
    null;
  /** Where to put a not-yet-loaded element the moment its metadata arrives. */
  private primeTo: number | null = null;

  constructor(el: SyncableMedia) {
    this.el = el;
    this.lastProgressAt = performance.now();
    this.listeners = [
      ['seeked', () => this.settle()],
      ['timeupdate', () => this.onTimeUpdate()],
      ['playing', () => (this.lastProgressAt = performance.now())],
      ['error', () => (this.failed = true)],
      ['loadedmetadata', () => this.onMetadata()],
    ];
    for (const [type, fn] of this.listeners) el.addEventListener(type, fn);
  }

  /**
   * Park the element at its in-point so entering the clip later needs no load and no
   * seek. Before metadata there is nothing to seek in, so the target waits for it.
   */
  prime(targetSec: number): void {
    if (this.el.readyState >= 1) this.alignTo(targetSec, PAUSED_SEEK_S);
    else this.primeTo = targetSec;
  }

  /**
   * The active element's contract, called once per store change (not per React render):
   * follow `wantedSec` and the play state. Playing steady-state never seeks — the
   * playhead is derived from this element, so only a real scrub can open a gap.
   */
  update(wantedSec: number, shouldPlay: boolean): void {
    if (shouldPlay) {
      this.alignTo(wantedSec, PLAYING_SEEK_S);
      this.setPlaying(true);
    } else {
      this.setPlaying(false);
      this.alignTo(wantedSec, PAUSED_SEEK_S);
    }
  }

  /**
   * An audio lane's contract: the wall clock stays its master, so it tolerates a little
   * drift and snaps only when the offset would be audible. Paused lanes are left alone —
   * the drift check on resume puts them right.
   */
  updateLane(wantedSec: number, shouldPlay: boolean): void {
    if (!shouldPlay) {
      this.setPlaying(false);
      return;
    }
    this.alignTo(wantedSec, LANE_SEEK_S);
    this.setPlaying(true);
  }

  /** Stand down: not this element's turn to be heard. Idempotent. */
  deactivate(): void {
    this.setPlaying(false);
  }

  /**
   * The element's position in seconds if the clock may trust it, else `null`. While a
   * seek is pending, the position is where the element is *going* — per spec the getter
   * already reads that way, and the queued target supersedes it.
   */
  trustedTimeSec(nowMs: number): number | null {
    if (this.failed || this.el.ended) return null;
    if (this.wantsPlay && nowMs - this.lastProgressAt > STALL_MS) return null;
    return this.timeSec();
  }

  dispose(): void {
    for (const [type, fn] of this.listeners) this.el.removeEventListener(type, fn);
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    this.primeTo = null;
    this.el.pause();
  }

  private timeSec(): number {
    if (this.pending) return this.pending.queued ?? this.pending.target;
    return this.el.currentTime;
  }

  private alignTo(targetSec: number, toleranceSec: number): void {
    if (Math.abs(this.timeSec() - targetSec) <= toleranceSec) return;
    if (this.pending) {
      this.pending.queued = targetSec;
    } else {
      this.issue(targetSec);
    }
  }

  private issue(targetSec: number): void {
    this.el.currentTime = targetSec;
    this.pending = {
      target: targetSec,
      queued: null,
      timer: setTimeout(() => this.settle(), SEEK_TIMEOUT_MS),
    };
  }

  private settle(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const queued = this.pending.queued;
    this.pending = null;
    if (queued !== null && Math.abs(this.el.currentTime - queued) > PAUSED_SEEK_S) {
      this.issue(queued);
    }
  }

  private onTimeUpdate(): void {
    this.lastProgressAt = performance.now();
    // A seek whose `seeked` was swallowed still lands: playback resuming near the target
    // is the same evidence.
    if (this.pending && Math.abs(this.el.currentTime - this.pending.target) < SEEK_ARRIVED_S) {
      this.settle();
    }
  }

  private onMetadata(): void {
    if (this.primeTo === null) return;
    const target = this.primeTo;
    this.primeTo = null;
    this.alignTo(target, PAUSED_SEEK_S);
  }

  private setPlaying(on: boolean): void {
    if (this.wantsPlay === on) return;
    this.wantsPlay = on;
    if (on) {
      this.lastProgressAt = performance.now();
      // `play` yields a promise in browsers and nothing in jsdom; both must be survivable,
      // and a rejection (a pause interrupting a pending play) is routine, not an error.
      void this.el.play()?.catch(() => {});
    } else {
      this.el.pause();
    }
  }
}

// ---------------------------------------------------------------- registry

const registry = new Map<string, MediaSync>();

export function videoKey(clipId: string): string {
  return `clip:${clipId}`;
}

export function laneKey(trackId: string): string {
  return `lane:${trackId}`;
}

/** Adopt a freshly mounted element, primed to its in-point. Replaces any predecessor. */
export function registerMedia(key: string, el: SyncableMedia, primeToSec?: number): MediaSync {
  registry.get(key)?.dispose();
  const sync = new MediaSync(el);
  registry.set(key, sync);
  if (primeToSec !== undefined) sync.prime(primeToSec);
  return sync;
}

export function unregisterMedia(key: string): void {
  registry.get(key)?.dispose();
  registry.delete(key);
}

export function mediaSync(key: string): MediaSync | undefined {
  return registry.get(key);
}

export function eachMedia(prefix: 'clip:' | 'lane:', fn: (key: string, sync: MediaSync) => void): void {
  for (const [key, sync] of registry) {
    if (key.startsWith(prefix)) fn(key, sync);
  }
}

/** Test seam: forget every element, timers and listeners included. */
export function resetPreviewSync(): void {
  for (const sync of registry.values()) sync.dispose();
  registry.clear();
}

// ---------------------------------------------------------------- the clock

/**
 * Where the playhead goes this tick.
 *
 * Inside a trustworthy playing video clip the element is the master: the playhead is its
 * `currentTime` mapped onto the timeline, clamped into the clip's span — the low clamp
 * holds a not-yet-started element at the clip's entry rather than yanking the playhead
 * backwards, and the high clamp stops a source outlasting its trim from skipping whatever
 * follows the clip. Everywhere else — photos, gaps, an element that ended, errored,
 * stalled, or is not mounted — the wall-clock delta advances as before.
 */
export function nextPlayheadMs(prevMs: number, wallDeltaMs: number, clips: Clip[], nowMs: number): number {
  const hit = clipAt(clips, prevMs);
  const clip = hit?.placed.clip;
  if (clip && clip.kind === 'video') {
    const timeSec = mediaSync(videoKey(clip.id))?.trustedTimeSec(nowMs);
    if (timeSec !== null && timeSec !== undefined) {
      const mapped = clip.startMs + timeSec * 1000 - clip.trimStartMs;
      return Math.min(clip.startMs + clip.durationMs, Math.max(clip.startMs, mapped));
    }
  }
  return prevMs + wallDeltaMs;
}

/**
 * The video clips the preview keeps mounted: the one under the playhead, and the next one
 * coming. The next clip mounts hidden and primed however far off it is — the whole photo
 * or gap before it is its loading window, so the cut into it costs nothing.
 */
export function videoPoolAt(clips: Clip[], timeMs: number): Clip[] {
  const hit = clipAt(clips, timeMs);
  const active = hit && hit.placed.clip.kind === 'video' ? hit.placed.clip : null;
  const upcoming = layout(clips).find(
    (p) => p.clip.kind === 'video' && p.startMs > timeMs && p.clip.id !== active?.id,
  );

  const pool: Clip[] = [];
  if (active) pool.push(active);
  if (upcoming) pool.push(upcoming.clip);
  return pool;
}
