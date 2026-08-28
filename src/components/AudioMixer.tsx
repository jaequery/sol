import { useEffect, useRef } from 'react';
import { useEditor } from '../state/store';
import type { AudioTrack } from '../types/project';

/**
 * Plays the audio lanes during preview playback.
 *
 * Renders nothing visible: one `<audio>` element per track, driven off the playhead the
 * same way the preview video is — its clock snapped only when it drifts noticeably, so
 * playback is continuous rather than a stutter of seeks. The browser mixes concurrent
 * elements natively, which is all the "mixer" this preview needs.
 */
export function AudioMixer() {
  const audioTracks = useEditor((s) => s.audioTracks);
  const assets = useEditor((s) => s.assets);
  const playheadMs = useEditor((s) => s.playheadMs);
  const playing = useEditor((s) => s.playing);

  return (
    <>
      {audioTracks.map((track) => {
        const src = assets[track.assetId]?.src;
        if (!src) return null;
        return (
          <TrackAudio key={track.id} track={track} src={src} playheadMs={playheadMs} playing={playing} />
        );
      })}
    </>
  );
}

function TrackAudio({
  track,
  src,
  playheadMs,
  playing,
}: {
  track: AudioTrack;
  src: string;
  playheadMs: number;
  playing: boolean;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const localMs = playheadMs - track.startMs;
  const audible = localMs >= 0 && localMs < track.durationMs;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = track.volume;
    el.muted = track.muted;

    if (!playing || !audible) {
      el.pause();
      return;
    }
    const wanted = (track.trimStartMs + localMs) / 1000;
    if (Math.abs(el.currentTime - wanted) > 0.25) {
      el.currentTime = wanted;
    }
    // `play` yields a promise in browsers and nothing in jsdom; both must be survivable.
    void el.play()?.catch(() => {});
  }, [track, src, localMs, audible, playing]);

  return <audio ref={ref} src={src} preload="auto" data-testid={`audio-el-${track.id}`} />;
}
