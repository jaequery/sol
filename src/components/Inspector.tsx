import { useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { resolveCutMode, useEditor } from '../state/store';
import {
  DEFAULT_TRANSITION_PROMPT,
  MAX_CLIP_ZOOM,
  MAX_PHOTO_DURATION_MS,
  MIN_CLIP_DURATION_MS,
  MIN_CLIP_ZOOM,
  type AudioTrack,
  type Clip,
  type ClipTransform,
  type Generation,
  type MediaAsset,
} from '../types/project';
import { clipTransform, isFullCrop, isIdentityTransform } from '../lib/transform';
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
import { Icon } from './Icon';

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
            <Icon name="diamond" size={22} />
            <b>Nothing selected</b>
            {clips.length === 0 && audioTracks.length === 0 ? (
              'Select a clip once something is on the timeline.'
            ) : (
              <>
                Select a clip, a sound, or the <Icon name="sparkle" size={11} className="icon--inline" />{' '}
                on a cut to edit it here.
              </>
            )}
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
      <p className="hint" id={noteId(id)} role="alert">
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
        <Icon name="music" size={15} />
        <span className="card__title">{track.name}</span>
      </div>
      <div className="card__body">
        <div className="kv">
          <span>Starts at</span>
          <b>{formatTimecode(track.startMs)}</b>
        </div>
        <DurationRow id="audio-duration" field={duration} />
        <Slider
          label="Volume"
          min={0}
          max={1}
          step={0.01}
          value={track.volume}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(volume) => setAudioVolume(track.id, volume)}
        />
        <DurationNote
          id="audio-duration"
          field={duration}
          limit={audioLimitNote(track, assets[track.assetId]?.durationMs)}
        />
        {/* A toggle, dressed as one: the accent fill is for the actions that render. */}
        <div className="btn-row">
          <button type="button" onClick={() => toggleAudioMute(track.id)}>
            <Icon name={track.muted ? 'volume' : 'volume-off'} size={14} />
            {track.muted ? 'Unmute track' : 'Mute track'}
          </button>
        </div>
        <p className="hint">Muted tracks are left out of the export.</p>
      </div>
    </div>
  );
}

function InspectorBody({ clip }: { clip: Clip }) {
  const assets = useEditor((s) => s.assets);
  const setClipDuration = useEditor((s) => s.setClipDuration);
  const duration = useDurationField(clip.durationMs, (ms) => setClipDuration(clip.id, ms));
  const asset = assets[clip.assetId];
  const offline = !asset || asset.missing === true || !asset.src;

  return (
    <>
      <div className="card">
        <div className="card__head">
          {offline ? (
            <Icon name="alert" size={15} />
          ) : (
            <Thumb asset={asset} />
          )}
          <span className="card__title">{clip.name}</span>
        </div>
        <div className="card__body">
          {/* The preview and the track both say it; the panel opened to learn more must too. */}
          {offline && (
            <div className="callout callout--lead" role="status">
              <b>Media offline</b>
              {clip.name} is no longer at its saved path. It keeps its place on the timeline,
              but export will refuse it by name until the file is back or re-imported.
            </div>
          )}
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
              Put another clip beside this one and tap the{' '}
              <Icon name="sparkle" size={11} className="icon--inline" /> on their cut to bridge
              them with an AI transition.
            </p>
          )}
        </div>
      </div>

      <TransformCard clip={clip} offline={offline} />

      {clip.transition && <TransitionCard clip={clip} />}
    </>
  );
}

/**
 * How the clip is framed: crop, zoom, quarter turn, mirrors — the five things that decide
 * what part of the picture the film shows and which way up it is.
 *
 * Every control writes straight to the clip and the preview redraws, because there is
 * nothing here worth a Cancel: each one is a single reversible step, and Reset undoes all
 * of them at once. Only the crop needs a mode, and it is a mode because the rectangle is
 * dragged over the picture rather than typed into this panel.
 */
