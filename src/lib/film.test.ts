import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyGenerationToFilm,
  assembleFilm,
  cancelFilmSegments,
  createFilm,
  defaultFilmPrompt,
  filmProgress,
  FILM_SEGMENT_COUNT,
  FILM_SEGMENT_DURATION_MS,
  inFlightFilmGenerationIds,
  markFilmSegmentFailed,
  markFilmSegmentQueued,
  patchFilmSegment,
  pendingFilmSegments,
  setFilmPrompt,
  type Film,
} from './film';
import { resetIds } from './timeline';
import type { FilmGeneration } from '../types/project';

beforeEach(resetIds);

const PHOTOS = ['asset_a', 'asset_b', 'asset_c'];

function generation(index: number, id: string, patch: Partial<FilmGeneration> = {}): FilmGeneration {
  return {
    kind: 'film',
    id,
    startAssetId: PHOTOS[index],
    endAssetId: PHOTOS[index + 1],
    filmSegmentIndex: index,
    prompt: defaultFilmPrompt(index),
    status: 'running',
    progress: 0.5,
    elapsedSecs: 10,
    slow: false,
    ...patch,
  };
}

/** A film with both legs queued under known generation ids — the state a real run starts in. */
function launched(prompts?: string[]): Film {
  let film = createFilm(PHOTOS, prompts);
  film = markFilmSegmentQueued(film, 0, 'gen_1');
  return markFilmSegmentQueued(film, 1, 'gen_2');
}

function succeed(film: Film, index: number, outputPath: string, durationMs?: number): Film {
  const next = applyGenerationToFilm(
    film,
    generation(index, film.segments[index].generationId ?? `gen_${index}`, {
      status: 'succeeded',
      progress: 1,
      outputPath,
    }),
  );
  return durationMs === undefined ? next : patchFilmSegment(next, index, { durationMs });
}

describe('createFilm', () => {
  it('turns three photos into two transitions, in order', () => {
    const film = createFilm(PHOTOS);

    expect(film.segments).toHaveLength(FILM_SEGMENT_COUNT);
    expect(film.segments.map((s) => [s.index, s.startAssetId, s.endAssetId])).toEqual([
      [0, 'asset_a', 'asset_b'],
      [1, 'asset_b', 'asset_c'],
    ]);
    expect(film.segments.every((s) => s.status === 'idle' && s.progress === 0)).toBe(true);
  });

  it('defaults a prompt per leg and lets one be given instead', () => {
    const film = createFilm(PHOTOS, ['golden hour drift', '  ']);

    expect(film.segments[0].prompt).toBe('golden hour drift');
    // A blank one is not a prompt; the default stands in so the leg is still runnable.
    expect(film.segments[1].prompt).toBe(defaultFilmPrompt(1));
  });

  it('refuses anything but three usable photos rather than making a shorter film', () => {
    expect(() => createFilm(['a', 'b'])).toThrow(/exactly 3 photos/);
    expect(() => createFilm(['a', 'b', 'c', 'd'])).toThrow(/exactly 3 photos/);
    expect(() => createFilm(['a', '', 'c'])).toThrow(/media bin/);
  });

  it('takes an edited prompt after the fact', () => {
    const film = setFilmPrompt(createFilm(PHOTOS), 1, 'orbit around the boat');

    expect(film.segments[1].prompt).toBe('orbit around the boat');
    expect(film.segments[0].prompt).toBe(defaultFilmPrompt(0));
    // An index that is not a leg is a no-op, not a third leg.
    expect(setFilmPrompt(film, 7, 'nowhere').segments).toHaveLength(FILM_SEGMENT_COUNT);
  });
});

