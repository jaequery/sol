import { useCallback, useEffect, type CSSProperties } from 'react';
import { useEditor } from '../state/store';
import { ASPECT_RATIOS, aspectRatio } from '../lib/aspect';
import { clipAt } from '../lib/timeline';
import {
  eachMedia,
  registerMedia,
  unregisterMedia,
  videoKey,
  videoPoolAt,
} from '../lib/preview-sync';
import type { Clip } from '../types/project';
import { Icon } from './Icon';

/**
 * The preview.
 *
 * A photo is drawn covering the frame and a video is fitted inside it, exactly as the
 * export renders each (`photo_filter` crops, `video_filter` pads — footage is never thrown
 * away). The frame's own shape is the project's aspect ratio. A video element
 * owns the clock while its clip plays — the playhead follows its `currentTime` (see
 * `lib/preview-sync`), so the frame on screen and the timecode cannot disagree. The next
 * video clip on the track stays mounted invisibly, primed to its in-point, so crossing a
 * cut into it needs no load and no seek. A gap between two clips is black here, exactly
 * as the exporter renders it.
 */
export function Preview() {
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const playheadMs = useEditor((s) => s.playheadMs);
  const frame = useEditor((s) => s.aspectRatio);

  const syncNow = usePreviewSync();

  const hit = clipAt(clips, playheadMs);
  const clip = hit?.placed.clip;
  const asset = clip ? assets[clip.assetId] : undefined;

  if (clips.length === 0) {
    return (
      <div className="stage" style={frameStyle(frame)}>
        <div className="stage__empty">
          <Icon name="film" size={36} />
          <b>Nothing to preview yet</b>
          Add media from the bin on the left, or drop files on the timeline below. Photos
          side by side can be bridged with AI transitions.
        </div>
      </div>
    );
  }

  const missing = Boolean(clip && (!asset || asset.missing || !asset.src));
  const pool = videoPoolAt(clips, playheadMs).flatMap((c) => {
    const a = assets[c.assetId];
    return a && !a.missing && a.src ? [{ clip: c, src: a.src }] : [];
  });

  return (
    <div className="stage" style={frameStyle(frame)}>
      <div className="canvas" data-testid="preview-canvas" data-aspect={frame}>
        {pool.map(({ clip: c, src }) => (
          <PreviewVideo
            key={c.id}
            clip={c}
            src={src}
            active={c.id === clip?.id && !missing}
            onMount={syncNow}
          />
        ))}

        {clip?.kind === 'photo' && asset?.src && !asset.missing && (
          <img src={asset.src} alt={clip.name} draggable={false} />
        )}

        {!clip && (
          <div className="canvas__gap" data-testid="preview-gap">
            GAP
          </div>
        )}

        {clip && missing && (
          <div className="canvas__offline">
            <b>MEDIA OFFLINE</b>
            <span>{clip.name} is no longer available</span>
          </div>
        )}

        {/* No timecode here: the transport directly below is the timecode, and a second
            copy of the same number on the frame was the one thing the frame did not need. */}
        {clip?.ai && (
          <div className="canvas__ai">
            <Icon name="sparkle" size={11} /> AI GENERATED
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One mounted preview video — the active clip's, or the next clip's, primed and hidden.
 *
 * Every preview `<video>` renders in this one keyed array, visibility toggled by style
 * only. That is a hard constraint, not a styling choice: a keyed element that changes its
 * JSX position remounts cold, and the boundary handoff this exists for — the primed
 * element *becoming* the visible one — only works while React can carry the DOM node over.
 */
function PreviewVideo({
  clip,
  src,
  active,
  onMount,
}: {
  clip: Clip;
  src: string;
  active: boolean;
  onMount: () => void;
}) {
  // Registration rides the ref so the sync layer sees exactly the elements React has
  // committed. The callback identity must survive the per-frame re-renders — React
  // re-invokes a changed ref with null and then the element, which would tear the sync
  // state down sixty times a second.
  const ref = useCallback(
    (el: HTMLVideoElement | null) => {
      if (el) {
        registerMedia(videoKey(clip.id), el, clip.trimStartMs / 1000);
        // The store notified before React committed this element, so it has not been
        // told anything yet — catch it up rather than waiting for the next tick.
        onMount();
      } else {
        unregisterMedia(videoKey(clip.id));
      }
    },
    [clip.id, clip.trimStartMs, onMount],
  );

  return (
    <video
      ref={ref}
      src={src}
      className={active ? undefined : 'canvas__preload'}
      data-testid={active ? 'preview-video' : 'preview-video-next'}
      muted={!active}
      playsInline
      preload="auto"
    />
  );
}

/**
 * The one driver of every preview video element.
 *
 * Subscribed to the store rather than keyed on render props: zustand notifies on every
 * `set`, so this runs once per state change — every playhead tick included — without
 * tearing a React effect down each frame. The active clip's element is told the wanted
 * time and whether to play; every other mounted element is told to stand down. All of
 * the seek and play discipline lives in `lib/preview-sync`.
 */
function usePreviewSync(): () => void {
  const syncNow = useCallback(() => {
    const s = useEditor.getState();
    const hit = clipAt(s.clips, s.playheadMs);
    const c = hit?.placed.clip;
    const activeKey = c && c.kind === 'video' ? videoKey(c.id) : null;
    eachMedia('clip:', (key, media) => {
      if (hit && c && key === activeKey) {
        media.update((c.trimStartMs + hit.localMs) / 1000, s.playing);
      } else {
        media.deactivate();
      }
    });
  }, []);

  useEffect(() => {
    syncNow();
    return useEditor.subscribe(syncNow);
  }, [syncNow]);

  return syncNow;
}

/**
 * The frame's shape, handed to CSS.
 *
 * A custom property rather than a rule per ratio, so `lib/aspect` stays the only place
 * that knows which shapes exist: `16 / 9` serves both the `aspect-ratio` and the
 * `calc(100cqh * …)` that keeps a tall frame inside a short stage.
 */
function frameStyle(id: string): CSSProperties {
  const { w, h } = aspectRatio(id);
  return { '--frame-ratio': `${w} / ${h}` } as CSSProperties;
}

/**
 * The frame's shape, as a control.
 *
 * It lives in the preview's panel head rather than in Settings because it is a property of
 * *this project* and its whole effect is visible right below it — you pick 9:16 and the
 * frame turns on its side while you watch. Settings is for the machine (credentials,
 * models); the frame is the edit.
 */
export function AspectRatioPicker() {
  const value = useEditor((s) => s.aspectRatio);
  const setAspectRatio = useEditor((s) => s.setAspectRatio);

  return (
    <div className="aspect-pick">
      <Icon name="crop" size={13} />
      {/* "Frame aspect ratio", not "Aspect ratio": the create sheet's own aspect control
          can be on screen at the same time, over this very panel, and two controls with
          one name is how you pick the wrong one. This is the project's frame. */}
      <label className="visually-hidden" htmlFor="frame-aspect">
        Frame aspect ratio
      </label>
      <select
        id="frame-aspect"
        value={value}
        title="The shape of the frame — what the preview draws and the export writes"
        onChange={(e) => setAspectRatio(e.target.value)}
      >
        {ASPECT_RATIOS.map((a) => (
          <option key={a.id} value={a.id}>
            {a.id} · {a.label}
          </option>
        ))}
      </select>
    </div>
  );
}
