/**
 * The three-photo film wizard — the pipeline's front door.
 *
 * Three photos in, two AI transitions out. The panel does the four things that stand
 * between "I have three photos" and "it is rendering": take exactly three of them and say
 * why anything else was refused, let them be put in order, offer a prompt per transition
 * that is already filled in, and then show the run leg by leg.
 *
 * It is deliberately **not** a modal. A film takes minutes, and the editor is meant to stay
 * usable while it renders — so this floats, closing it only hides it, and stopping a render
 * is an explicit Cancel rather than a side effect of getting the panel out of the way.
 */

import { useRef, useState } from 'react';
import * as backend from '../lib/backend';
import {
  defaultFilmPrompt,
  filmProgress,
  FILM_IMAGE_COUNT,
  FILM_SEGMENT_COUNT,
  isFilmAssembled,
  type FilmSegment,
} from '../lib/film';
import { formatDuration, makeId, truncateName } from '../lib/timeline';
import {
  kindOf,
  PHOTO_EXTS,
  useEditor,
  type FilmPhotoSource,
  type ImportProblem,
} from '../state/store';

/** A photo the wizard is holding: chosen, ordered, but not imported until Generate. */
interface Pick extends FilmPhotoSource {
  key: string;
  /** Something the panel can draw a thumbnail from, right now. */
  src: string;
}

