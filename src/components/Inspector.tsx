import { useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { resolveCutMode, useEditor } from '../state/store';
import {
  DEFAULT_TRANSITION_PROMPT,
  MAX_PHOTO_DURATION_MS,
  MIN_CLIP_DURATION_MS,
  type AudioTrack,
  type Clip,
  type Generation,
} from '../types/project';
import {
  bridgeableCuts,
  cutOffersReplace,
  durationInputValue,
  formatDuration,
  formatTimecode,
  parseDurationInput,
  transitionStaleness,
} from '../lib/timeline';
import { modelLabel, readinessHint, type ReadinessHint } from '../lib/backend';
import { ModelSelect } from './ModelSelect';

/**
 * Why the chosen backend cannot render, and what to do about it.
 *
 * One component for all three surfaces, because the answer differs by backend and there is
 * no version of this worth writing twice: Higgsfield is connected in Settings, while a local
 * backend is a CLI you install, so only one of them has a button to offer.
 */
function NotReady({ hint, onOpenSettings }: { hint: ReadinessHint; onOpenSettings: () => void }) {
  return (
    <div className="callout">
      <b>{hint.title}</b>
      {hint.detail}
      {hint.command && <code className="callout__cmd">{hint.command}</code>}
      {hint.opensSettings && (
        <button type="button" onClick={onOpenSettings}>
          Open settings →
        </button>
      )}
    </div>
  );
}

const TRANSITION_SUGGESTIONS = ['crossfade morph', 'whip pan', 'zoom through', 'dreamy dissolve'];

export function Inspector() {
  const selection = useEditor((s) => s.selection);
  const clips = useEditor((s) => s.clips);
  const audioTracks = useEditor((s) => s.audioTracks);
  const clip = selection.kind === 'clip' ? clips.find((c) => c.id === selection.clipId) : undefined;
  const track =
    selection.kind === 'audio' ? audioTracks.find((t) => t.id === selection.trackId) : undefined;

  // A selected cut is only real while its pair still forms one — two clips side by side,
  // touching or with a gap a transition would fill.
  let cutPair: { a: Clip; b: Clip } | undefined;
  if (selection.kind === 'cut') {
    const stands = bridgeableCuts(clips).some(
      (c) => c.afterClipId === selection.afterClipId && c.beforeClipId === selection.beforeClipId,
    );
    const a = clips.find((c) => c.id === selection.afterClipId);
    const b = clips.find((c) => c.id === selection.beforeClipId);
    if (stands && a && b) cutPair = { a, b };
  }

  return (
    <div className="col">
      <div className="panel-head">Inspector</div>
      <div className="inspector">
        {track ? (
          // Keyed so a selection that moves to another item remounts the cards: a
          // half-typed duration must never be carried onto whatever is selected next.
          <AudioCard key={track.id} track={track} />
        ) : cutPair ? (
          <CutCard a={cutPair.a} b={cutPair.b} />
        ) : !clip ? (
          <div className="empty-note">
            <div className="icon" aria-hidden="true">
              ◇
            </div>
            <b>Nothing selected</b>
            Select a clip on the timeline to edit it, or drop media to begin.
          </div>
        ) : (
          <InspectorBody key={clip.id} clip={clip} />
        )}
      </div>
    </div>
  );
}

/** What a commit left behind: the entry the box did not get its way with. */
type DurationOutcome =
  /** Not a length at all. `text` is what was typed, trimmed; `''` for an empty box. */
  | { kind: 'rejected'; text: string; atMs: number }
  /** A length, but not one the timeline would give. `askedMs` is what was wanted. */
  | { kind: 'clamped'; askedMs: number; atMs: number };

/**
 * The Duration box's state and behaviour, shared by the clip card and the audio card.
 *
 * This is the one control in the app that does not commit on every keystroke, and
 * deliberately: a numeric box passes through `""`, `"."` and `"1"` on the way to `"12"`,
 * and committing each of those would clamp the item, destroy the number the user was
 * halfway through, and write the project file. So it commits on Enter and on leaving the
 * box, and Escape puts it back.
 *
 * `draft` is the whole of what the box holds. While it is null the box shows the item's real
 * length, so a render landing or an edit made elsewhere shows through a box nobody is typing
 * in — no effect to keep the two in step.
 *
 * `outcome` is the one thing a commit leaves behind: what the entry did not get, and the
 * length the item stood at while that was true. Every note is tied to that length, so it
 * retires the moment the item moves off it — a clamp explained by "a photo is held for at
 * most 10 minutes" must not still be on screen once the user has dragged the clip somewhere
 * else entirely.
 */
function useDurationField(valueMs: number, commit: (durationMs: number) => number | null) {
  const [draft, setDraft] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<DurationOutcome | null>(null);

  const commitDraft = () => {
    if (draft === null) return;
    const typed = draft.trim();
    const wanted = parseDurationInput(draft);
    // Whatever happens the box goes back to showing the item: a refused entry leaves the
    // length alone, and an accepted one is re-read from the timeline, clamps included.
    setDraft(null);
    if (wanted === null) {
      setOutcome({ kind: 'rejected', text: typed, atMs: valueMs });
      return;
    }
    const gotMs = commit(wanted);
    setOutcome(
      gotMs === null || gotMs === wanted ? null : { kind: 'clamped', askedMs: wanted, atMs: gotMs },
    );
  };

  // A note only speaks for the length it was produced at. Anything that has moved the item
  // since — an edge drag, a regenerated transition landing — has answered the user already.
  const standing = outcome !== null && outcome.atMs === valueMs ? outcome : null;

  return {
    value: draft ?? durationInputValue(valueMs),
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      setDraft(e.target.value);
      setOutcome(null);
    },
    onBlur: commitDraft,
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitDraft();
      } else if (e.key === 'Escape') {
        // Escape is handled on `window` *before* the guard that leaves typing alone, so
        // without this it would clear the box and close the film panel behind it.
        e.stopPropagation();
        setDraft(null);
        setOutcome(null);
      }
    },
    /** The length that was asked for and not given — `null` while the box got its way. */
    refusedMs: standing?.kind === 'clamped' ? standing.askedMs : null,
    /** What was typed that was not a length at all — `null` when the entry parsed. */
    rejectedText: standing?.kind === 'rejected' ? standing.text : null,
  };
}

