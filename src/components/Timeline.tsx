import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../state/store';
import type { Clip, ClipEdge, MediaAsset, SegmentGeneration, Selection } from '../types/project';
import {
  dropIndexFor,
  formatDuration,
  formatTimecode,
  insertIndexAt,
  layout,
  resizeClip,
  segmentsOf,
  sortKeyframes,
  startOfIndex,
  totalDurationMs,
  truncateName,
} from '../lib/timeline';

const MIN_CLIP_PX = 14;
/**
 * Two 10 px handles on a clip narrower than this would cover it completely, leaving nothing
 * to grab for a reorder. Below it the handles step aside and zooming in brings them back.
 */
const MIN_HANDLE_CLIP_PX = 32;
/** Below this, keyframe diamonds would overlap, so they collapse into a cluster chip. */
const MIN_KEYFRAME_GAP_PX = 14;
/** Under this much movement a press is still a click, so selecting a clip stays easy. */
const DRAG_THRESHOLD_PX = 4;
/** Arrow-key steps on an edge handle, for trimming without a mouse. */
const NUDGE_MS = 100;
const COARSE_NUDGE_MS = 1000;

/** A drag in progress: either the whole clip along the track, or one of its edges. */
type ClipDrag = {
  kind: 'move' | 'resize';
  clipId: string;
  edge: ClipEdge;
  /** Where on the timeline the pointer went down, so the drop point needs no rect later. */
  startTimeMs: number;
  startX: number;
  dx: number;
  /** Stays false until the threshold is crossed — an untravelled press is a click. */
  moved: boolean;
};

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
  const moveClip = useEditor((s) => s.moveClip);
  const openFilmWizard = useEditor((s) => s.openFilmWizard);
  const resize = useEditor((s) => s.resizeClip);

  const trackRef = useRef<HTMLDivElement>(null);
  const clipsRef = useRef<HTMLDivElement>(null);
  const [fileDrag, setFileDrag] = useState<{ count: number; ratio: number } | null>(null);

  const [drag, setDrag] = useState<ClipDrag | null>(null);
  // The window listeners below read the drag they were installed for, not a stale closure.
  const dragRef = useRef<ClipDrag | null>(null);
  // A drag ends in a click on the clip underneath. That click is not a selection.
  const swallowClick = useRef(false);

  const msPerPx = 1000 / pxPerSecond;
  const toPx = useCallback((ms: number) => (ms / 1000) * pxPerSecond, [pxPerSecond]);

  const setDragState = useCallback((next: ClipDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  // What the track looks like mid-drag: a resize is previewed on the real clip list, so the
  // clips after it slide along as you pull, exactly as they will once you let go.
  const previewClips = useMemo(() => {
    if (!drag || !drag.moved || drag.kind !== 'resize') return clips;
    return clips.map((c) =>
      c.id === drag.clipId
        ? resizeClip(c, drag.edge, drag.dx * msPerPx, assets[c.assetId]?.durationMs)
        : c,
    );
  }, [clips, drag, msPerPx, assets]);

  const placed = useMemo(() => layout(previewClips), [previewClips]);
  const total = totalDurationMs(previewClips);
  const width = Math.max(toPx(total), 320);

  // A reorder keeps the order on screen and shows where the clip would land instead.
  const dropOffsetMs = useMemo(() => {
    if (!drag || drag.kind !== 'move' || !drag.moved) return null;
    const rest = clips.filter((c) => c.id !== drag.clipId);
    return startOfIndex(rest, dropIndexFor(clips, drag.clipId, drag.startTimeMs + drag.dx * msPerPx));
  }, [clips, drag, msPerPx]);

  const selectedClipId = selection.kind === 'none' ? null : selection.clipId;
  const selectedClip = clips.find((c) => c.id === selectedClipId);
  const canKeyframe = selectedClip?.kind === 'photo';

  // Film legs animate between two photos rather than inside one clip, so there is no
  // segment on the track for them to hatch over — the film's own progress speaks for them.
  const activeGenerations = Object.values(generations).filter(
    (g): g is SegmentGeneration =>
      g.kind === 'segment' &&
      (g.status === 'queued' || g.status === 'running' || g.status === 'failed'),
  );

  function ratioFromEvent(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 1;
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  }

  /** Where on the timeline a screen x sits. Measured off the clips, which start at time 0. */
  function timeFromClientX(clientX: number): number {
    const rect = clipsRef.current?.getBoundingClientRect();
    return rect ? (clientX - rect.left) * msPerPx : 0;
  }

  function beginDrag(e: React.PointerEvent, kind: ClipDrag['kind'], clipId: string, edge: ClipEdge) {
    if (e.button !== 0) return;
    e.stopPropagation();
    // A drag that ended off the clip left this armed; a fresh press means a fresh click.
    swallowClick.current = false;
    setDragState({
      kind,
      clipId,
      edge,
      startTimeMs: timeFromClientX(e.clientX),
      startX: e.clientX,
      dx: 0,
      moved: false,
    });
  }

  // Listening on the window rather than capturing the pointer: the drag then survives the
  // cursor running off the end of the clip, off the track, or out of the window entirely.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const dx = e.clientX - current.startX;
      setDragState({ ...current, dx, moved: current.moved || Math.abs(dx) >= DRAG_THRESHOLD_PX });
    };

    const commit = (e: PointerEvent) => {
      const current = dragRef.current;
      setDragState(null);
      if (!current) return;

      const dx = e.clientX - current.startX;
      if (!current.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      swallowClick.current = true;

      if (current.kind === 'resize') {
        resize(current.clipId, current.edge, dx * msPerPx);
      } else {
        moveClip(current.clipId, dropIndexFor(clips, current.clipId, current.startTimeMs + dx * msPerPx));
      }
    };

    const cancel = () => setDragState(null);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', commit);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', commit);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [dragging, clips, msPerPx, moveClip, resize, setDragState]);

  function onSelectClip(clipId: string) {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    select({ kind: 'clip', clipId });
  }

  function onResizeKey(e: React.KeyboardEvent, clipId: string, edge: ClipEdge) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? COARSE_NUDGE_MS : NUDGE_MS;
    resize(clipId, edge, e.key === 'ArrowLeft' ? -step : step);
  }

  function onDragOver(e: React.DragEvent) {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setFileDrag({
      count: e.dataTransfer.items?.length ?? 1,
      ratio: ratioFromEvent(e.clientX),
    });
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const ratio = ratioFromEvent(e.clientX);
    setFileDrag(null);

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
            className={`track ${fileDrag ? 'track--drop-target' : ''} ${drag?.moved ? 'track--dragging' : ''}`}
            ref={trackRef}
            data-testid="timeline-track"
            onDragOver={onDragOver}
            onDragLeave={() => setFileDrag(null)}
            onDrop={onDrop}
            onClick={onScrub}
          >
            {clips.length === 0 ? (
              <div className={`dropzone ${fileDrag ? 'dropzone--hot' : ''}`}>
                {fileDrag ? (
                  <div>
                    <b>
                      Release to add {fileDrag.count} {fileDrag.count === 1 ? 'file' : 'files'}
                    </b>
                    They land side by side on one track
                  </div>
                ) : (
                  <div>
                    <b>Drop photos and videos here</b>
                    One timeline — they land side by side in drop order
                    {/* The other way in: three photos and no editing at all. */}
                    <button type="button" className="dropzone__cta" onClick={openFilmWizard}>
                      ✦ New film from 3 photos
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="track__clips" ref={clipsRef}>
                {placed.map(({ clip, startMs }) => (
                  <TimelineClip
                    key={clip.id}
                    clip={clip}
                    startMs={startMs}
                    asset={assets[clip.assetId]}
                    toPx={toPx}
                    pxPerSecond={pxPerSecond}
                    selection={selection}
                    drag={drag?.clipId === clip.id ? drag : null}
                    onSelect={select}
                    onSelectClip={onSelectClip}
                    onDragStart={beginDrag}
                    onResizeKey={onResizeKey}
                  />
                ))}

                {activeGenerations.map((generation) => (
                  <GenerationOverlay
                    key={generation.id}
                    generation={generation}
                    clips={previewClips}
                    toPx={toPx}
                  />
                ))}

                {dropOffsetMs !== null && (
                  <div className="insert-marker" style={{ left: toPx(dropOffsetMs) }} />
                )}

                <div className="playhead" style={{ left: toPx(playheadMs) }} />
              </div>
            )}

            {fileDrag && clips.length > 0 && (
              <div
                className="insert-marker"
                style={{ left: toPx(startOfIndex(clips, insertIndexAt(clips, fileDrag.ratio))) }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
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
  asset,
  toPx,
  pxPerSecond,
  selection,
  drag,
  onSelect,
  onSelectClip,
  onDragStart,
  onResizeKey,
}: {
  clip: Clip;
  startMs: number;
  asset?: MediaAsset;
  toPx: (ms: number) => number;
  pxPerSecond: number;
  selection: Selection;
  /** The drag that has hold of *this* clip, if any. */
  drag: ClipDrag | null;
  onSelect: (s: Selection) => void;
  onSelectClip: (clipId: string) => void;
  onDragStart: (e: React.PointerEvent, kind: ClipDrag['kind'], clipId: string, edge: ClipEdge) => void;
  onResizeKey: (e: React.KeyboardEvent, clipId: string, edge: ClipEdge) => void;
}) {
  const width = Math.max(toPx(clip.durationMs), MIN_CLIP_PX);
  const selected = selection.kind !== 'none' && selection.clipId === clip.id;
  const offline = !asset;
  const keyframes = sortKeyframes(clip.keyframes);
  const segments = segmentsOf(clip);
  const roomy = width > 70;
  const resizable = width >= MIN_HANDLE_CLIP_PX;
  const reordering = drag !== null && drag.kind === 'move' && drag.moved;

  const classes = [
    'clip',
    selected && 'clip--selected',
    clip.ai && 'clip--ai',
    offline && 'clip--offline',
    reordering && 'clip--reordering',
    drag !== null && drag.kind === 'resize' && drag.moved && 'clip--resizing',
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
    <div
      className={classes}
      style={{
        left: toPx(startMs),
        width,
        // A reordering clip rides with the cursor; the marker says where it will land.
        transform: reordering ? `translateX(${drag.dx}px)` : undefined,
      }}
      data-testid={`clip-${clip.id}`}
    >
      <button
        type="button"
        aria-label={`${clip.name} ${clip.kind} clip`}
        onPointerDown={(e) => onDragStart(e, 'move', clip.id, 'start')}
        onClick={() => onSelectClip(clip.id)}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'none',
          border: 0,
          padding: 0,
          cursor: reordering ? 'grabbing' : 'grab',
        }}
      >
        {offline ? (
          <span className="clip__offline-tag">⚠ MEDIA OFFLINE</span>
        ) : clip.kind === 'photo' ? (
          <img src={asset.src} alt="" draggable={false} />
        ) : (
          <video src={asset.src} muted preload="metadata" />
        )}
        {roomy && <span className="clip__name">{truncateName(clip.name, 24)}</span>}
        {roomy && !clip.ai && <span className="clip__dur">{formatDuration(clip.durationMs)}</span>}
        {roomy && clip.ai && <span className="clip__ai-tag">✦ AI</span>}
      </button>

      {resizable &&
        (['start', 'end'] as const).map((edge) => (
          <button
            key={edge}
            type="button"
            className={`clip__handle clip__handle--${edge}`}
            aria-label={`Resize the ${edge} of ${clip.name}`}
            title={`Drag to ${edge === 'start' ? 'trim the start' : 'change the length'} · arrow keys nudge`}
            onPointerDown={(e) => onDragStart(e, 'resize', clip.id, edge)}
            onKeyDown={(e) => onResizeKey(e, clip.id, edge)}
            onClick={(e) => e.stopPropagation()}
          />
        ))}

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
  generation: SegmentGeneration;
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
