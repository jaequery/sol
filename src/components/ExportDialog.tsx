import { useEditor } from '../state/store';

export function ExportDialog() {
  const state = useEditor((s) => s.exportState);
  const runExport = useEditor((s) => s.runExport);
  if (!state) return null;

  const failed = state.status === 'failed';
  const missingFfmpeg = failed && (state.error ?? '').toLowerCase().includes('ffmpeg was not found');

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Export">
      <div className="modal">
        <div className="modal__head">{failed ? '✕ Export failed' : 'Exporting to MP4'}</div>
        <div className="modal__body">
          {failed ? (
            <div className="errbox">
              <b>{missingFfmpeg ? 'ffmpeg was not found' : 'The render did not finish'}</b>
              {state.error}
              {missingFfmpeg && (
                <code>
                  {'macOS   brew install ffmpeg\nUbuntu  sudo apt install ffmpeg\nWindows winget install ffmpeg'}
                </code>
              )}
            </div>
          ) : (
            <>
              <div className="stage-list">
                <div className="stage-row">◐ {state.stage}</div>
              </div>
              <div className="progress">
                <i style={{ width: `${Math.round(state.fraction * 100)}%` }} />
              </div>
              <div className="kv">
                <span>Rendering the timeline with ffmpeg</span>
                <b>{Math.round(state.fraction * 100)}%</b>
              </div>
            </>
          )}
        </div>
        <div className="modal__foot">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => useEditor.setState({ exportState: null })}
          >
            Close
          </button>
          {failed && (
            <button type="button" className="btn btn--primary" onClick={() => void runExport()}>
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
