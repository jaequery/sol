import { useEditor } from '../state/store';
import { MAX_SCALE, MIN_SCALE, type Clip, type Generation, type Transform2D } from '../types/project';
import { findSegment, formatDuration, formatTimecode, segmentsOf, sortKeyframes } from '../lib/timeline';

const PROMPT_SUGGESTIONS = ['dolly in', 'slow parallax', 'orbit left', 'handheld drift', 'zoom out'];

export function Inspector() {
  const selection = useEditor((s) => s.selection);
  const clips = useEditor((s) => s.clips);
  const clip = selection.kind === 'none' ? undefined : clips.find((c) => c.id === selection.clipId);

  return (
    <div className="col">
      <div className="panel-head">Inspector</div>
      <div className="inspector">
        {!clip ? (
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

function InspectorBody({ clip }: { clip: Clip }) {
  const selection = useEditor((s) => s.selection);
  const addKeyframeAtPlayhead = useEditor((s) => s.addKeyframeAtPlayhead);

  const keyframes = sortKeyframes(clip.keyframes);
  const keyframe =
    selection.kind === 'keyframe' ? keyframes.find((k) => k.id === selection.keyframeId) : undefined;

  return (
    <>
      <div className="card">
        <div className="card__head">
          <span aria-hidden="true">{clip.kind === 'photo' ? '▣' : '▶'}</span> {clip.name}
        </div>
        <div className="card__body">
          <div className="kv">
            <span>Duration</span>
            <b>{formatDuration(clip.durationMs)}</b>
          </div>
          <div className="kv">
            <span>Type</span>
            <b>{clip.ai ? 'AI generated' : clip.kind}</b>
          </div>
          {clip.kind === 'photo' && (
            <div className="kv">
              <span>Keyframes</span>
              <b>{keyframes.length || 'none'}</b>
            </div>
          )}
          {clip.ai && (
            <div className="kv">
              <span>Prompt</span>
              <b>{clip.ai.prompt}</b>
            </div>
          )}

          {clip.kind === 'photo' && keyframes.length === 0 && (
            <>
              <button type="button" className="block-btn" onClick={addKeyframeAtPlayhead}>
                ◆ Add keyframe
              </button>
              <p className="hint">
                Keyframes set how the photo is framed over time. Add two and you can describe the
                motion between them for Higgsfield to animate.
              </p>
            </>
          )}
          {clip.kind === 'video' && !clip.ai && (
            <p className="hint">Videos play as-is. Keyframe animation applies to photos.</p>
          )}
        </div>
      </div>

      {keyframe && <TransformCard clip={clip} keyframeId={keyframe.id} transform={keyframe.transform} />}

      {clip.kind === 'photo' && keyframes.length > 0 && <AiCard clip={clip} />}
    </>
  );
}

function TransformCard({
  clip,
  keyframeId,
  transform,
}: {
  clip: Clip;
  keyframeId: string;
  transform: Transform2D;
}) {
  const update = useEditor((s) => s.updateSelectedKeyframe);
  const index = sortKeyframes(clip.keyframes).findIndex((k) => k.id === keyframeId);
  const at = clip.keyframes.find((k) => k.id === keyframeId)?.timeMs ?? 0;

  return (
    <div className="card">
      <div className="card__head">
        <span aria-hidden="true">◆</span> Keyframe {index + 1} · {formatTimecode(at)}
      </div>
      <div className="card__body">
        <Slider
          label="Scale"
          min={MIN_SCALE}
          max={MAX_SCALE}
          step={0.01}
          value={transform.scale}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(scale) => update({ scale })}
        />
        <Slider
          label="Position X"
          min={-100}
          max={100}
          step={0.5}
          value={transform.x}
          format={(v) => v.toFixed(1)}
          onChange={(x) => update({ x })}
        />
        <Slider
          label="Position Y"
          min={-100}
          max={100}
          step={0.5}
          value={transform.y}
          format={(v) => v.toFixed(1)}
          onChange={(y) => update({ y })}
        />
        <Slider
          label="Rotation"
          min={-180}
          max={180}
          step={1}
          value={transform.rotation}
          format={(v) => `${Math.round(v)}°`}
          onChange={(rotation) => update({ rotation })}
        />
        <Slider
          label="Opacity"
          min={0}
          max={1}
          step={0.01}
          value={transform.opacity}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(opacity) => update({ opacity })}
        />
      </div>
    </div>
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

/** The prompt for the segment between two keyframes, and whatever its generation is doing. */
function AiCard({ clip }: { clip: Clip }) {
  const selection = useEditor((s) => s.selection);
  const settings = useEditor((s) => s.settings);
  const generations = useEditor((s) => s.generations);
  const select = useEditor((s) => s.select);
  const setSegmentPrompt = useEditor((s) => s.setSegmentPrompt);
  const startGeneration = useEditor((s) => s.startGeneration);
  const openSettings = useEditor((s) => s.openSettings);

  const segments = segmentsOf(clip);

  if (segments.length === 0) {
    return (
      <div className="card card--ai card--disabled">
        <div className="card__head">✨ AI Segment</div>
        <div className="card__body">
          <textarea className="prompt" placeholder="Describe the motion…" disabled />
          <button type="button" className="block-btn" disabled>
            Generate animation
          </button>
          <p className="hint">Add a second keyframe to define a segment.</p>
        </div>
      </div>
    );
  }

  const active =
    selection.kind === 'segment'
      ? findSegment(clip, selection.fromKeyframeId, selection.toKeyframeId)
      : null;

  if (!active) {
    return (
      <div className="card card--ai">
        <div className="card__head">✨ AI Segment</div>
        <div className="card__body">
          <p className="hint" style={{ marginTop: 0 }}>
            Pick the segment between two keyframes to describe its motion.
          </p>
          <div className="btn-row" style={{ flexWrap: 'wrap' }}>
            {segments.map((segment, index) => (
              <button
                key={segment.fromKeyframeId}
                type="button"
                onClick={() =>
                  select({
                    kind: 'segment',
                    clipId: clip.id,
                    fromKeyframeId: segment.fromKeyframeId,
                    toKeyframeId: segment.toKeyframeId,
                  })
                }
              >
                KF{index + 1} → KF{index + 2}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const index = segments.findIndex((s) => s.fromKeyframeId === active.fromKeyframeId);
  const prompt = clip.prompts[active.fromKeyframeId] ?? '';
  const generation = Object.values(generations).find(
    (g) =>
      g.kind === 'segment' &&
      g.clipId === clip.id &&
      g.fromKeyframeId === active.fromKeyframeId &&
      g.status !== 'cancelled',
  );

  if (generation && (generation.status === 'queued' || generation.status === 'running')) {
    return <RunningCard generation={generation} index={index} />;
  }
  if (generation?.status === 'failed') {
    return <FailedCard generation={generation} index={index} />;
  }

  const connected = settings?.configured ?? false;
  const canGenerate = connected && prompt.trim().length > 0;

  return (
    <div className="card card--ai">
      <div className="card__head">
        ✨ AI Segment · KF{index + 1} → KF{index + 2}
      </div>
      <div className="card__body">
        <label className="visually-hidden" htmlFor="segment-prompt">
          Describe the motion between these two keyframes
        </label>
        <textarea
          id="segment-prompt"
          className="prompt"
          placeholder="Describe the motion between these two keyframes…"
          value={prompt}
          onChange={(e) => setSegmentPrompt(e.target.value)}
        />
        <div className="chips">
          {PROMPT_SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className="chip"
              onClick={() => setSegmentPrompt(prompt ? `${prompt.trim()}, ${s}` : s)}
            >
              + {s}
            </button>
          ))}
        </div>

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
              disabled={!canGenerate}
              onClick={() => void startGeneration()}
            >
              Generate animation · {formatDuration(active.durationMs)}
            </button>
            <p className="hint">
              {canGenerate
                ? 'Higgsfield renders the motion between the two keyframes and drops the clip back onto this segment.'
                : 'Describe the motion first.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function RunningCard({ generation, index }: { generation: Generation; index: number }) {
  const cancel = useEditor((s) => s.cancelGeneration);
  const running = generation.status === 'running';

  return (
    <div className="card card--ai">
      <div className="card__head">
        ✨ {running ? 'Rendering' : 'Queued'} · KF{index + 1} → KF{index + 2}
      </div>
      <div className="card__body">
        <div className="kv">
          <span>Status</span>
          <b>{generation.status.toUpperCase()}</b>
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

function FailedCard({ generation, index }: { generation: Generation; index: number }) {
  const dismiss = useEditor((s) => s.dismissGeneration);
  const retry = useEditor((s) => s.startGeneration);
  const error = generation.error;

  return (
    <div className="card card--error" role="alert">
      <div className="card__head">
        ✕ Generation failed · KF{index + 1} → KF{index + 2}
      </div>
      <div className="card__body">
        <div className="errbox">
          <b>{error?.title ?? 'Generation failed'}</b>
          {error?.message ?? 'The job did not complete.'}
        </div>
        <div className="btn-row">
          {error?.retryable !== false && (
            <button
              type="button"
              className="primary"
              onClick={() => {
                dismiss(generation.id);
                void retry();
              }}
            >
              Retry
            </button>
          )}
          <button type="button" onClick={() => dismiss(generation.id)}>
            Dismiss
          </button>
        </div>
        <p className="hint">Dismissing restores the plain photo segment. The prompt is kept.</p>
      </div>
    </div>
  );
}
