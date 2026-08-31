import { useEditor } from '../state/store';

export function TitleBar() {
  const clips = useEditor((s) => s.clips);
  const generations = useEditor((s) => s.generations);
  const importViaDialog = useEditor((s) => s.importViaDialog);
  const openSettings = useEditor((s) => s.openSettings);
  const openFilmWizard = useEditor((s) => s.openFilmWizard);
  const runExport = useEditor((s) => s.runExport);
  const exporting = useEditor((s) => s.exporting);

  const rendering = Object.values(generations).filter(
    (g) => g.status === 'queued' || g.status === 'running',
  ).length;

  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="doc">
        SolCut — <b>{clips.length === 0 ? 'Untitled project' : `${clips.length} clips`}</b>
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
        {/*
          Always live, even mid-film: a running film has nowhere else to be watched, and the
          panel is where "one film at a time" is explained rather than silently enforced.
        */}
        <button type="button" className="btn btn--ghost" onClick={openFilmWizard}>
          ✦ New film from 3 photos
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => void importViaDialog()}>
          Import
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
