import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { animatableCuts, useEditor } from '../state/store';
import type { AudioTrack, Clip, ClipEdge, Generation, MediaAsset, Selection } from '../types/project';
import {
  canDeleteSelection,
  canSplitAt,
  formatDuration,
  formatTimecode,
  insertIndexAt,
  layout,
  moveAudio,
  bridgeableCuts,
  placeClip,
  resizeAudio,
  resizeClipInList,
  snapStartMs,
  snapTargets,
  startOfIndex,
  timelineEndMs,
  transitionStaleness,
  truncateName,
  type Cut,
  type TransitionStaleness,
} from '../lib/timeline';

const MIN_CLIP_PX = 14;
/**
 * Two 10 px handles on a clip narrower than this would cover it completely, leaving nothing
 * to grab for a reorder. Below it the handles step aside and zooming in brings them back.
 */
const MIN_HANDLE_CLIP_PX = 32;
/** Under this much movement a press is still a click, so selecting a clip stays easy. */
const DRAG_THRESHOLD_PX = 4;
/** Arrow-key steps on a clip or an edge handle, for editing without a mouse. */
const NUDGE_MS = 100;
const COARSE_NUDGE_MS = 1000;
/** How near an edge has to be before the snapping aid pulls a drag onto it. */
const SNAP_PX = 8;

/** A drag in progress: either the whole clip along the track, or one of its edges. */
type ClipDrag = {
  kind: 'move' | 'resize';
  clipId: string;
  edge: ClipEdge;
  /** The clip's `startMs` when the pointer went down — the base the drag adds to. */
  origStartMs: number;
  startX: number;
  dx: number;
  /** Stays false until the threshold is crossed — an untravelled press is a click. */
  moved: boolean;
};

/** The same for a sound on its lane. Same semantics now: both are placed by time. */
type AudioDrag = {
  kind: 'move' | 'resize';
  trackId: string;
  edge: ClipEdge;
  /** The track's `startMs` when the pointer went down — the base the drag adds to. */
  origStartMs: number;
  startX: number;
  dx: number;
  moved: boolean;
};

