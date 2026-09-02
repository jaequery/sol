import { useRef } from 'react';
import { useEditor } from '../state/store';
import { Icon } from './Icon';
import { useModalFocus } from './useModalFocus';

export function ExportDialog() {
  const state = useEditor((s) => s.exportState);
  if (!state) return null;
  return <ExportModal />;
}

function ExportModal() {
  const state = useEditor((s) => s.exportState)!;
  const runExport = useEditor((s) => s.runExport);
  const modal = useRef<HTMLDivElement>(null);
  useModalFocus(modal);

  const failed = state.status === 'failed';
  const missingFfmpeg = failed && (state.error ?? '').toLowerCase().includes('ffmpeg was not found');

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Export">
      <div className="modal" ref={modal}>
        {/* The stage names what actually happened: a pre-flight refusal never rendered
            anything, so calling it a failed render would be untrue. */}
        <div className="modal__head">
          {failed && <Icon name="alert" size={16} />}
          {failed ? state.stage : 'Exporting to MP4'}
        </div>
        <div className="modal__body">
          {failed ? (
            <div className="errbox">
              {/* The message names the problem itself; only the ffmpeg case earns more — the
                  install block, which is the fix. */}
              {state.error}
              {missingFfmpeg && (
                <code>
                  {'macOS   brew install ffmpeg\nUbuntu  sudo apt install ffmpeg\nWindows winget install ffmpeg'}
                </code>
              )}
            </div>
          ) : (
            <>
              <div className="stage-row">
                <Icon name="spinner" size={14} /> {state.stage}
              </div>
              <div className="progress-row">
                <div className="progress">
                  <i style={{ width: `${Math.round(state.fraction * 100)}%` }} />
                </div>
                <b>{Math.round(state.fraction * 100)}%</b>
              </div>
            </>
          )}
        </div>
        <div className="modal__foot">
          <button
            type="button"
            className="btn btn--ghost"
            autoFocus
            onClick={() => useEditor.setState({ exportState: null })}
          >
            Close
          </button>
          {/*
            Only when running it again could plausibly end differently. A clip with no file
            on disk fails the same pre-check every time, so offering Try again there is a
            button that visibly does nothing.
          */}
          {failed && state.retryable && (
            <button type="button" className="btn btn--primary" onClick={() => void runExport()}>
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
