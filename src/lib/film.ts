/**
 * A film: three photos, two AI transitions, one run.
 *
 * The photos *are* the keyframes — the film is nothing but the transitions between them
 * (photo 1 → 2, photo 2 → 3), concatenated. That makes a film a small ordered job rather
 * than a timeline edit, and this module is its whole model: what each leg is, what state it
 * is in, what the film as a whole therefore is, and — once every leg has landed — what goes
 * onto the track.
 *
 * Pure by design, like `timeline.ts`: no React, no Tauri, no clock. The store drives it.
 */

import type { Clip, FilmGeneration, GenerationError, GenerationStatus, MediaAsset } from '../types/project';
import { makeId, videoClip } from './timeline';

/** Three photos make two transitions: 1 → 2 and 2 → 3. */
export const FILM_IMAGE_COUNT = 3;
export const FILM_SEGMENT_COUNT = FILM_IMAGE_COUNT - 1;

/**
 * How long a leg is taken to be until the file says otherwise.
 *
 * No Higgsfield endpoint accepts a free-form duration — the model decides — so this is not
 * something the request asks for. It is what a leg is drawn as before its MP4 has been
 * probed, and what it falls back to when the probe cannot tell.
 */
export const FILM_SEGMENT_DURATION_MS = 5000;

/** A starting point, not a rule: these land in an editable box before anything is sent. */
export const DEFAULT_FILM_PROMPTS = [
  'a smooth cinematic camera move from the first photo into the second',
  'a smooth cinematic camera move from the second photo into the third',
];

export function defaultFilmPrompt(index: number): string {
  return DEFAULT_FILM_PROMPTS[index] ?? DEFAULT_FILM_PROMPTS[DEFAULT_FILM_PROMPTS.length - 1];
}

/** A leg that has not been sent anywhere yet is `idle`; after that it is its generation's. */
export type FilmSegmentStatus = 'idle' | GenerationStatus;

export interface FilmSegment {
  /** 0 for photo 1 → 2, 1 for photo 2 → 3. Its position in the finished film, always. */
  index: number;
  startAssetId: string;
  endAssetId: string;
  prompt: string;
  status: FilmSegmentStatus;
  /** The generation currently answering for this leg. A retry replaces it. */
  generationId?: string;
  /** 0..1 */
  progress: number;
  /** Where the finished MP4 landed — parked here rather than on the timeline. */
  outputPath?: string;
  /** The MP4's real length, once it has been probed. */
  durationMs?: number;
  error?: GenerationError;
}

export interface Film {
  id: string;
  /** The three photos, in order. */
  assetIds: string[];
  /** Always `FILM_SEGMENT_COUNT` long, always in index order. */
  segments: FilmSegment[];
}

export type FilmStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface FilmProgress {
  status: FilmStatus;
  succeeded: number;
  total: number;
  /** The run is over and only some of the legs made it. */
  partial: boolean;
  /** 0..1 across the whole film. */
  progress: number;
  /** "1 of 2 succeeded" — the plain count a partial film is explained with. */
  label: string;
}

/**
 * A film from three photos, with a prompt per leg.
 *
 * Refuses loudly on anything but three usable photos rather than quietly making a shorter
 * film: the caller has miscounted, and a film with a missing leg is not a film.
 */
export function createFilm(assetIds: string[], prompts: string[] = []): Film {
  if (assetIds.length !== FILM_IMAGE_COUNT) {
    throw new Error(`a film is made from exactly ${FILM_IMAGE_COUNT} photos, not ${assetIds.length}`);
  }
  if (assetIds.some((id) => !id)) {
    throw new Error('a film needs three photos that are actually in the media bin');
  }
  return {
    id: makeId('film'),
    assetIds: [...assetIds],
    segments: Array.from({ length: FILM_SEGMENT_COUNT }, (_, index) => ({
      index,
      startAssetId: assetIds[index],
      endAssetId: assetIds[index + 1],
      prompt: (prompts[index] ?? '').trim() || defaultFilmPrompt(index),
      status: 'idle' as const,
      progress: 0,
    })),
  };
}

export function setFilmPrompt(film: Film, index: number, prompt: string): Film {
  return patchFilmSegment(film, index, { prompt });
}

/** Write straight to one leg. Unknown indices are a no-op, not a new leg. */
export function patchFilmSegment(film: Film, index: number, patch: Partial<FilmSegment>): Film {
  if (!film.segments.some((s) => s.index === index)) return film;
  return {
    ...film,
    segments: film.segments.map((s) => (s.index === index ? { ...s, ...patch, index: s.index } : s)),
  };
}

/**
 * A leg is on its way out.
 *
 * It claims the generation id *before* the request goes anywhere, so a late update from the
 * run this one replaces has something to be recognised as stale against.
 */
export function markFilmSegmentQueued(film: Film, index: number, generationId: string): Film {
  return patchFilmSegment(film, index, {
    status: 'queued',
    generationId,
    progress: 0,
    outputPath: undefined,
    durationMs: undefined,
    error: undefined,
  });
}