function TransformCard({ clip, offline }: { clip: Clip; offline: boolean }) {
  const rotateClip = useEditor((s) => s.rotateClip);
  const flipClip = useEditor((s) => s.flipClip);
  const setClipZoom = useEditor((s) => s.setClipZoom);
  const setClipPan = useEditor((s) => s.setClipPan);
  const resetClipTransform = useEditor((s) => s.resetClipTransform);
  const beginCrop = useEditor((s) => s.beginCrop);
  const endCrop = useEditor((s) => s.endCrop);
  const cropping = useEditor((s) => s.croppingClipId === clip.id);

  const t = clipTransform(clip);
  const untouched = isIdentityTransform(t);

  return (
    <div className="card">
      <div className="card__head">
        <Icon name="move" size={15} />
        <span className="card__title">Transform</span>
      </div>
      <div className="card__body">
        <div className="kv">
          <span>Framing</span>
          <b>{framingSummary(t)}</b>
        </div>
        <Slider
          label="Zoom"
          min={MIN_CLIP_ZOOM}
          max={MAX_CLIP_ZOOM}
          step={0.05}
          value={t.zoom}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(zoom) => setClipZoom(clip.id, zoom)}
        />
        {/* Pan has nothing to move until the zoom has made somewhere to move it: at 1× the
            picture is exactly the frame, so the sliders would be two controls that do
            nothing. */}
        {t.zoom > MIN_CLIP_ZOOM && (
          <>
            <Slider
              label="Pan X"
              min={-1}
              max={1}
              step={0.01}
              value={t.offsetX}
              format={panLabel}
              onChange={(x) => setClipPan(clip.id, x, t.offsetY)}
            />
            <Slider
              label="Pan Y"
              min={-1}
              max={1}
              step={0.01}
              value={t.offsetY}
              format={panLabel}
              onChange={(y) => setClipPan(clip.id, t.offsetX, y)}
            />
          </>
        )}
        <div className="btn-row">
          <button type="button" onClick={() => rotateClip(clip.id, -1)}>
            <Icon name="rotate-ccw" size={14} />
            Rotate left
          </button>
          <button type="button" onClick={() => rotateClip(clip.id, 1)}>
            <Icon name="rotate-cw" size={14} />
            Rotate right
          </button>
        </div>
        <div className="btn-row">
          <button type="button" aria-pressed={t.flipH} onClick={() => flipClip(clip.id, 'h')}>
            <Icon name="flip-h" size={14} />
            Flip across
          </button>
          <button type="button" aria-pressed={t.flipV} onClick={() => flipClip(clip.id, 'v')}>
            <Icon name="flip-v" size={14} />
            Flip down
          </button>
        </div>
        <div className="btn-row">
          <button
            type="button"
            aria-pressed={cropping}
            disabled={offline}
            onClick={() => (cropping ? endCrop() : beginCrop(clip.id))}
          >
            <Icon name="crop" size={14} />
            {cropping ? 'Done cropping' : 'Crop'}
          </button>
          <button type="button" disabled={untouched} onClick={() => resetClipTransform(clip.id)}>
            <Icon name="refresh" size={14} />
            Reset
          </button>
        </div>
        <p className="hint">
          {offline
            ? 'The crop rectangle is dragged over the picture, and there is no picture to drag it over until the file is back.'
            : cropping
              ? 'Drag the rectangle on the preview, or its corners. The crop and the zoom stand down while you do.'
              : 'Framing applies to the whole clip, in the preview and in the export alike.'}
        </p>
      </div>
    </div>
  );
}

/** A pan reading: which way the frame has moved off centre, and how far. */
function panLabel(v: number): string {
  if (v === 0) return 'Centred';
  return `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}%`;
}

/** The framing in a phrase — what the card says before any of its controls are read. */
function framingSummary(t: ClipTransform): string {
  const parts: string[] = [];
  if (t.rotation !== 0) parts.push(`${t.rotation}°`);
  if (t.flipH && t.flipV) parts.push('flipped both ways');
  else if (t.flipH) parts.push('flipped across');
  else if (t.flipV) parts.push('flipped down');
  if (!isFullCrop(t.crop)) parts.push('cropped');
  if (t.zoom > MIN_CLIP_ZOOM) parts.push(`${Math.round(t.zoom * 100)}%`);
  return parts.length === 0 ? 'Original' : parts.join(' · ');
}