describe('folding generations into a film', () => {
  it('keys a result by segment index, not by the order results arrive', () => {
    let film = launched();

    // Leg 2 comes back first…
    film = applyGenerationToFilm(film, generation(1, 'gen_2', { status: 'succeeded', progress: 1, outputPath: '/out/second.mp4' }));
    expect(film.segments[1].status).toBe('succeeded');
    expect(film.segments[0].status).toBe('queued');

    // …and leg 1 lands on leg 1 all the same.
    film = applyGenerationToFilm(film, generation(0, 'gen_1', { status: 'succeeded', progress: 1, outputPath: '/out/first.mp4' }));
    expect(film.segments.map((s) => s.outputPath)).toEqual(['/out/first.mp4', '/out/second.mp4']);
  });

  it('ignores an update from a run a retry has already replaced', () => {
    let film = markFilmSegmentQueued(launched(), 0, 'gen_retry');

    film = applyGenerationToFilm(film, generation(0, 'gen_1', { status: 'failed', error: { title: 'Rate limited', message: 'rate limited', retryable: true } }));

    expect(film.segments[0].status).toBe('queued');
    expect(film.segments[0].generationId).toBe('gen_retry');
    expect(film.segments[0].error).toBeUndefined();
  });

  it('clears the old result when a leg is queued again', () => {
    const film = succeed(launched(), 0, '/out/first.mp4', 4800);
    const retried = markFilmSegmentQueued(film, 0, 'gen_retry');

    expect(retried.segments[0]).toMatchObject({ status: 'queued', progress: 0 });
    expect(retried.segments[0].outputPath).toBeUndefined();
    expect(retried.segments[0].durationMs).toBeUndefined();
  });
});

describe('the film state machine', () => {
  it('is idle before anything is sent', () => {
    expect(filmProgress(createFilm(PHOTOS))).toMatchObject({ status: 'idle', succeeded: 0, total: 2, partial: false, progress: 0 });
  });

  it('runs, then succeeds, once both legs are in', () => {
    let film = launched();
    expect(filmProgress(film).status).toBe('running');

    film = succeed(film, 0, '/out/first.mp4');
    // One leg in, the other half way: a succeeded leg counts as done however far its last
    // progress report got.
    film = applyGenerationToFilm(film, generation(1, 'gen_2', { status: 'running', progress: 0.5 }));
    expect(filmProgress(film)).toMatchObject({ status: 'running', succeeded: 1, partial: false, progress: 0.75 });

    film = succeed(film, 1, '/out/second.mp4');
    expect(filmProgress(film)).toMatchObject({ status: 'succeeded', succeeded: 2, partial: false, progress: 1 });
  });

  it('comes back partial when one leg fails, and says so in a countable way', () => {
    let film = succeed(launched(), 1, '/out/second.mp4');
    film = applyGenerationToFilm(film, generation(0, 'gen_1', { status: 'failed', progress: 0, error: { title: 'Rate limited', message: 'rate limited', retryable: true } }));

    const progress = filmProgress(film);
    expect(progress).toMatchObject({ status: 'failed', succeeded: 1, total: 2, partial: true });
    expect(progress.label).toBe('1 of 2 succeeded');
    // Nothing goes on the timeline while a leg is missing.
    expect(assembleFilm(film)).toBeNull();
  });

  it('retries only the failed leg, and the film finishes without re-running the other', () => {
    let film = succeed(launched(), 1, '/out/second.mp4');
    film = applyGenerationToFilm(film, generation(0, 'gen_1', { status: 'failed', progress: 0, error: { title: 'Rate limited', message: 'rate limited', retryable: true } }));

    // Only the failed leg is waiting for a run; the one that landed is left alone.
    expect(pendingFilmSegments(film).map((s) => s.index)).toEqual([0]);

    const succeededBefore = film.segments[1];
    film = markFilmSegmentQueued(film, 0, 'gen_retry');
    // A retry in flight outranks the leg that failed: the film is running again.
    expect(filmProgress(film).status).toBe('running');

    film = applyGenerationToFilm(film, generation(0, 'gen_retry', { status: 'succeeded', progress: 1, outputPath: '/out/first-retry.mp4' }));

    expect(filmProgress(film)).toMatchObject({ status: 'succeeded', succeeded: 2, partial: false });
    expect(film.segments[1]).toEqual(succeededBefore);
    expect(film.segments[0].outputPath).toBe('/out/first-retry.mp4');
  });

  it('cancels the legs in flight and keeps the one that already rendered', () => {
    const film = cancelFilmSegments(succeed(launched(), 0, '/out/first.mp4'));

    expect(film.segments.map((s) => s.status)).toEqual(['succeeded', 'cancelled']);
    expect(film.segments[0].outputPath).toBe('/out/first.mp4');
    expect(filmProgress(film)).toMatchObject({ status: 'cancelled', succeeded: 1, partial: true });
  });

  it('names only the generations a cancel still has to reach', () => {
    expect(inFlightFilmGenerationIds(launched())).toEqual(['gen_1', 'gen_2']);
    expect(inFlightFilmGenerationIds(succeed(launched(), 0, '/out/first.mp4'))).toEqual(['gen_2']);
    expect(inFlightFilmGenerationIds(createFilm(PHOTOS))).toEqual([]);
  });

  it('fails a leg that never got off the ground', () => {
    const film = markFilmSegmentFailed(createFilm(PHOTOS), 1, {
      title: 'Photo missing',
      message: 'gone',
      retryable: false,
    });

    expect(film.segments[1]).toMatchObject({ status: 'failed', progress: 0 });
    expect(inFlightFilmGenerationIds(film)).toEqual([]);
    expect(filmProgress(film).status).toBe('failed');
  });
});

