import { useCallback, useEffect, useRef } from 'react';
import { useEditor } from '../state/store';
import { eachMedia, laneKey, registerMedia, unregisterMedia } from '../lib/preview-sync';
import type { AudioTrack } from '../types/project';

/**
 * Plays the audio lanes during preview playback.
 *
 * Renders nothing visible: one `<audio>` element per track, kept in step with the
 * playhead by `lib/preview-sync` — `play()` and `pause()` on transitions only, a seek
 * only once a lane has drifted audibly far, and never while a previous seek is still
 * settling. The browser mixes concurrent elements natively, which is all the "mixer"
 * this preview needs.
 */
export function AudioMixer() {
  const audioTracks = useEditor((s) => s.audioTracks);
  const assets = useEditor((s) => s.assets);

  const syncNow = useCallback(() => {
    const s = useEditor.getState();
    eachMedia('lane:', (key, media) => {
      const track = s.audioTracks.find((t) => laneKey(t.id) === key);
      if (!track) {
        media.deactivate();
        return;
      }
      const localMs = s.playheadMs - track.startMs;
      const audible = localMs >= 0 && localMs < track.durationMs;
      media.updateLane(
        (track.trimStartMs + Math.max(0, localMs)) / 1000,
        s.playing && audible,
      );
    });
  }, []);

  useEffect(() => {
    syncNow();
    return useEditor.subscribe(syncNow);
  }, [syncNow]);

  return (
    <>
      {audioTracks.map((track) => {
        const src = assets[track.assetId]?.src;
        if (!src) return null;
        return <TrackAudio key={track.id} track={track} src={src} onMount={syncNow} />;
      })}
    </>
  );
}

function TrackAudio({
  track,
  src,
  onMount,
}: {
  track: AudioTrack;
  src: string;
  onMount: () => void;
}) {
  const elRef = useRef<HTMLAudioElement | null>(null);

  const ref = useCallback(
    (el: HTMLAudioElement | null) => {
      elRef.current = el;
      if (el) {
        registerMedia(laneKey(track.id), el, track.trimStartMs / 1000);
        onMount();
      } else {
        unregisterMedia(laneKey(track.id));
      }
    },
    [track.id, track.trimStartMs, onMount],
  );

  // Volume and mute are plain properties with no churn cost; they only need writing when
  // they actually change, not on every playhead tick.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    el.volume = track.volume;
    el.muted = track.muted;
  }, [track.volume, track.muted]);

  return <audio ref={ref} src={src} preload="auto" data-testid={`audio-el-${track.id}`} />;
}