/** The single track: clips, the cuts between them, and the playhead. */
export function Timeline() {
  const clips = useEditor((s) => s.clips);
  const audioTracks = useEditor((s) => s.audioTracks);
  const assets = useEditor((s) => s.assets);
  const selection = useEditor((s) => s.selection);
  const generations = useEditor((s) => s.generations);
  const playheadMs = useEditor((s) => s.playheadMs);
  const pxPerSecond = useEditor((s) => s.pxPerSecond);
  const snapping = useEditor((s) => s.snapping);
  const select = useEditor((s) => s.select);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const addFiles = useEditor((s) => s.addFiles);
  const addPaths = useEditor((s) => s.addPaths);
  const addAudioViaDialog = useEditor((s) => s.addAudioViaDialog);
  const splitAtPlayhead = useEditor((s) => s.splitAtPlayhead);
  const deleteSelection = useEditor((s) => s.deleteSelection);
  const moveClipTo = useEditor((s) => s.moveClipTo);
  const resize = useEditor((s) => s.resizeClip);
  const toggleSnapping = useEditor((s) => s.toggleSnapping);
  const moveAudioTrack = useEditor((s) => s.moveAudioTrack);
  const resizeAudioTrack = useEditor((s) => s.resizeAudioTrack);
  const toggleAudioMute = useEditor((s) => s.toggleAudioMute);
  const animateAll = useEditor((s) => s.animateAll);
  const animateQueue = useEditor((s) => s.animateQueue);
  const animateRun = useEditor((s) => s.animateRun);
  const settings = useEditor((s) => s.settings);

  const trackRef = useRef<HTMLDivElement>(null);
  const clipsRef = useRef<HTMLDivElement>(null);
  const [fileDrag, setFileDrag] = useState<{ count: number; ratio: number } | null>(null);

  const [drag, setDrag] = useState<ClipDrag | null>(null);
  // The window listeners below read the drag they were installed for, not a stale closure.
  const dragRef = useRef<ClipDrag | null>(null);
  const [audioDrag, setAudioDrag] = useState<AudioDrag | null>(null);
  const audioDragRef = useRef<AudioDrag | null>(null);
  // A drag ends in a click on the clip underneath. That click is not a selection.
  const swallowClick = useRef(false);

  const msPerPx = 1000 / pxPerSecond;
  const toPx = useCallback((ms: number) => (ms / 1000) * pxPerSecond, [pxPerSecond]);

  const setDragState = useCallback((next: ClipDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const setAudioDragState = useCallback((next: AudioDrag | null) => {
    audioDragRef.current = next;
    setAudioDrag(next);
  }, []);

  /**
   * Where a drag wants to put a block, with the snapping aid applied. Placement is free —
   * the aid only pulls the last few pixels onto an edge, and only while it is switched on.
   */
  const dropStartMs = useCallback(
    (startMs: number, durationMs: number, id: string) => {
      if (!snapping) return Math.max(0, Math.round(startMs));
      const targets = snapTargets(clips, audioTracks, id, playheadMs);
      return Math.max(0, Math.round(snapStartMs(startMs, durationMs, targets, SNAP_PX * msPerPx)));
    },
    [snapping, clips, audioTracks, playheadMs, msPerPx],
  );

  // What the track looks like mid-drag. Both kinds preview on the real clip list, so a clip
  // sits where it will land — gap and all — and a resize slides its neighbours as you pull.
  const previewClips = useMemo(() => {
    if (!drag || !drag.moved) return clips;
    const clip = clips.find((c) => c.id === drag.clipId);
    if (!clip) return clips;
    return drag.kind === 'resize'
      ? resizeClipInList(
          clips,
          drag.clipId,
          drag.edge,
          drag.dx * msPerPx,
          assets[clip.assetId]?.durationMs,
        )
      : placeClip(
          clips,
          drag.clipId,
          dropStartMs(drag.origStartMs + drag.dx * msPerPx, clip.durationMs, clip.id),
        );
  }, [clips, drag, msPerPx, assets, dropStartMs]);

  // The same for a sound mid-drag: both moving and trimming preview on the real lane.
  const previewAudio = useMemo(() => {
    if (!audioDrag || !audioDrag.moved) return audioTracks;
    return audioTracks.map((t) => {
      if (t.id !== audioDrag.trackId) return t;
      return audioDrag.kind === 'move'
        ? moveAudio(t, dropStartMs(audioDrag.origStartMs + audioDrag.dx * msPerPx, t.durationMs, t.id))
        : resizeAudio(t, audioDrag.edge, audioDrag.dx * msPerPx, assets[t.assetId]?.durationMs);
    });
  }, [audioTracks, audioDrag, msPerPx, assets, dropStartMs]);

  const placed = useMemo(() => layout(previewClips), [previewClips]);
  const total = timelineEndMs(previewClips, previewAudio);
  const width = Math.max(toPx(total), 320);

  // Chips live on the preview list so they ride along with a drag or resize in progress.
  const cuts = useMemo(() => bridgeableCuts(previewClips), [previewClips]);

  // The generation a chip should wear: a live one first, else the failed one awaiting a retry.
  const generationByCut = useMemo(() => {
    const map = new Map<string, Generation>();
    for (const g of Object.values(generations)) {
      if (g.target.kind !== 'cut' || g.target.replacesClipId !== undefined) continue;
      if (g.status === 'succeeded' || g.status === 'cancelled') continue;
      const key = `${g.target.afterClipId}:${g.target.beforeClipId}`;
      const prev = map.get(key);
      if (!prev || prev.status === 'failed') map.set(key, g);
    }
    return map;
  }, [generations]);

  const animatable = useMemo(
    () => animatableCuts({ clips, assets, generations }),
    [clips, assets, generations],
  );
  const configured = settings?.configured ?? false;
  // Both toolbar buttons ask the same pure predicate the store's own guard asks, so the
  // button can never offer an edit the action will silently refuse.
  const splittable = canSplitAt(clips, playheadMs);
  const deletable = canDeleteSelection(selection);

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

  function beginDrag(e: React.PointerEvent, kind: ClipDrag['kind'], clip: Clip, edge: ClipEdge) {
    if (e.button !== 0) return;
    e.stopPropagation();
    // A drag that ended off the clip left this armed; a fresh press means a fresh click.
    swallowClick.current = false;
    setDragState({
      kind,
      clipId: clip.id,
      edge,
      origStartMs: clip.startMs,
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
        const clip = clips.find((c) => c.id === current.clipId);
        if (clip) {
          moveClipTo(
            current.clipId,
            dropStartMs(current.origStartMs + dx * msPerPx, clip.durationMs, clip.id),
          );
        }
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
  }, [dragging, clips, msPerPx, moveClipTo, resize, setDragState, dropStartMs]);

  function beginAudioDrag(
    e: React.PointerEvent,
    kind: AudioDrag['kind'],
    track: AudioTrack,
    edge: ClipEdge,
  ) {
    if (e.button !== 0) return;
    e.stopPropagation();
    swallowClick.current = false;
    setAudioDragState({
      kind,
      trackId: track.id,
      edge,
      origStartMs: track.startMs,
      startX: e.clientX,
      dx: 0,
      moved: false,
    });
  }

  const audioDragging = audioDrag !== null;
  useEffect(() => {
    if (!audioDragging) return;

    const onMove = (e: PointerEvent) => {
      const current = audioDragRef.current;
      if (!current) return;
      const dx = e.clientX - current.startX;
      setAudioDragState({
        ...current,
        dx,
        moved: current.moved || Math.abs(dx) >= DRAG_THRESHOLD_PX,
      });
    };

    const commit = (e: PointerEvent) => {
      const current = audioDragRef.current;
      setAudioDragState(null);
      if (!current) return;

      const dx = e.clientX - current.startX;
      if (!current.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      swallowClick.current = true;

      if (current.kind === 'resize') {
        resizeAudioTrack(current.trackId, current.edge, dx * msPerPx);
      } else {
        const track = audioTracks.find((t) => t.id === current.trackId);
        if (track) {
          moveAudioTrack(
            current.trackId,
            dropStartMs(current.origStartMs + dx * msPerPx, track.durationMs, track.id),
          );
        }
      }
    };

    const cancel = () => setAudioDragState(null);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', commit);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', commit);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [
    audioDragging,
    audioTracks,
    msPerPx,
    moveAudioTrack,
    resizeAudioTrack,
    setAudioDragState,
    dropStartMs,
  ]);

  function onSelectClip(clipId: string, e: React.MouseEvent) {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    select({ kind: 'clip', clipId });
    // A mouse click also cues playback at the clicked frame. A keyboard activation
    // carries no coordinates (detail 0), so it selects and leaves the playhead alone.
    if (e.detail > 0) setPlayhead(timeFromClientX(e.clientX));
  }

  function onMoveKey(e: React.KeyboardEvent, clip: Clip) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.shiftKey ? COARSE_NUDGE_MS : NUDGE_MS;
    moveClipTo(clip.id, clip.startMs + (e.key === 'ArrowLeft' ? -step : step));
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
    const dropTimeMs = Math.max(
      0,
      clipsRef.current ? timeFromClientX(e.clientX) : ratio * total,
    );
    setFileDrag(null);

    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;

    const index = insertIndexAt(clips, ratio);
    // A real OS drop inside Tauri carries a path; a browser drop does not.
    const paths = files
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => Boolean(p));

    // Audio in the drop starts where it was dropped; the rest lands at `index` as ever.
    if (paths.length === files.length && paths.length > 0) {
      await addPaths(paths, index, dropTimeMs);
    } else {
      await addFiles(files, index, dropTimeMs);
    }
  }

  /** A click on the bare track — beside or between clips — cues the playhead there. */
  function onScrub(e: React.MouseEvent) {
    if (e.target !== e.currentTarget && e.target !== clipsRef.current) return;
    if (swallowClick.current) {
      // A drag that ended over open track lands its click here; it is not a seek.
      swallowClick.current = false;
      return;
    }
    setPlayhead(timeFromClientX(e.clientX));
  }

  return (
    <div className="timeline">
      <div className="timeline__bar">
        <button
          type="button"
          className="tool"
          aria-label="Split at playhead"
          title={
            splittable
              ? 'Cut the clip under the playhead in two'
              : 'Put the playhead inside a clip to split it'
          }
          onClick={splitAtPlayhead}
          disabled={!splittable}
        >
          ✂
        </button>
        <button
          type="button"
          className="tool tool--wide"
          aria-label="Add audio track"
          title="Add a sound file on its own track, starting at the playhead"
          onClick={() => void addAudioViaDialog()}
        >
          ♪ Add audio
        </button>
        {animatable.length > 0 && animateQueue === null && animateRun === null && (
          <button
            type="button"
            className="tool tool--wide tool--on"
            aria-label="Animate all cuts"
            title={
              configured
                ? 'Generate a Higgsfield transition for every photo-to-photo cut'
                : 'Connect Higgsfield first'
            }
            disabled={!configured}
            onClick={animateAll}
          >
            ✦ Animate all · {animatable.length}
          </button>
        )}
        <button
          type="button"
          className="tool"
          aria-label="Delete selection"
          title={deletable ? 'Delete the selected clip or sound' : 'Select a clip or a sound to delete'}
          onClick={deleteSelection}
          disabled={!deletable}
        >
          🗑
        </button>
        <button
          type="button"
          className={`tool tool--wide ${snapping ? 'tool--on' : ''}`}
          aria-label="Snap to edges"
          aria-pressed={snapping}
          title={
            snapping
              ? 'Drags land anywhere, but nudge onto a nearby edge or the playhead'
              : 'Drags land exactly where you let go'
          }
          onClick={toggleSnapping}
        >
          ⇥ Snap
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
          <Ruler total={total} pxPerSecond={pxPerSecond} width={width} onSeek={setPlayhead} />

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
                    <b>Drop photos, videos and audio here</b>
                    One timeline — visuals land on the track, sounds get their own lanes
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
                    fromAsset={
                      clip.transition?.mode === 'replace'
                        ? assets[clip.transition.from.assetId]
                        : undefined
                    }
                    toAsset={
                      clip.transition?.mode === 'replace'
                        ? assets[clip.transition.to.assetId]
                        : undefined
                    }
                    staleness={
                      clip.transition ? transitionStaleness(previewClips, clip.id, assets) : undefined
                    }
                    toPx={toPx}
                    selection={selection}
                    drag={drag?.clipId === clip.id ? drag : null}
                    onSelectClip={onSelectClip}
                    onDragStart={beginDrag}
                    onMoveKey={onMoveKey}
                    onResizeKey={onResizeKey}
                  />
                ))}

                {cuts.map((cut) => {
                  const a = previewClips.find((c) => c.id === cut.afterClipId);
                  const b = previewClips.find((c) => c.id === cut.beforeClipId);
                  if (!a || !b) return null;
                  const assetA = assets[a.assetId];
                  const assetB = assets[b.assetId];
                  return (
                    <CutChip
                      key={`${cut.afterClipId}:${cut.beforeClipId}`}
                      cut={cut}
                      nameA={a.name}
                      nameB={b.name}
                      generation={generationByCut.get(`${cut.afterClipId}:${cut.beforeClipId}`)}
                      selected={
                        selection.kind === 'cut' &&
                        selection.afterClipId === cut.afterClipId &&
                        selection.beforeClipId === cut.beforeClipId
                      }
                      offline={Boolean(!assetA || !assetB || assetA.missing || assetB.missing)}
                      toPx={toPx}
                      onSelect={() =>
                        select({
                          kind: 'cut',
                          afterClipId: cut.afterClipId,
                          beforeClipId: cut.beforeClipId,
                        })
                      }
                    />
                  );
                })}

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

          {previewAudio.length > 0 && (
            <div className="audio-lanes" data-testid="audio-lanes">
              {previewAudio.map((track) => (
                <AudioLane
                  key={track.id}
                  track={track}
                  asset={assets[track.assetId]}
                  toPx={toPx}
                  msPerPx={msPerPx}
                  selection={selection}
                  drag={audioDrag?.trackId === track.id ? audioDrag : null}
                  onSeek={(ms) => {
                    if (swallowClick.current) {
                      swallowClick.current = false;
                      return;
                    }
                    setPlayhead(ms);
                  }}
                  onSelect={(trackId, seekMs) => {
                    if (swallowClick.current) {
                      swallowClick.current = false;
                      return;
                    }
                    select({ kind: 'audio', trackId });
                    if (seekMs !== undefined) setPlayhead(seekMs);
                  }}
                  onDragStart={beginAudioDrag}
                  onMoveKey={(e, t) => {
                    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                    e.preventDefault();
                    const step = e.shiftKey ? COARSE_NUDGE_MS : NUDGE_MS;
                    moveAudioTrack(t.id, t.startMs + (e.key === 'ArrowLeft' ? -step : step));
                  }}
                  onResizeKey={(e, trackId, edge) => {
                    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                    e.preventDefault();
                    e.stopPropagation();
                    const step = e.shiftKey ? COARSE_NUDGE_MS : NUDGE_MS;
                    resizeAudioTrack(trackId, edge, e.key === 'ArrowLeft' ? -step : step);
                  }}
                  onToggleMute={toggleAudioMute}
                />
              ))}
              <div className="playhead playhead--lanes" style={{ left: toPx(playheadMs) }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One audio lane: a single sound, dragged to reposition and trimmed at its edges. */
function AudioLane({
  track,
  asset,
  toPx,
  msPerPx,
  selection,
  drag,
  onSeek,
  onSelect,
  onDragStart,
  onMoveKey,
  onResizeKey,
  onToggleMute,
}: {
  track: AudioTrack;
  asset?: MediaAsset;
  toPx: (ms: number) => number;
  msPerPx: number;
  selection: Selection;
  /** The drag that has hold of *this* track, if any. */
  drag: AudioDrag | null;
  /** Cue the playhead — the open stretch of a lane is seek surface, like the track. */
  onSeek: (ms: number) => void;
  /** A mouse click passes the clicked time along so selecting a sound also cues it. */
  onSelect: (trackId: string, seekMs?: number) => void;
  onDragStart: (e: React.PointerEvent, kind: AudioDrag['kind'], track: AudioTrack, edge: ClipEdge) => void;
  onMoveKey: (e: React.KeyboardEvent, track: AudioTrack) => void;
  onResizeKey: (e: React.KeyboardEvent, trackId: string, edge: ClipEdge) => void;
  onToggleMute: (trackId: string) => void;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  /** Where on the timeline a screen x sits. The lane shares the clips' time origin. */
  const msAt = (clientX: number) => {
    const rect = laneRef.current?.getBoundingClientRect();
    return rect ? (clientX - rect.left) * msPerPx : 0;
  };
  const width = Math.max(toPx(track.durationMs), MIN_CLIP_PX);
  const selected = selection.kind === 'audio' && selection.trackId === track.id;
  const offline = !asset;
  const moving = drag !== null && drag.kind === 'move' && drag.moved;
  const roomy = width > 70;

  const classes = [
    'audio-clip',
    selected && 'audio-clip--selected',
    track.muted && 'audio-clip--muted',
    offline && 'audio-clip--offline',
    moving && 'audio-clip--moving',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className="audio-lane"
      ref={laneRef}
      onClick={(e) => {
        if (e.target === e.currentTarget) onSeek(msAt(e.clientX));
      }}
    >
      <div className={classes} style={{ left: toPx(track.startMs), width }}>
        <button
          type="button"
          aria-label={`${track.name} audio track`}
          onPointerDown={(e) => onDragStart(e, 'move', track, 'start')}
          onClick={(e) => onSelect(track.id, e.detail > 0 ? msAt(e.clientX) : undefined)}
          onKeyDown={(e) => onMoveKey(e, track)}
          className="audio-clip__body"
          style={{ cursor: moving ? 'grabbing' : 'grab' }}
        >
          <span aria-hidden="true">{track.muted ? '♪̸' : '♪'}</span>
          {offline ? (
            <span className="audio-clip__name">⚠ MEDIA OFFLINE</span>
          ) : (
            <span className="audio-clip__name">{truncateName(track.name, 24)}</span>
          )}
          {roomy && <span className="audio-clip__dur">{formatDuration(track.durationMs)}</span>}
        </button>

        {roomy && (
        <button
          type="button"
          className="audio-clip__mute"
          aria-label={`${track.muted ? 'Unmute' : 'Mute'} ${track.name}`}
          title={track.muted ? 'Unmute this track' : 'Mute this track'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onToggleMute(track.id);
          }}
        >
          {track.muted ? '🔇' : '🔊'}
        </button>
        )}

        {width >= MIN_HANDLE_CLIP_PX &&
          (['start', 'end'] as const).map((edge) => (
            <button
              key={edge}
              type="button"
              className={`clip__handle clip__handle--${edge}`}
              aria-label={`Resize the ${edge} of ${track.name} audio`}
              title="Drag to trim · arrow keys nudge"
              onPointerDown={(e) => onDragStart(e, 'resize', track, edge)}
              onKeyDown={(e) => onResizeKey(e, track.id, edge)}
              onClick={(e) => e.stopPropagation()}
            />
          ))}
      </div>
    </div>
  );
}

function Ruler({
  total,
  pxPerSecond,
  width,
  onSeek,
}: {
  total: number;
  pxPerSecond: number;
  width: number;
  /** Cue the playhead: a press seeks, and holding the button down scrubs. */
  onSeek: (ms: number) => void;
}) {
  const originRef = useRef<HTMLDivElement>(null);
  const [scrubbing, setScrubbing] = useState(false);

  const seekAt = useCallback(
    (clientX: number) => {
      const rect = originRef.current?.getBoundingClientRect();
      if (rect) onSeek(((clientX - rect.left) / pxPerSecond) * 1000);
    },
    [onSeek, pxPerSecond],
  );

  // The same window-listener pattern the clip drags use: the scrub survives the cursor
  // leaving the ruler, and ends wherever the button comes back up.
  useEffect(() => {
    if (!scrubbing) return;
    const onMove = (e: PointerEvent) => seekAt(e.clientX);
    const end = () => setScrubbing(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [scrubbing, seekAt]);

  // Keep the labels roughly 70px apart however far the track is zoomed.
  const step = [1, 2, 5, 10, 15, 30, 60].find((s) => s * pxPerSecond >= 70) ?? 60;
  const ticks = Math.floor(Math.max(total / 1000, width / pxPerSecond) / step) + 1;

  return (
    <div
      className="ruler"
      data-testid="timeline-ruler"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        seekAt(e.clientX);
        setScrubbing(true);
      }}
    >
      {/* Ticks share the clips' time origin, so the time a click lands on is the time named. */}
      <div className="ruler__origin" ref={originRef}>
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
    </div>
  );
}

function TimelineClip({
  clip,
  startMs,
  asset,
  fromAsset,
  toAsset,
  staleness,
  toPx,
  selection,
  drag,
  onSelectClip,
  onDragStart,
  onMoveKey,
  onResizeKey,
}: {
  clip: Clip;
  startMs: number;
  asset?: MediaAsset;
  /** Only for replace-mode transition clips: the two source photos its face shows. */
  fromAsset?: MediaAsset;
  toAsset?: MediaAsset;
  /** Only for transition clips: whether their sources still match. */
  staleness?: TransitionStaleness;
  toPx: (ms: number) => number;
  selection: Selection;
  /** The drag that has hold of *this* clip, if any. */
  drag: ClipDrag | null;
  onSelectClip: (clipId: string, e: React.MouseEvent) => void;
  onDragStart: (e: React.PointerEvent, kind: ClipDrag['kind'], clip: Clip, edge: ClipEdge) => void;
  onMoveKey: (e: React.KeyboardEvent, clip: Clip) => void;
  onResizeKey: (e: React.KeyboardEvent, clipId: string, edge: ClipEdge) => void;
}) {
  const width = Math.max(toPx(clip.durationMs), MIN_CLIP_PX);
  const selected = selection.kind === 'clip' && selection.clipId === clip.id;
  const offline = !asset;
  const roomy = width > 70;
  const resizable = width >= MIN_HANDLE_CLIP_PX;
  const moving = drag !== null && drag.kind === 'move' && drag.moved;

  const classes = [
    'clip',
    selected && 'clip--selected',
    clip.ai && 'clip--ai',
    offline && 'clip--offline',
    moving && 'clip--moving',
    drag !== null && drag.kind === 'resize' && drag.moved && 'clip--resizing',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      // The clip is drawn where it will land, so a drag previews its real place on the track.
      className={classes}
      style={{ left: toPx(startMs), width }}
      data-testid={`clip-${clip.id}`}
    >
      <button
        type="button"
        aria-label={`${clip.name} ${clip.kind} clip`}
        title="Click to cue playback here · drag anywhere along the track · arrow keys nudge"
        onPointerDown={(e) => onDragStart(e, 'move', clip, 'start')}
        onClick={(e) => onSelectClip(clip.id, e)}
        onKeyDown={(e) => onMoveKey(e, clip)}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'none',
          border: 0,
          padding: 0,
          cursor: moving ? 'grabbing' : 'grab',
        }}
      >
        {offline ? (
          <span className="clip__offline-tag">⚠ MEDIA OFFLINE</span>
        ) : clip.kind === 'photo' ? (
          <img src={asset.src} alt="" draggable={false} />
        ) : fromAsset && toAsset ? (
          // A replace-mode transition wears its two sources — start left, end right,
          // animating into one another — rather than a frame of the render. A source that
          // is footage shows as footage: an <img> pointed at an .mp4 is a broken image.
          <span className="clip__pair" data-testid={`clip-pair-${clip.id}`} aria-hidden="true">
            <SourceFace asset={fromAsset} />
            <SourceFace asset={toAsset} />
            <i className="clip__pair-arrow">→</i>
          </span>
        ) : (
          <video src={asset.src} muted preload="metadata" />
        )}
        {roomy && <span className="clip__name">{truncateName(clip.name, 24)}</span>}
        {roomy && !clip.ai && <span className="clip__dur">{formatDuration(clip.durationMs)}</span>}
        {roomy && clip.ai && <span className="clip__ai-tag">✦ AI</span>}
        {roomy && staleness && staleness !== 'fresh' && (
          <span className="clip__stale-tag">
            ⟳ {staleness === 'stale' ? 'SOURCES CHANGED' : 'SOURCE MISSING'}
          </span>
        )}
      </button>

      {resizable &&
        (['start', 'end'] as const).map((edge) => (
          <button
            key={edge}
            type="button"
            className={`clip__handle clip__handle--${edge}`}
            aria-label={`Resize the ${edge} of ${clip.name}`}
            title={`Drag to ${edge === 'start' ? 'trim the start' : 'change the length'} · arrow keys nudge`}
            onPointerDown={(e) => onDragStart(e, 'resize', clip, edge)}
            onKeyDown={(e) => onResizeKey(e, clip.id, edge)}
            onClick={(e) => e.stopPropagation()}
          />
        ))}
    </div>
  );
}

/** One half of a replace-mode transition's face: whichever source stood on that side. */
function SourceFace({ asset }: { asset: MediaAsset }) {
  return asset.kind === 'video' ? (
    <video src={asset.src} muted preload="metadata" />
  ) : (
    <img src={asset.src} alt="" draggable={false} />
  );
}

/**
 * The ✦ button standing on a cut. Clicking only ever selects the cut — spending money takes
 * the big button in the inspector — and while that cut's job runs, the chip itself is the
 * progress surface (the cut has no width for an overlay to fill).
 */
function CutChip({
  cut,
  nameA,
  nameB,
  generation,
  selected,
  offline,
  toPx,
  onSelect,
}: {
  cut: Cut;
  nameA: string;
  nameB: string;
  /** The live or failed generation for this cut, if any. */
  generation?: Generation;
  selected: boolean;
  offline: boolean;
  toPx: (ms: number) => number;
  onSelect: () => void;
}) {
  const busy = generation?.status === 'queued' || generation?.status === 'running';
  const failed = generation?.status === 'failed';

  const classes = [
    'cutchip',
    selected && 'cutchip--selected',
    busy && 'cutchip--run',
    busy && generation?.slow && 'cutchip--slow',
    failed && 'cutchip--fail',
  ]
    .filter(Boolean)
    .join(' ');

  let label = '✦';
  if (busy && generation) {
    label =
      generation.status === 'queued'
        ? '◐ QUEUED'
        : generation.progress > 0
          ? `◐ ${Math.round(generation.progress * 100)}%`
          : `◐ ${Math.round(generation.elapsedSecs)}s`;
  } else if (failed) {
    label = '✕ FAILED';
  }

  return (
    <button
      type="button"
      className={classes}
      style={{ left: toPx(cut.timeMs) }}
      aria-label={`Select the cut between ${nameA} and ${nameB}`}
      // Mode-neutral: the chip cannot see the cut's pick, so it promises the bridge, not
      // where the finished clip lands.
      title={
        offline
          ? 'A clip on this cut has no media — re-import it first'
          : `Bridge ${nameA} and ${nameB} with an AI motion transition`
      }
      disabled={offline}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      {label}
    </button>
  );
}