export function FilmWizard() {
  const open = useEditor((s) => s.filmWizardOpen);
  const film = useEditor((s) => s.film);
  const assets = useEditor((s) => s.assets);
  const clips = useEditor((s) => s.clips);
  const settings = useEditor((s) => s.settings);
  const close = useEditor((s) => s.closeFilmWizard);
  const openSettings = useEditor((s) => s.openSettings);
  const addFilmPhotos = useEditor((s) => s.addFilmPhotos);
  const startFilm = useEditor((s) => s.startFilm);
  const retryFilmSegment = useEditor((s) => s.retryFilmSegment);
  const cancelFilm = useEditor((s) => s.cancelFilm);
  const dismissFilm = useEditor((s) => s.dismissFilm);
  const runExport = useEditor((s) => s.runExport);

  const [picks, setPicks] = useState<Pick[]>([]);
  const [rejected, setRejected] = useState<ImportProblem[]>([]);
  const [prompts, setPrompts] = useState(() =>
    Array.from({ length: FILM_SEGMENT_COUNT }, (_, i) => defaultFilmPrompt(i)),
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [hot, setHot] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [wasOpen, setWasOpen] = useState(open);

  // The panel is hidden by an early return, not unmounted, so its local state outlives a
  // close. Reopening after a failed Generate used to show the last attempt's error box as
  // if it had just happened. This is React's own "adjust state when something changes"
  // pattern: done during render, so the stale error is never painted even for a frame, and
  // above the early return, so the hook order never changes.
  if (open !== wasOpen) {
    setWasOpen(open);
    // The picks and prompts are the user's own work; only what the *last run* said goes.
    if (open) {
      setFailure(null);
      setRejected([]);
    }
  }

  if (!open) return null;

  const connected = settings?.configured ?? false;
  const progress = film ? filmProgress(film) : null;
  const short = FILM_IMAGE_COUNT - picks.length;
  // The film puts itself on the track the moment its last leg is in; until that has
  // happened there is nothing to export, so the offer waits for it rather than leading
  // the user into an export of somebody else's timeline.
  // The film's clips as they stand *now*. `assembledClipIds` is written once and never
  // cleared, so it records that a film was laid down — not that it is still on the track.
  // Reading it directly left "Export film" live over a timeline the user had emptied, above
  // a callout that cheerfully said "0 transitions · 0.0s".
  const filmClips = film?.assembledClipIds
    ? clips.filter((c) => film.assembledClipIds?.includes(c.id))
    : [];
  const onTimeline = filmClips.length > 0;
  /** Assembled once, but its clips have since been deleted or split apart. */
  const filmGone = film ? isFilmAssembled(film) && !onTimeline : false;

  /** Take what the picker or the drop offered, and say out loud what was not taken. */
  function offer(sources: FilmPhotoSource[]) {
    const problems: ImportProblem[] = [];
    const next = [...picks];

    for (const source of sources) {
      const kind = kindOf(source.name, source.file?.type ?? '');
      if (kind !== 'photo') {
        problems.push({
          name: source.name,
          reason:
            kind === 'video'
              ? 'a film is made from three photos — a video cannot be one of them'
              : `not a photo. Photos are: ${PHOTO_EXTS.join(', ')}`,
        });
        continue;
      }
      if (next.length >= FILM_IMAGE_COUNT) {
        problems.push({
          name: source.name,
          reason: `a film takes exactly ${FILM_IMAGE_COUNT} photos, and three are already chosen`,
        });
        continue;
      }
      next.push({ ...source, key: makeId('pick'), src: previewSrc(source) });
    }

    setPicks(next);
    setRejected(problems);
  }

  function forget(index: number) {
    releasePreview(picks[index]);
    setPicks(picks.filter((_, i) => i !== index));
    setRejected([]);
  }

  /** Reorder is the whole edit here: which photo is first decides what the film opens on. */
  function move(from: number, to: number) {
    if (to < 0 || to >= picks.length) return;
    const next = [...picks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setPicks(next);
  }

  async function choosePhotos() {
    setFailure(null);
    // The desktop picker knows the allowlist and hands back real paths; a browser has to
    // make do with its own file input, which is enough to build the film but not to send it.
    if (!backend.isDesktop()) {
      fileInput.current?.click();
      return;
    }
    try {
      const paths = await backend.pickMediaFiles();
      offer(paths.map((path) => ({ name: baseName(path), path })));
    } catch (error) {
      setFailure(message(error));
    }
  }

  async function generate() {
    setBusy(true);
    setFailure(null);
    try {
      const ids = await addFilmPhotos(picks.map(({ name, file, path }) => ({ name, file, path })));
      await startFilm(ids, prompts);
      // The photos are in the bin now and the run view draws them from there.
      if (useEditor.getState().film) {
        picks.forEach(releasePreview);
        setPicks([]);
        setRejected([]);
      }
    } catch (error) {
      setFailure(message(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    // Not `aria-modal`: the editor behind this stays live, and that is the point.
    <div className="filmwiz" role="dialog" aria-label="New film from 3 photos">
      <div className="filmwiz__head">
        <span>✦ {film ? 'Your film' : 'New film from 3 photos'}</span>
        <button type="button" className="filmwiz__close" aria-label="Close the film panel" onClick={close}>
          ✕
        </button>
      </div>

      <div className="filmwiz__body">
        {film && progress ? (
          <>
            <div className="filmwiz__strip" aria-hidden="true">
              {film.assetIds.map((id, i) => (
                <img key={`${id}-${i}`} src={assets[id]?.src} alt="" draggable={false} />
              ))}
            </div>

            <div className="kv">
              <span>{runHeadline(progress.status)}</span>
              <b>{progress.label}</b>
            </div>
            <div className="progress">
              <i style={{ width: `${Math.round(progress.progress * 100)}%` }} />
            </div>

            {film.segments.map((segment) => (
              <Leg
                key={segment.index}
                segment={segment}
                onRetry={() => void retryFilmSegment(segment.index)}
              />
            ))}

            {onTimeline && (
              <div className="callout" role="status">
                <b>
                  On the timeline — {filmClips.length}{' '}
                  {filmClips.length === 1 ? 'transition' : 'transitions'} ·{' '}
                  {formatDuration(filmClips.reduce((sum, c) => sum + c.durationMs, 0))}
                </b>
                Export writes the timeline as one MP4 — H.264, 1920 × 1080, 30 fps.
              </div>
            )}

            {progress.status === 'succeeded' && !onTimeline && !filmGone && (
              <p className="hint">Both transitions are in — putting them on the timeline…</p>
            )}

            <p className="hint">
              {progress.status === 'running'
                ? 'One film at a time — this one is still rendering. Keep editing while it does; the transitions land on the timeline together, once both are in.'
                : onTimeline
                  ? 'One film at a time — export it, keep editing it on the track, or start over to make another.'
                  : filmGone
                    ? 'This film is no longer on the timeline. Start over to make another.'
                    : 'One film at a time — retry the transition that did not land, or start over. The film goes onto the timeline by itself once both are in.'}
            </p>
          </>
        ) : (
          <>
            <div
              className={`filmwiz__drop ${hot ? 'filmwiz__drop--hot' : ''}`}
              data-testid="film-wizard-dropzone"
              onDragOver={(e) => {
                if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                setHot(true);
              }}
              onDragLeave={() => setHot(false)}
              onDrop={(e) => {
                e.preventDefault();
                setHot(false);
                offer(Array.from(e.dataTransfer?.files ?? []).map(sourceOfFile));
              }}
            >
              <b>Drop three photos here</b>
              The film's transitions run between them, in this order
              <button type="button" className="btn btn--ghost" onClick={() => void choosePhotos()}>
                Choose photos
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                className="visually-hidden"
                // Driven only by the button above, which is the affordance AT should see.
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  offer(Array.from(e.target.files ?? []).map(sourceOfFile));
                  e.target.value = '';
                }}
              />
            </div>

            <ol className="filmwiz__slots">
              {Array.from({ length: FILM_IMAGE_COUNT }, (_, i) => {
                const pick = picks[i];
                if (!pick) {
                  return (
                    <li key={`empty-${i}`} className="filmwiz__slot filmwiz__slot--empty">
                      <span className="filmwiz__n">{i + 1}</span>
                      <span className="filmwiz__name">Photo {i + 1}</span>
                    </li>
                  );
                }
                return (
                  <li key={pick.key} className="filmwiz__slot">
                    <span className="filmwiz__n">{i + 1}</span>
                    <img src={pick.src} alt="" draggable={false} />
                    <span className="filmwiz__name" title={pick.name}>
                      {truncateName(pick.name, 22)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Move ${pick.name} earlier`}
                      disabled={i === 0}
                      onClick={() => move(i, i - 1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${pick.name} later`}
                      disabled={i === picks.length - 1}
                      onClick={() => move(i, i + 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${pick.name}`}
                      onClick={() => forget(i)}
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ol>

            {rejected.length > 0 && (
              <div className="bin__problem" role="alert">
                <b>
                  Left out {rejected.length} {rejected.length === 1 ? 'file' : 'files'}
                </b>
                {rejected.map((problem, i) => (
                  <div key={`${problem.name}-${i}`}>
                    {problem.name} — {problem.reason}
                  </div>
                ))}
                <button type="button" onClick={() => setRejected([])}>
                  Dismiss
                </button>
              </div>
            )}

            {prompts.map((prompt, i) => (
              <div className="field" key={`prompt-${i}`}>
                <label htmlFor={`film-prompt-${i}`}>
                  Transition {i + 1} · photo {i + 1} → photo {i + 2}
                </label>
                <textarea
                  id={`film-prompt-${i}`}
                  className="prompt"
                  value={prompt}
                  onChange={(e) =>
                    setPrompts(prompts.map((p, j) => (j === i ? e.target.value : p)))
                  }
                />
              </div>
            ))}

            {!connected && (
              <div className="callout" role="status">
                <b>Connect Higgsfield to generate</b>
                {backend.isDesktop()
                  ? 'A film is nothing but Higgsfield transitions — there is no local renderer to fall back on. Nothing has been sent.'
                  : 'Rendering needs the SolCut desktop app — run it with `pnpm tauri dev`. Nothing has been sent.'}
                <button type="button" onClick={openSettings}>
                  Open settings →
                </button>
              </div>
            )}

            {short > 0 && (
              <p className="hint hint--error">
                {picks.length} of {FILM_IMAGE_COUNT} photos chosen — add {short} more.
              </p>
            )}

            {failure && (
              <div className="errbox" role="alert">
                <b>The film could not start</b>
                {failure}
              </div>
            )}
          </>
        )}
      </div>

      <div className="filmwiz__foot">
        {film && progress ? (
          <>
            {progress.status === 'running' ? (
              <button type="button" className="btn btn--danger" onClick={() => void cancelFilm()}>
                Cancel film
              </button>
            ) : (
              <button type="button" className="btn btn--ghost" onClick={dismissFilm}>
                Start over
              </button>
            )}
            {/*
              Only offered once the film is actually on the track: an unfinished film has
              nothing to write, and the export needs a save path from the user anyway, so
              this is a button rather than a dialog that opens itself.
            */}
            {onTimeline && (
              <button type="button" className="btn btn--primary" onClick={() => void runExport()}>
                Export film
              </button>
            )}
          </>
        ) : (
          <>
            <button type="button" className="btn btn--ghost" onClick={close}>
              Close
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!connected || picks.length !== FILM_IMAGE_COUNT || busy}
              onClick={() => void generate()}
            >
              {busy ? 'Starting…' : 'Generate film'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** One transition: what it is doing, how far it got, and what to do about a failure. */
function Leg({ segment, onRetry }: { segment: FilmSegment; onRetry: () => void }) {
  const n = segment.index + 1;
  const stalled = segment.status === 'failed' || segment.status === 'cancelled';

  return (
    <div className={`filmwiz__leg ${stalled ? 'filmwiz__leg--error' : ''}`}>
      <div className="kv">
        <span>
          Transition {n} · photo {n} → photo {n + 1}
        </span>
        <b>{legStatus(segment)}</b>
      </div>
      <div className="progress">
        <i
          style={{
            width: `${Math.round((segment.status === 'succeeded' ? 1 : segment.progress) * 100)}%`,
          }}
        />
      </div>
      {segment.error && (
        <div className="errbox" role="alert">
          <b>{segment.error.title}</b>
          {segment.error.message}
        </div>
      )}
      {stalled && (
        <button
          type="button"
          className="block-btn"
          aria-label={`Retry transition ${n}`}
          onClick={onRetry}
        >
          Retry this transition
        </button>
      )}
    </div>
  );
}

function legStatus(segment: FilmSegment): string {
  switch (segment.status) {
    case 'idle':
      return 'Waiting';
    case 'queued':
      return 'Queued';
    case 'running':
      return `Rendering ${Math.round(segment.progress * 100)}%`;
    case 'succeeded':
      return 'Rendered';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

function runHeadline(status: ReturnType<typeof filmProgress>['status']): string {
  switch (status) {
    case 'succeeded':
      return 'Both transitions are in';
    case 'failed':
      return 'A transition did not render';
    case 'cancelled':
      return 'The film was cancelled';
    default:
      return 'Rendering the transitions';
  }
}

/** An OS drop inside Tauri carries a path; a plain browser drop only has the file. */
function sourceOfFile(file: File): FilmPhotoSource {
  const path = (file as File & { path?: string }).path;
  return path ? { name: file.name, path } : { name: file.name, file };
}

function previewSrc(source: FilmPhotoSource): string {
  if (source.path) return backend.assetSrc(source.path);
  try {
    return URL.createObjectURL(source.file as File);
  } catch {
    return '';
  }
}

function releasePreview(pick: Pick | undefined): void {
  if (pick?.src.startsWith('blob:')) URL.revokeObjectURL(pick.src);
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}
