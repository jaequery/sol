import { useEditor } from '../state/store';

export function TitleBar() {
  const clips = useEditor((s) => s.clips);
  const generations = useEditor((s) => s.generations);
  const openSettings = useEditor((s) => s.openSettings);
  const runExport = useEditor((s) => s.runExport);
  const exporting = useEditor((s) => s.exporting);
  const saveError = useEditor((s) => s.saveError);

  const rendering = Object.values(generations).filter(
    (g) => g.status === 'queued' || g.status === 'running',
  ).length;

  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="doc">
        SolCut — <b>{clips.length === 0 ? 'Untitled project' : `${clips.length} clips`}</b>
        {/*
          The whole visible surface of autosave. A working one shows nothing — the work
          being there at the next launch is the confirmation — but a broken one has to say
          so, or the session is lost without the user ever being told. The reason arrives
          as a toast; this is what is still standing after the toast is dismissed.
        */}
        {saveError && (
          <span className="doc__unsaved" role="status" title={saveError}>
            Not saved
          </span>
        )}
      </span>
      <span className="spacer" />
      <div className="actions">
        {rendering > 0 && (
          <span className="chip-run" role="status">
            ◐ {rendering} rendering
          </span>
        )}
        {/*
          Deliberately state-blind: the connection's status lives in Settings, and the
          "connect first" nudge sits on the generate paths themselves (cut card, film
          wizard), where it can act — not as a persistent branded chip up here.
        */}
        <button type="button" className="btn btn--ghost" onClick={openSettings}>
          Settings
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void runExport()}
          // One render at a time, and say so: the progress dialog can be dismissed while
          // ffmpeg is still going, so the button is the only place left to show it.
          disabled={clips.length === 0 || exporting}
          title={exporting ? 'A render is already running' : undefined}
        >
          {exporting ? 'Exporting…' : 'Export MP4'}
        </button>
      </div>
    </div>
  );
}
