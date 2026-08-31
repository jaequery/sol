import { useEditor } from '../state/store';
import {
  DEFAULT_TRANSITION_PROMPT,
  type AudioTrack,
  type Clip,
  type Generation,
} from '../types/project';
import { formatDuration, formatTimecode, photoCuts, transitionStaleness } from '../lib/timeline';
import { modelLabel } from '../lib/backend';
import { ModelSelect } from './ModelSelect';

const TRANSITION_SUGGESTIONS = ['crossfade morph', 'whip pan', 'zoom through', 'dreamy dissolve'];

export function Inspector() {
  const selection = useEditor((s) => s.selection);
  const clips = useEditor((s) => s.clips);
  const audioTracks = useEditor((s) => s.audioTracks);
  const clip = selection.kind === 'clip' ? clips.find((c) => c.id === selection.clipId) : undefined;
  const track =
    selection.kind === 'audio' ? audioTracks.find((t) => t.id === selection.trackId) : undefined;

  // A selected cut is only real while its pair still forms one — two photos side by side,
  // touching or with a gap a transition would fill.
  let cutPair: { a: Clip; b: Clip } | undefined;
  if (selection.kind === 'cut') {
    const stands = photoCuts(clips).some(
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
          <AudioCard track={track} />
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
          <InspectorBody clip={clip} />
        )}
      </div>
    </div>
  );
}

/** A selected audio track: where it sits, how loud it is, and a mute switch. */
function AudioCard({ track }: { track: AudioTrack }) {
  const setAudioVolume = useEditor((s) => s.setAudioVolume);
  const toggleAudioMute = useEditor((s) => s.toggleAudioMute);

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
        <div className="kv">
          <span>Duration</span>
          <b>{formatDuration(track.durationMs)}</b>
        </div>
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
        <p className="hint">
          Drag the sound along its lane to move it, or its edges to trim it. Muted tracks are
          left out of the export.
        </p>
      </div>
    </div>
  );
}

function InspectorBody({ clip }: { clip: Clip }) {
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
          <div className="kv">
            <span>Duration</span>
            <b>{formatDuration(clip.durationMs)}</b>
          </div>
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

          {clip.kind === 'photo' && (
            <p className="hint">
              Put another photo beside this one and tap the ✦ on their cut to bridge them with
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
 */
function CutCard({ a, b }: { a: Clip; b: Clip }) {
  const settings = useEditor((s) => s.settings);
  const assets = useEditor((s) => s.assets);
  const generations = useEditor((s) => s.generations);
  const cutPrompts = useEditor((s) => s.cutPrompts);
  const setCutPrompt = useEditor((s) => s.setCutPrompt);
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
  const connected = settings?.configured ?? false;
  const assetA = assets[a.assetId];
  const assetB = assets[b.assetId];
  const offline = !assetA || !assetB || assetA.missing || assetB.missing;
  const gapMs = b.startMs - (a.startMs + a.durationMs);

  return (
    <div className="card card--ai">
      <div className="card__head">✦ Transition · {heading}</div>
      <div className="card__body">
        <p className="hint" style={{ marginTop: 0 }}>
          Higgsfield animates from the last frame of <b>{a.name}</b> to the first frame of{' '}
          <b>{b.name}</b>.
          {gapMs > 0 && (
            <> The finished clip fills the {formatDuration(gapMs)} gap between them.</>
          )}
        </p>
        <label className="visually-hidden" htmlFor="cut-prompt">
          Describe the transition between the two photos
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

        {!connected ? (
          <div className="callout">
            <b>Connect Higgsfield to generate</b>
            No API key is stored yet. Nothing has been sent.
            <button type="button" onClick={openSettings}>
              Open settings →
            </button>
          </div>
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
            <p className="hint">
              {offline
                ? 'A photo on this cut has no media — re-import it first.'
                : 'No typing needed — leaving this empty uses the default prompt.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A selected transition clip: what made it, an editable prompt, and one-tap Regenerate
 * that reads whatever photos stand around it now. Staleness is worn, never acted on.
 */
function TransitionCard({ clip }: { clip: Clip }) {
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const settings = useEditor((s) => s.settings);
  const generations = useEditor((s) => s.generations);
  const setTransitionPrompt = useEditor((s) => s.setTransitionPrompt);
  const regenerateTransition = useEditor((s) => s.regenerateTransition);
  const openSettings = useEditor((s) => s.openSettings);

  const transition = clip.transition;
  if (!transition) return null;

  const staleness = transitionStaleness(clips, clip.id);
  const fromName = assets[transition.from.assetId]?.name ?? 'missing photo';
  const toName = assets[transition.to.assetId]?.name ?? 'missing photo';

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

  const connected = settings?.configured ?? false;

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
            The photos around this transition were reordered or replaced since it was
            rendered. It still plays — regenerate it when you want it to match.
          </div>
        )}
        {staleness === 'orphaned' && (
          <div className="callout">
            <b>Source missing</b>
            This transition no longer sits between two photos, so there is nothing to regenerate
            it from. It still plays and exports.
          </div>
        )}

        {!connected ? (
          <div className="callout">
            <b>Connect Higgsfield to regenerate</b>
            No API key is stored yet. Nothing has been sent.
            <button type="button" onClick={openSettings}>
              Open settings →
            </button>
          </div>
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
              Regenerates from the photos around it as they are now. Trim, drag or delete this
              clip like any video.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