/** A frame of the thing the card is about — the same picture the bin and the track show. */
function Thumb({ asset }: { asset: MediaAsset | undefined }) {
  if (!asset || asset.missing || !asset.src) return null;
  return (
    <span className="card__thumb" aria-hidden="true">
      {asset.kind === 'video' ? (
        <video src={asset.src} muted preload="metadata" />
      ) : asset.kind === 'photo' ? (
        <img src={asset.src} alt="" draggable={false} />
      ) : null}
    </span>
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
        aria-valuetext={format(value)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="value">{format(value)}</span>
    </div>
  );
}

/** The two clips a render is about, as the rows every other card already uses. */
function PairRows({ from, to }: { from: string; to: string }) {
  return (
    <>
      <div className="kv">
        <span>From</span>
        <b>{from}</b>
      </div>
      <div className="kv">
        <span>To</span>
        <b>{to}</b>
      </div>
    </>
  );
}

/**
 * A render in flight. The head says what is happening in two words; the body names the pair,
 * the model, the job, and how far along it is — each fact once. The status row went with the
 * head that already carried it, and the job id keeps to one line with the whole of it a
 * hover away.
 */
function RunningCard({
  generation,
  pair,
  regenerating = false,
}: {
  generation: Generation;
  pair: { from: string; to: string };
  regenerating?: boolean;
}) {
  const cancel = useEditor((s) => s.cancelGeneration);
  const queued = generation.status === 'queued';
  const title = regenerating
    ? queued
      ? 'Queued regeneration'
      : 'Regenerating transition'
    : queued
      ? 'Queued transition'
      : 'Rendering transition';
  // The same reading the chip on the cut gives: the queue, a percentage once the backend
  // volunteers one, or the seconds elapsed until it does.
  const progress = queued
    ? 'In queue'
    : generation.progress > 0
      ? `${Math.round(generation.progress * 100)}%`
      : `${Math.round(generation.elapsedSecs)}s`;

  return (
    <div className="card card--ai">
      <div className="card__head">
        <Icon name="spinner" size={15} className="icon--spin" />
        <span className="card__title">{title}</span>
      </div>
      <div className="card__body">
        <PairRows from={pair.from} to={pair.to} />
        <div className="kv">
          <span>Model</span>
          <b>{modelLabel(generation.modelId)}</b>
        </div>
        {generation.jobId && (
          <div className="kv">
            <span>Job</span>
            <b className="kv__id" title={generation.jobId}>
              {generation.jobId}
            </b>
          </div>
        )}
        <div className="progress-row" role="status" aria-label={`Progress ${progress}`}>
          <div className="progress">
            <i style={{ width: `${Math.max(generation.progress * 100, 3)}%` }} />
          </div>
          <b>{progress}</b>
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

function FailedCard({
  generation,
  title,
  pair,
}: {
  generation: Generation;
  title: string;
  pair: { from: string; to: string };
}) {
  const dismiss = useEditor((s) => s.dismissGeneration);
  const retry = useEditor((s) => s.retryGeneration);
  const error = generation.error;

  return (
    <div className="card card--error" role="alert">
      <div className="card__head">
        <Icon name="x" size={15} />
        <span className="card__title">{title}</span>
      </div>
      <div className="card__body">
        <PairRows from={pair.from} to={pair.to} />
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

  const pair = { from: a.name, to: b.name };
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
    return <RunningCard generation={generation} pair={pair} />;
  }
  if (generation?.status === 'failed') {
    return <FailedCard generation={generation} title="Generation failed" pair={pair} />;
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
      <div className="card__head">
        <Icon name="sparkle" size={15} />
        {/* The names are in the sentence below, beside the frames they belong to; up here
            two long filenames only wrapped the head onto three lines. */}
        <span className="card__title">Transition</span>
      </div>
      <div className="card__body">
        <div className="card__pair" aria-hidden="true">
          <Thumb asset={assetA} />
          <Icon name="arrow-right" size={12} />
          <Thumb asset={assetB} />
        </div>
        <p className="hint">
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
              <Icon name="sparkle" size={14} /> Generate transition
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
            {/* The placeholder already says the box may stay empty; only the refusal
                needs a sentence. */}
            {offline && <p className="hint">A clip on this cut has no media — re-import it first.</p>}
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
  const pair = { from: fromName, to: toName };
  if (generation && (generation.status === 'queued' || generation.status === 'running')) {
    return <RunningCard generation={generation} pair={pair} regenerating />;
  }
  if (generation?.status === 'failed') {
    return <FailedCard generation={generation} title="Regeneration failed" pair={pair} />;
  }

  const notReady = readinessHint(modelId, settings, ffmpegAvailable);

  return (
    <div className="card card--ai">
      <div className="card__head">
        <Icon name="sparkle" size={15} />
        <span className="card__title">AI transition</span>
      </div>
      <div className="card__body">
        <SourceRow label="From" name={fromName} clipId={transition.from.clipId} />
        <SourceRow label="To" name={toName} clipId={transition.to.clipId} />
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
              <Icon name="refresh" size={14} /> Regenerate transition
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

/**
 * One side of a transition. While the source clip is still on the track the name is a
 * button that selects it; a source that was consumed by a replace landing is just named.
 */
function SourceRow({ label, name, clipId }: { label: string; name: string; clipId: string }) {
  const clips = useEditor((s) => s.clips);
  const select = useEditor((s) => s.select);
  const onTrack = clips.some((c) => c.id === clipId);
  return (
    <div className="kv">
      <span>{label}</span>
      {onTrack ? (
        <button
          type="button"
          className="kv__link"
          title="Select this clip on the timeline"
          onClick={() => select({ kind: 'clip', clipId })}
        >
          {name}
        </button>
      ) : (
        <b>{name}</b>
      )}
    </div>
  );
}