type DurationField = ReturnType<typeof useDurationField>;

/** Where a card's note about the Duration box lives, so the box can point a reader at it. */
function noteId(id: string): string {
  return `${id}-note`;
}

/** The Duration row: the same `.kv` shape as the rows around it, with the value typed. */
function DurationRow({ id, field }: { id: string; field: DurationField }) {
  const described = field.refusedMs !== null || field.rejectedText !== null;
  return (
    <div className="kv">
      {/* The unit is on screen as the `s` beside the box; this is the same fact for a
          screen reader, which would otherwise hear a bare number with no scale. */}
      <label htmlFor={id}>
        Duration<span className="visually-hidden"> in seconds</span>
      </label>
      <span className="num">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={field.value}
          onChange={field.onChange}
          onBlur={field.onBlur}
          onKeyDown={field.onKeyDown}
          // Points at the note below only while there is one, so the box is never described
          // by an element that is not on the page.
          aria-describedby={described ? noteId(id) : undefined}
        />
        <span aria-hidden="true">s</span>
      </span>
    </div>
  );
}

/**
 * What the box has to say about the last thing typed into it, and nothing when it has
 * nothing to say. `limit` is the card's own sentence for a wall — the walls differ by what
 * kind of thing is selected — while a value that is not a length at all reads the same
 * everywhere, because it is about the typing rather than the item.
 *
 * `role="status"` because a rejected entry is otherwise invisible: the box quietly puts the
 * old number back, which a screen reader has no way to notice.
 */
function DurationNote({ id, field, limit }: { id: string; field: DurationField; limit: string }) {
  if (field.rejectedText !== null) {
    return (
      <p className="hint" id={noteId(id)} role="status">
        {field.rejectedText === ''
          ? 'Type a length in seconds, like 4.5.'
          : `“${field.rejectedText}” is not a length — type seconds, like 4.5.`}
      </p>
    );
  }
  if (field.refusedMs !== null) {
    return (
      <p className="hint" id={noteId(id)} role="status">
        {limit}
      </p>
    );
  }
  return null;
}