/** A leg that never got off the ground — nothing was queued, so there is nothing to cancel. */
export function markFilmSegmentFailed(film: Film, index: number, error: GenerationError): Film {
  return patchFilmSegment(film, index, { status: 'failed', progress: 0, error });
}

/**
 * Fold a generation's latest state into the leg that asked for it.
 *
 * The leg is found by `filmSegmentIndex` and never by arrival order, so leg 2 finishing
 * first lands on leg 2 and the film keeps its shape.
 */
export function applyGenerationToFilm(film: Film, generation: FilmGeneration): Film {
  const segment = film.segments.find((s) => s.index === generation.filmSegmentIndex);
  // Superseded by a retry: whatever this run has to say about the leg is no longer about it.
  if (!segment || (segment.generationId && segment.generationId !== generation.id)) return film;

  return patchFilmSegment(film, generation.filmSegmentIndex, {
    status: generation.status,
    generationId: generation.id,
    progress: generation.progress,
    outputPath: generation.outputPath ?? segment.outputPath,
    error: generation.status === 'failed' ? generation.error : undefined,
  });
}

/** Legs that still need a run: never started, or finished in a way that produced nothing. */
export function pendingFilmSegments(film: Film): FilmSegment[] {
  return film.segments.filter(
    (s) => s.status === 'idle' || s.status === 'failed' || s.status === 'cancelled',
  );
}

function inFlight(segment: FilmSegment): boolean {
  return segment.status === 'queued' || segment.status === 'running';
}

/** The generations a cancel has to reach. Legs that already landed are not among them. */
export function inFlightFilmGenerationIds(film: Film): string[] {
  return film.segments.flatMap((s) => (inFlight(s) && s.generationId ? [s.generationId] : []));
}

/**
 * Stop the legs that are still in flight. Anything already rendered keeps its result — it
 * has been paid for, and a retry of the other leg can still complete the film.
 */
export function cancelFilmSegments(film: Film): Film {
  return {
    ...film,
    segments: film.segments.map((s) => (inFlight(s) ? { ...s, status: 'cancelled', progress: 0 } : s)),
  };
}

/** What the film as a whole is doing, derived from its legs and nothing else. */
export function filmProgress(film: Film): FilmProgress {
  const total = film.segments.length;
  const succeeded = film.segments.filter((s) => s.status === 'succeeded').length;
  const status = filmStatus(film, succeeded, total);
  // "Partial" is only meaningful once the running has stopped.
  const partial = status !== 'idle' && status !== 'running' && succeeded > 0 && succeeded < total;

  return {
    status,
    succeeded,
    total,
    partial,
    progress:
      total === 0
        ? 0
        : film.segments.reduce((sum, s) => sum + (s.status === 'succeeded' ? 1 : s.progress), 0) / total,
    label: `${succeeded} of ${total} succeeded`,
  };
}

function filmStatus(film: Film, succeeded: number, total: number): FilmStatus {
  if (film.segments.every((s) => s.status === 'idle')) return 'idle';
  // A retry in flight outranks the leg that already failed: the film is running again.
  if (film.segments.some(inFlight)) return 'running';
  if (succeeded === total && total > 0) return 'succeeded';
  if (film.segments.some((s) => s.status === 'failed')) return 'failed';
  if (film.segments.some((s) => s.status === 'cancelled')) return 'cancelled';
  // Legs left to run and none of them in flight yet — under way, just not this instant.
  return 'running';
}

export interface FilmAssembly {
  assets: MediaAsset[];
  clips: Clip[];
}

/**
 * The finished film as timeline material: one video clip per leg, in segment-index order.
 *
 * `null` unless every leg succeeded. A film goes onto the track whole or not at all — one
 * clip landing while the other leg is still failing is exactly the half-edited project the
 * parked-output design exists to prevent.
 *
 * `resolveSrc` turns a path on disk into something the webview can load; the identity
 * default keeps this callable from a test with no Tauri under it.
 */
export function assembleFilm(
  film: Film,
  resolveSrc: (path: string) => string = (path) => path,
): FilmAssembly | null {
  const ordered = [...film.segments].sort((a, b) => a.index - b.index);
  const ready = ordered.flatMap((segment) =>
    segment.status === 'succeeded' && segment.outputPath
      ? [{ segment, outputPath: segment.outputPath }]
      : [],
  );
  if (ready.length === 0 || ready.length !== ordered.length) return null;

  const assets: MediaAsset[] = [];
  const clips: Clip[] = [];

  for (const { segment, outputPath } of ready) {
    const durationMs = segment.durationMs ?? FILM_SEGMENT_DURATION_MS;
    const asset: MediaAsset = {
      id: makeId('asset'),
      name: `${film.id}-${segment.index + 1}.mp4`,
      kind: 'video',
      path: outputPath,
      src: resolveSrc(outputPath),
      sizeBytes: 0,
      durationMs,
    };
    assets.push(asset);
    clips.push({
      ...videoClip(asset, durationMs),
      ai: { prompt: segment.prompt, sourceAssetId: segment.startAssetId },
    });
  }

  return { assets, clips };
}