describe('assembling the film', () => {
  it('places the two clips in segment order even when leg 2 came back first', () => {
    // Leg 2 finishes first, and is written into the film first.
    let film = succeed(launched(), 1, '/out/second.mp4', 5200);
    film = succeed(film, 0, '/out/first.mp4', 4800);

    const assembled = assembleFilm(film, (path) => `asset://${path}`);

    expect(assembled).not.toBeNull();
    expect(assembled!.clips.map((c) => c.durationMs)).toEqual([4800, 5200]);
    expect(assembled!.assets.map((a) => a.path)).toEqual(['/out/first.mp4', '/out/second.mp4']);
    expect(assembled!.assets.map((a) => a.src)).toEqual([
      'asset:///out/first.mp4',
      'asset:///out/second.mp4',
    ]);
    // Each clip is the AI video its own leg produced, credited to the photo it started from.
    expect(assembled!.clips.map((c) => c.assetId)).toEqual(assembled!.assets.map((a) => a.id));
    expect(assembled!.clips.map((c) => c.ai?.sourceAssetId)).toEqual(['asset_a', 'asset_b']);
    expect(assembled!.clips.map((c) => c.ai?.prompt)).toEqual([defaultFilmPrompt(0), defaultFilmPrompt(1)]);
    expect(assembled!.clips.every((c) => c.kind === 'video' && c.trimStartMs === 0)).toBe(true);
  });

  it('falls back to the expected leg length until the file has been probed', () => {
    let film = succeed(launched(), 0, '/out/first.mp4');
    film = succeed(film, 1, '/out/second.mp4');

    expect(assembleFilm(film)!.clips.map((c) => c.durationMs)).toEqual([
      FILM_SEGMENT_DURATION_MS,
      FILM_SEGMENT_DURATION_MS,
    ]);
  });

  it('refuses to assemble anything less than a whole film', () => {
    expect(assembleFilm(createFilm(PHOTOS))).toBeNull();
    expect(assembleFilm(succeed(launched(), 0, '/out/first.mp4'))).toBeNull();
    // Succeeded but with nothing to show for it is not a finished leg either.
    expect(
      assembleFilm(patchFilmSegment(succeed(launched(), 0, '/out/first.mp4'), 1, { status: 'succeeded' })),
    ).toBeNull();
  });
});