/** Why the timeline would not run this clip for as long as was asked. */
function clipLimitNote(clip: Clip, sourceDurationMs: number | undefined): string {
  if (clip.durationMs === MIN_CLIP_DURATION_MS) {
    return `A clip runs for at least ${formatDuration(MIN_CLIP_DURATION_MS)}.`;
  }
  if (clip.kind === 'photo') {
    return `A photo is held for at most ${MAX_PHOTO_DURATION_MS / 60_000} minutes.`;
  }
  if (sourceDurationMs === undefined) {
    return 'Still reading this file’s length — it can only be shortened until that arrives.';
  }
  return `${clip.name} runs ${formatDuration(sourceDurationMs - clip.trimStartMs)} from here.`;
}

/** The same, for a sound: no photo cap, and its only ceiling is the file. */
function audioLimitNote(track: AudioTrack, sourceDurationMs: number | undefined): string {
  if (track.durationMs === MIN_CLIP_DURATION_MS) {
    return `A sound runs for at least ${formatDuration(MIN_CLIP_DURATION_MS)}.`;
  }
  if (sourceDurationMs === undefined) {
    return 'Still reading this file’s length — it can only be shortened until that arrives.';
  }
  return `${track.name} runs ${formatDuration(sourceDurationMs - track.trimStartMs)} from here.`;
}

/** A selected audio track: where it sits, how long it runs, how loud it is, and a mute switch. */
function AudioCard({ track }: { track: AudioTrack }) {
  const assets = useEditor((s) => s.assets);
  const setAudioVolume = useEditor((s) => s.setAudioVolume);
  const toggleAudioMute = useEditor((s) => s.toggleAudioMute);
  const setAudioDuration = useEditor((s) => s.setAudioDuration);
  const duration = useDurationField(track.durationMs, (ms) => setAudioDuration(track.id, ms));

  return (
    <div className="card">
      <div className="card__head">
        <span aria-hidden="true">♪</span> {track.name}
      </div>
      <div className="card__body">
        <div className="kv">
          <span>Starts at</span>
          <b>{formatTimecode(track.startMs)}</b>
        </div>
        <DurationRow id="audio-duration" field={duration} />
        <div className="kv">
          <span>Type</span>
          <b>audio</b>
        </div>
        <Slider
          label="Volume"
          min={0}
          max={1}
          step={0.01}
          value={track.volume}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(volume) => setAudioVolume(track.id, volume)}
        />
        <button type="button" className="block-btn" onClick={() => toggleAudioMute(track.id)}>
          {track.muted ? '🔊 Unmute track' : '🔇 Mute track'}
        </button>
        <DurationNote
          id="audio-duration"
          field={duration}
          limit={audioLimitNote(track, assets[track.assetId]?.durationMs)}
        />
        <p className="hint">
          Type a length above, or drag the sound along its lane to move it and its edges to
          trim it. Muted tracks are left out of the export.
        </p>
      </div>
    </div>
  );
}

