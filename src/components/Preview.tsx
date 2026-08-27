import { useEffect, useRef } from 'react';
import { useEditor } from '../state/store';
import { clipAt, cssTransform, formatTimecode, transformAt } from '../lib/timeline';

/**
 * The preview.
 *
 * For a photo it applies the interpolated keyframe transform, so scrubbing shows the exact
 * motion the export will render. For a video it drives an element's `currentTime` off the
 * playhead, so the single track plays as one continuous piece.
 */
export function Preview() {
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const playheadMs = useEditor((s) => s.playheadMs);
  const playing = useEditor((s) => s.playing);
  const videoRef = useRef<HTMLVideoElement>(null);

  const hit = clipAt(clips, playheadMs);
  const clip = hit?.placed.clip;
  const asset = clip ? assets[clip.assetId] : undefined;
  const localMs = hit?.localMs ?? 0;

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !clip || clip.kind !== 'video') return;
    const wanted = (clip.trimStartMs + localMs) / 1000;
    if (Math.abs(el.currentTime - wanted) > 0.25) {
      el.currentTime = wanted;
    }
    if (playing) void el.play().catch(() => {});
    else el.pause();
  }, [clip, localMs, playing]);

  if (!clip) {
    return (
      <div className="stage">
        <div className="stage__empty">
          <div className="icon" aria-hidden="true">
            🎞
          </div>
          <b>Nothing on the timeline</b>
          Drop a photo or a video below to start. Photos can be animated with keyframes.
        </div>
      </div>
    );
  }

  const missing = !asset || asset.missing || !asset.src;
  const transform = clip.kind === 'photo' ? transformAt(clip, localMs) : null;

  return (
    <div className="stage">
      <div className="canvas" data-testid="preview-canvas">
        {missing ? (
          <div className="canvas__offline">
            MEDIA OFFLINE
            <br />
            <span style={{ opacity: 0.7 }}>{clip.name} is no longer available</span>
          </div>
        ) : clip.kind === 'photo' ? (
          <img
            src={asset.src}
            alt={clip.name}
            draggable={false}
            style={{ transform: cssTransform(transform!), opacity: transform!.opacity }}
          />
        ) : (
          <video
            ref={videoRef}
            src={asset.src}
            data-testid="preview-video"
            muted={false}
            playsInline
          />
        )}

        <div className="canvas__hud">
          <span aria-hidden="true">◆</span> {formatTimecode(playheadMs)}
        </div>
        {clip.ai && <div className="canvas__ai">✦ AI GENERATED</div>}
      </div>
    </div>
  );
}
