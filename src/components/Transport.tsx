import { useEditor } from '../state/store';
import { formatTimecode, timelineEndMs } from '../lib/timeline';
import { Icon } from './Icon';

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
      <span className="tc" aria-label="Current time">
        {formatTimecode(playheadMs)}
      </span>
      <div className="transport__group">
        <button
          type="button"
          className="tbtn"
          aria-label="Go to start"
          title="Go to start (Home)"
          onClick={() => setPlayhead(0)}
        >
          <Icon name="skip-back" size={14} />
        </button>
        <button
          type="button"
          className="tbtn tbtn--play"
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={togglePlay}
          disabled={total === 0}
        >
          <Icon name={playing ? 'pause' : 'play'} size={16} />
        </button>
        <button
          type="button"
          className="tbtn"
          aria-label="Go to end"
          title="Go to end (End)"
          onClick={() => setPlayhead(total)}
        >
          <Icon name="skip-forward" size={14} />
        </button>
      </div>
      <span className="tc tc--dim" aria-label="Total length">
        {formatTimecode(total)}
      </span>
    </div>
  );
}