function InspectorBody({ clip }: { clip: Clip }) {
  const assets = useEditor((s) => s.assets);
  const setClipDuration = useEditor((s) => s.setClipDuration);
  const duration = useDurationField(clip.durationMs, (ms) => setClipDuration(clip.id, ms));

  return (
    <>
      <div className="card">
        <div className="card__head">
          <span aria-hidden="true">{clip.kind === 'photo' ? '▣' : '▶'}</span> {clip.name}
        </div>
        <div className="card__body">
          <div className="kv">
            <span>Starts at</span>
            <b>{formatTimecode(clip.startMs)}</b>
          </div>
          <DurationRow id="clip-duration" field={duration} />
          <div className="kv">
            <span>Type</span>
            <b>{clip.ai ? 'AI generated' : clip.kind}</b>
          </div>
          {clip.ai && !clip.transition && (
            <div className="kv">
              <span>Prompt</span>
              <b>{clip.ai.prompt}</b>
            </div>
          )}

          <DurationNote
            id="clip-duration"
            field={duration}
            limit={clipLimitNote(clip, assets[clip.assetId]?.durationMs)}
          />

          {!clip.transition && (
            <p className="hint">
              Put another clip beside this one and tap the ✦ on their cut to bridge them with
              an AI transition.
            </p>
          )}
        </div>
      </div>

      {clip.transition && <TransitionCard clip={clip} />}
    </>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  format,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field-row">
      <label htmlFor={`kf-${label}`}>{label}</label>
      <input
        id={`kf-${label}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="value">{format(value)}</span>
    </div>
  );
}

function RunningCard({ generation, heading }: { generation: Generation; heading: string }) {
  const cancel = useEditor((s) => s.cancelGeneration);
  const running = generation.status === 'running';

  return (
    <div className="card card--ai">
      <div className="card__head">
        ✨ {running ? 'Rendering' : 'Queued'} · {heading}
      </div>
      <div className="card__body">
        <div className="kv">
          <span>Status</span>
          <b>{generation.status.toUpperCase()}</b>
        </div>
        <div className="kv">
          <span>Model</span>
          <b>{modelLabel(generation.modelId)}</b>
        </div>
        {generation.jobId && (
          <div className="kv">
            <span>Job</span>
            <b>{generation.jobId}</b>
          </div>
        )}
        <div className="kv">
          <span>Progress</span>
          <b>{Math.round(generation.progress * 100)}%</b>
        </div>
        <div className="progress">
          <i style={{ width: `${Math.max(generation.progress * 100, 3)}%` }} />
        </div>

        {generation.slow && (
          <div className="callout">
            <b>Taking longer than usual</b>
            Jobs normally finish in about 45–90 s. This one is still running — your edits are safe
            and it will land on the timeline when it is done.
          </div>
        )}

        <div className="btn-row">
          <button type="button" onClick={() => void cancel(generation.id)}>
            Cancel
          </button>
        </div>
        <p className="hint">Runs in the background — keep editing.</p>
      </div>
    </div>
  );
}

function FailedCard({ generation, heading }: { generation: Generation; heading: string }) {
  const dismiss = useEditor((s) => s.dismissGeneration);
  const retry = useEditor((s) => s.retryGeneration);
  const error = generation.error;

  return (
    <div className="card card--error" role="alert">
      <div className="card__head">✕ Generation failed · {heading}</div>
      <div className="card__body">
        <div className="errbox">
          <b>{error?.title ?? 'Generation failed'}</b>
          {error?.message ?? 'The job did not complete.'}
          {/* Which backend answered — a report from a stale process is otherwise
              indistinguishable from one produced by the current build. */}
          {error?.build && <div className="hint">SolCut backend {error.build}</div>}
        </div>
        <div className="btn-row">
          {error?.retryable !== false && (
            <button type="button" className="primary" onClick={() => retry(generation.id)}>
              Retry
            </button>
          )}
          <button type="button" onClick={() => dismiss(generation.id)}>
            Dismiss
          </button>
        </div>
        <p className="hint">Dismissing leaves the timeline exactly as it was. The prompt is kept.</p>
      </div>
    </div>
  );
}

/**
 * A selected cut: the whole transition flow with zero required typing. The prompt box is
 * optional (empty means the default), and only the big button spends anything.
 *
 * What the card shows follows the pair. Every kind of cut can be bridged, but only one with
 * a still on it can have that still stood in for, so the landing toggle is present for a
 * photo on either side and absent — not disabled — between two videos.
 */
function CutCard({ a, b }: { a: Clip; b: Clip }) {
  const settings = useEditor((s) => s.settings);
  const modelId = useEditor((s) => s.modelId);
  const ffmpegAvailable = useEditor((s) => s.ffmpegAvailable);
  const assets = useEditor((s) => s.assets);
  const generations = useEditor((s) => s.generations);
  const cutPrompts = useEditor((s) => s.cutPrompts);
  const cutModes = useEditor((s) => s.cutModes);
  const animateRun = useEditor((s) => s.animateRun);
  const setCutPrompt = useEditor((s) => s.setCutPrompt);
  const setCutMode = useEditor((s) => s.setCutMode);
  const startCutGeneration = useEditor((s) => s.startCutGeneration);
  const openSettings = useEditor((s) => s.openSettings);

  const heading = `${a.name} → ${b.name}`;
  const generation = Object.values(generations).find(
    (g) =>
      g.target.kind === 'cut' &&
      g.target.replacesClipId === undefined &&
      g.target.afterClipId === a.id &&
      g.target.beforeClipId === b.id &&
      g.status !== 'cancelled' &&
      g.status !== 'succeeded',
  );

  if (generation && (generation.status === 'queued' || generation.status === 'running')) {
    return <RunningCard generation={generation} heading={heading} />;
  }
  if (generation?.status === 'failed') {
    return <FailedCard generation={generation} heading={heading} />;
  }

  const prompt = cutPrompts[`${a.id}:${b.id}`] ?? '';
  const mode = resolveCutMode({ cutModes, animateRun }, a, b);
  // What the pair can do at all. Two videos have no still to stand in for, so there is no
  // choice to offer — the control is left out rather than shown greyed with an excuse.
  const offersReplace = cutOffersReplace(a, b);
  const bothPhotos = a.kind === 'photo' && b.kind === 'photo';
  // The run flips the *fallback* to insert (a replace landing would consume clips out from
  // under the legs still behind it); an explicit pick is always the user's own.
  const runFlipped =
    offersReplace && animateRun !== null && cutModes[`${a.id}:${b.id}`] === undefined;
  // Asked of the backend the selector is showing, not of Higgsfield: on a machine with a
  // coding-agent CLI and no Higgsfield this card is perfectly able to render.
  const notReady = readinessHint(modelId, settings, ffmpegAvailable);
  const assetA = assets[a.assetId];
  const assetB = assets[b.assetId];
  const offline = !assetA || !assetB || assetA.missing || assetB.missing;
  const gapMs = b.startMs - (a.startMs + a.durationMs);

  return (
    <div className="card card--ai">
      <div className="card__head">✦ Transition · {heading}</div>
      <div className="card__body">
        <p className="hint" style={{ marginTop: 0 }}>
          {modelLabel(modelId)} animates from the last frame of <b>{a.name}</b> to the first
          frame of <b>{b.name}</b>.{' '}
          {mode === 'replace' ? (
            bothPhotos ? (
              <>The finished clip stands in the photos{'’'} place — they stay in the media bin.</>
            ) : (
              <>
                The finished clip stands in the photo{'’'}s place — only the still is replaced,
                and it stays in the media bin.
              </>
            )
          ) : (
            <>
              The finished clip lands between {bothPhotos ? 'the photos' : 'them'}
              {gapMs > 0 && <>, filling the {formatDuration(gapMs)} gap</>}.
            </>
          )}
          {runFlipped && <> While Animate all runs, new transitions keep the photos.</>}
        </p>
        <label className="visually-hidden" htmlFor="cut-prompt">
          Describe the transition between the two clips
        </label>
        <textarea
          id="cut-prompt"
          className="prompt"
          placeholder={`${DEFAULT_TRANSITION_PROMPT} (default) — or describe your own…`}
          value={prompt}
          onChange={(e) => setCutPrompt(e.target.value)}
        />
        <div className="chips">
          {TRANSITION_SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className="chip"
              onClick={() => setCutPrompt(prompt ? `${prompt.trim()}, ${s}` : s)}
            >
              + {s}
            </button>
          ))}
        </div>

        <ModelSelect id="cut-model" />

        {notReady ? (
          <NotReady hint={notReady} onOpenSettings={openSettings} />
        ) : (
          <>
            <button
              type="button"
              className="block-btn"
              disabled={offline}
              onClick={() => startCutGeneration(a.id, b.id)}
            >
              ✦ Generate transition
            </button>
            {offersReplace && (
              <button
                type="button"
                className="linklike"
                aria-pressed={mode === 'insert'}
                onClick={() => setCutMode(mode === 'insert' ? 'replace' : 'insert')}
              >
                {mode === 'insert'
                  ? `Replace the photo${bothPhotos ? 's' : ''} instead`
                  : `Keep the photo${bothPhotos ? 's' : ''} on the track instead`}
              </button>
            )}
            <p className="hint">
              {offline
                ? 'A clip on this cut has no media — re-import it first.'
                : 'No typing needed — leaving this empty uses the default prompt.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A selected transition clip: what made it, an editable prompt, and one-tap Regenerate —
 * reading the clips around it now, or, for a replace-mode clip that consumed the pair's
 * stills, their assets still in the bin. Staleness is worn, never acted on.
 */
function TransitionCard({ clip }: { clip: Clip }) {
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const settings = useEditor((s) => s.settings);
  const modelId = useEditor((s) => s.modelId);
  const ffmpegAvailable = useEditor((s) => s.ffmpegAvailable);
  const generations = useEditor((s) => s.generations);
  const setTransitionPrompt = useEditor((s) => s.setTransitionPrompt);
  const regenerateTransition = useEditor((s) => s.regenerateTransition);
  const openSettings = useEditor((s) => s.openSettings);

  const transition = clip.transition;
  if (!transition) return null;

  const replaced = transition.mode === 'replace';
  const staleness = transitionStaleness(clips, clip.id, assets);
  const fromName = assets[transition.from.assetId]?.name ?? 'missing source';
  const toName = assets[transition.to.assetId]?.name ?? 'missing source';

  const generation = Object.values(generations).find(
    (g) =>
      g.target.kind === 'cut' &&
      g.target.replacesClipId === clip.id &&
      g.status !== 'cancelled' &&
      g.status !== 'succeeded',
  );
  if (generation && (generation.status === 'queued' || generation.status === 'running')) {
    return <RunningCard generation={generation} heading="Regenerating transition" />;
  }
  if (generation?.status === 'failed') {
    return <FailedCard generation={generation} heading="Transition" />;
  }

  const notReady = readinessHint(modelId, settings, ffmpegAvailable);

  return (
    <div className="card card--ai">
      <div className="card__head">✦ AI transition</div>
      <div className="card__body">
        <div className="kv">
          <span>From</span>
          <b>{fromName}</b>
        </div>
        <div className="kv">
          <span>To</span>
          <b>{toName}</b>
        </div>
        <label className="visually-hidden" htmlFor="transition-prompt">
          Describe this transition
        </label>
        <textarea
          id="transition-prompt"
          className="prompt"
          placeholder={`${DEFAULT_TRANSITION_PROMPT} (default) — or describe your own…`}
          value={transition.prompt}
          onChange={(e) => setTransitionPrompt(clip.id, e.target.value)}
        />

        <ModelSelect id="transition-model" />

        {staleness === 'stale' && (
          <div className="callout">
            <b>Sources changed</b>
            The clips around this transition were reordered, replaced or trimmed since it was
            rendered. It still plays — regenerate it when you want it to match.
          </div>
        )}
        {staleness === 'orphaned' && (
          <div className="callout">
            <b>Source missing</b>
            {replaced
              ? 'A source is no longer in the media bin, so there is nothing to regenerate this from. It still plays and exports.'
              : 'This transition no longer sits between two clips, so there is nothing to regenerate it from. It still plays and exports.'}
          </div>
        )}

        {notReady ? (
          <NotReady hint={notReady} onOpenSettings={openSettings} />
        ) : (
          <>
            <button
              type="button"
              className="block-btn"
              disabled={staleness === 'orphaned'}
              onClick={() => regenerateTransition(clip.id)}
            >
              ⟳ Regenerate transition
            </button>
            <p className="hint">
              {replaced
                ? 'Regenerates from its two sources — a still from the media bin, footage from the clip still on the track. Trim, drag or delete this clip like any video.'
                : 'Regenerates from the clips around it as they are now. Trim, drag or delete this clip like any video.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
