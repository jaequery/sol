import { useMemo, useRef, useState } from 'react';
import { useEditor } from '../state/store';
import type { Clip, Generation } from '../types/project';
import {
  formatDuration,
  formatTimecode,
  insertIndexAt,
  layout,
  segmentsOf,
  sortKeyframes,
  totalDurationMs,
  truncateName,
} from '../lib/timeline';

const MIN_CLIP_PX = 14;
/** Below this, keyframe diamonds would overlap, so they collapse into a cluster chip. */
const MIN_KEYFRAME_GAP_PX = 14;

/** The single track: clips, their keyframes, the segments between them, and the playhead. */
export function Timeline() {
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const selection = useEditor((s) => s.selection);
  const generations = useEditor((s) => s.generations);
  const playheadMs = useEditor((s) => s.playheadMs);
  const pxPerSecond = useEditor((s) => s.pxPerSecond);
  const select = useEditor((s) => s.select);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const addFiles = useEditor((s) => s.addFiles);
  const addPaths = useEditor((s) => s.addPaths);
  const addKeyframeAtPlayhead = useEditor((s) => s.addKeyframeAtPlayhead);
  const splitAtPlayhead = useEditor((s) => s.splitAtPlayhead);
  const deleteSelection = useEditor((s) => s.deleteSelection);

  const trackRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<{ count: number; ratio: number } | null>(null);

  const placed = useMemo(() => layout(clips), [clips]);
  const total = totalDurationMs(clips);
  const toPx = (ms: number) => (ms / 1000) * pxPerSecond;
  const width = Math.max(toPx(total), 320);

  const selectedClipId = selection.kind === 'none' ? null : selection.clipId;
  const selectedClip = clips.find((c) => c.id === selectedClipId);
  const canKeyframe = selectedClip?.kind === 'photo';

  const activeGenerations = Object.values(generations).filter(
    (g) => g.status === 'queued' || g.status === 'running' || g.status === 'failed',
  );

  function ratioFromEvent(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 1;
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  }

  function onDragOver(e: React.DragEvent) {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragState({
      count: e.dataTransfer.items?.length ?? 1,
      ratio: ratioFromEvent(e.clientX),
    });
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const ratio = ratioFromEvent(e.clientX);
    setDragState(null);

    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;

    const index = insertIndexAt(clips, ratio);
    // A real OS drop inside Tauri carries a path; a browser drop does not.
    const paths = files
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => Boolean(p));

    if (paths.length === files.length && paths.length > 0) {
      await addPaths(paths, index);
    } else {
      await addFiles(files, index);
    }
  }

  function onScrub(e: React.MouseEvent) {
    if (e.target !== e.currentTarget) return;
    setPlayhead(ratioFromEvent(e.clientX) * total);
  }

  return (
    <div className="timeline">
      <div className="timeline__bar">
        <button type="button" className="tool tool--on" aria-label="Select tool">
          ⌖
        </button>
        <button
          type="button"
          className="tool"
          aria-label="Split at playhead"
          onClick={splitAtPlayhead}
          disabled={clips.length === 0}
        >
          ✂
        </button>
        <button
          type="button"
          className={`tool tool--wide ${canKeyframe ? 'tool--on' : ''}`}
          aria-label="Add keyframe at playhead"
          onClick={addKeyframeAtPlayhead}
          disabled={!canKeyframe}
          title={canKeyframe ? undefined : 'Select a photo clip first'}
        >
          ◆ Add keyframe
        </button>
        <button
          type="button"
          className="tool"
          aria-label="Delete selection"
          onClick={deleteSelection}
          disabled={selection.kind === 'none'}
        >
          🗑
        </button>

        <label className="timeline__zoom">
          ZOOM
          <input
            type="range"
            min={12}
            max={160}
            value={pxPerSecond}
            aria-label="Timeline zoom"
            onChange={(e) => useEditor.setState({ pxPerSecond: Number(e.target.value) })}
          />
          {Math.round((pxPerSecond / 46) * 100)}%
        </label>
      </div>

      <div className="timeline__scroll">
        <div className="timeline__inner" style={{ width }}>
          <Ruler total={total} pxPerSecond={pxPerSecond} width={width} />

          <div
            className={`track ${dragState ? 'track--drop-target' : ''}`}
            ref={trackRef}
            data-testid="timeline-track"
            onDragOver={onDragOver}
            onDragLeave={() => setDragState(null)}
            onDrop={onDrop}
            onClick={onScrub}
          >
            {clips.length === 0 ? (
              <div className={`dropzone ${dragState ? 'dropzone--hot' : ''}`}>
                {dragState ? (
                  <div>
                    <b>
                      Release to add {dragState.count} {dragState.count === 1 ? 'file' : 'files'}
                    </b>
                    They land side by side on one track
                  </div>
                ) : (
                  <div>
                    <b>Drop photos and videos here</b>
                    One timeline — they land side by side in drop order
                  </div>
                )}
              </div>
            ) : (
              <div className="track__clips">
                {placed.map(({ clip, startMs }) => (
                  <TimelineClip
                    key={clip.id}
                    clip={clip}
                    startMs={startMs}
                    src={assets[clip.assetId]?.src}
                    offline={!assets[clip.assetId]}
                    toPx={toPx}
                    pxPerSecond={pxPerSecond}
                    selection={selection}
                    onSelect={select}
                  />
                ))}

                {activeGenerations.map((generation) => (
                  <GenerationOverlay
                    key={generation.id}
                    generation={generation}
                    clips={clips}
                    toPx={toPx}
                  />
                ))}

                <div className="playhead" style={{ left: toPx(playheadMs) }} />
              </div>
            )}

            {dragState && clips.length > 0 && (
              <div
                className="insert-marker"
                style={{ left: toPx(insertOffsetMs(clips, dragState.ratio)) }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function insertOffsetMs(clips: Clip[], ratio: number): number {
  const index = insertIndexAt(clips, ratio);
  return clips.slice(0, index).reduce((sum, c) => sum + c.durationMs, 0);
}

function Ruler({
  total,
  pxPerSecond,
  width,
}: {
  total: number;
  pxPerSecond: number;
  width: number;
}) {
  // Keep the labels roughly 70px apart however far the track is zoomed.
  const step = [1, 2, 5, 10, 15, 30, 60].find((s) => s * pxPerSecond >= 70) ?? 60;
  const ticks = Math.floor(Math.max(total / 1000, width / pxPerSecond) / step) + 1;

  return (
    <div className="ruler">
      {Array.from({ length: ticks }, (_, i) => {
        const left = i * step * pxPerSecond;
        return (
          <span key={i} style={{ left }}>
            <i style={{ left: 0 }} />
            {formatTimecode(i * step * 1000).slice(0, 5)}
          </span>
        );
      })}
    </div>
  );
}

function TimelineClip({
  clip,
  startMs,
  src,
  offline,
  toPx,
  pxPerSecond,
  selection,
  onSelect,
}: {
  clip: Clip;
  startMs: number;
  src?: string;
  offline: boolean;
  toPx: (ms: number) => number;
  pxPerSecond: number;
  selection: ReturnType<typeof useEditor.getState>['selection'];
  onSelect: (s: ReturnType<typeof useEditor.getState>['selection']) => void;
}) {
  const width = Math.max(toPx(clip.durationMs), MIN_CLIP_PX);
  const selected = selection.kind !== 'none' && selection.clipId === clip.id;
  const keyframes = sortKeyframes(clip.keyframes);
  const segments = segmentsOf(clip);
  const roomy = width > 70;

  const classes = [
    'clip',
    selected && 'clip--selected',
    clip.ai && 'clip--ai',
    offline && 'clip--offline',
  ]
    .filter(Boolean)
    .join(' ');

  // Collapse diamonds that would sit on top of each other at this zoom.
  const visibleKeyframes: typeof keyframes = [];
  let hidden = 0;
  let lastPx = -Infinity;
  for (const kf of keyframes) {
    const px = toPx(kf.timeMs);
    if (px - lastPx >= MIN_KEYFRAME_GAP_PX) {
      visibleKeyframes.push(kf);
      lastPx = px;
    } else {
      hidden += 1;
    }
  }

  return (
    <div className={classes} style={{ left: toPx(startMs), width }} data-testid={`clip-${clip.id}`}>
      <button
        type="button"
        aria-label={`${clip.name} ${clip.kind} clip`}
        onClick={() => onSelect({ kind: 'clip', clipId: clip.id })}
        style={{ position: 'absolute', inset: 0, background: 'none', border: 0, padding: 0 }}
      >
        {offline ? (
          <span className="clip__offline-tag">⚠ MEDIA OFFLINE</span>
        ) : clip.kind === 'photo' ? (
          <img src={src} alt="" draggable={false} />
        ) : (
          <video src={src} muted preload="metadata" />
        )}
        {roomy && <span className="clip__name">{truncateName(clip.name, 24)}</span>}
        {roomy && !clip.ai && <span className="clip__dur">{formatDuration(clip.durationMs)}</span>}
        {roomy && clip.ai && <span className="clip__ai-tag">✦ AI</span>}
      </button>

      {clip.kind === 'photo' && (
        <div className="kflane">
          {keyframes.length === 0 && roomy && (
            <span className="kflane__hint">no keyframes</span>
          )}

          {segments.map((segment, index) => {
            const isSelected =
              selection.kind === 'segment' &&
              selection.clipId === clip.id &&
              selection.fromKeyframeId === segment.fromKeyframeId;
            const prompt = clip.prompts[segment.fromKeyframeId];
            return (
              <button
                key={segment.fromKeyframeId}
                type="button"
                className={`segment ${isSelected ? 'segment--selected' : ''}`}
                aria-label={`Segment from keyframe ${index + 1} to keyframe ${index + 2}`}
                style={{ left: toPx(segment.startMs), width: Math.max(toPx(segment.durationMs), 6) }}
                onClick={() =>
                  onSelect({
                    kind: 'segment',
                    clipId: clip.id,
                    fromKeyframeId: segment.fromKeyframeId,
                    toKeyframeId: segment.toKeyframeId,
                  })
                }
              >
                {prompt && isSelected && pxPerSecond > 20 && (
                  <span className="segment__pill">“{prompt}”</span>
                )}
              </button>
            );
          })}

          {visibleKeyframes.map((kf) => {
            const index = keyframes.indexOf(kf);
            const isSelected =
              selection.kind === 'keyframe' &&
              selection.clipId === clip.id &&
              selection.keyframeId === kf.id;
            return (
              <button
                key={kf.id}
                type="button"
                className={`kf ${isSelected ? 'kf--selected' : ''}`}
                aria-label={`Keyframe ${index + 1} at ${formatTimecode(kf.timeMs)}`}
                style={{ left: toPx(kf.timeMs) }}
                onClick={() => onSelect({ kind: 'keyframe', clipId: clip.id, keyframeId: kf.id })}
              />
            );
          })}

          {hidden > 0 && (
            <span
              className="segment__pill"
              style={{ left: 'auto', right: 4, bottom: 4, transform: 'none' }}
            >
              +{hidden}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** The hatched placeholder that holds a segment's place while Higgsfield renders it. */
function GenerationOverlay({
  generation,
  clips,
  toPx,
}: {
  generation: Generation;
  clips: Clip[];
  toPx: (ms: number) => number;
}) {
  const placed = layout(clips).find((p) => p.clip.id === generation.clipId);
  if (!placed) return null;

  const segment = segmentsOf(placed.clip).find(
    (s) => s.fromKeyframeId === generation.fromKeyframeId,
  );
  if (!segment) return null;

  const failed = generation.status === 'failed';
  const label = failed
    ? 'Failed'
    : generation.status === 'queued'
      ? 'Queued'
      : `Rendering ${Math.round(generation.progress * 100)}%`;

  return (
    <div
      className={`genclip ${failed ? 'genclip--error' : ''}`}
      role="status"
      style={{
        left: toPx(placed.startMs + segment.startMs),
        width: Math.max(toPx(segment.durationMs), 40),
      }}
    >
      {label}
      {!failed && (
        <span className="genclip__bar">
          <i style={{ width: `${Math.max(generation.progress * 100, 4)}%` }} />
        </span>
      )}
      <span className="genclip__sub">
        {failed
          ? (generation.error?.title ?? 'error')
          : generation.slow
            ? 'taking longer than usual'
            : formatDuration(segment.durationMs)}
      </span>
    </div>
  );
}
