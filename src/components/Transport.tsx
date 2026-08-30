import { useEditor } from '../state/store';
import { formatTimecode, timelineEndMs } from '../lib/timeline';

export function Transport() {
  const clips = useEditor((s) => s.clips);
  const audioTracks = useEditor((s) => s.audioTracks);
  const playheadMs = useEditor((s) => s.playheadMs);
  const playing = useEditor((s) => s.playing);
  const togglePlay = useEditor((s) => s.togglePlay);
  const setPlayhead = useEditor((s) => s.setPlayhead);

  // The whole timeline, audio included — a project that is only a sound is still playable,
  // and a sound outlasting the last clip still moves the end. Measuring the visual track
  // alone left ▶ dark on an audio-only project that Space would happily play.
  const total = timelineEndMs(clips, audioTracks);

  return (
    <div className="transport">
      <span className="tc">{formatTimecode(playheadMs)}</span>
      <button type="button" className="tbtn" aria-label="Go to start" onClick={() => setPlayhead(0)}>
        ⏮
      </button>
      <button
        type="button"
        className="tbtn tbtn--play"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={togglePlay}
        disabled={total === 0}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <button type="button" className="tbtn" aria-label="Go to end" onClick={() => setPlayhead(total)}>
        ⏭
      </button>
      <span className="tc tc--dim">{formatTimecode(total)}</span>
    </div>
  );
}
