import { useEditor } from '../state/store';

export function TitleBar() {
  const clips = useEditor((s) => s.clips);
  const generations = useEditor((s) => s.generations);
  const importViaDialog = useEditor((s) => s.importViaDialog);
  const openSettings = useEditor((s) => s.openSettings);
  const openFilmWizard = useEditor((s) => s.openFilmWizard);
  const runExport = useEditor((s) => s.runExport);
  const settings = useEditor((s) => s.settings);

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
        <button type="button" className="btn btn--ghost" onClick={openSettings}>
          {settings?.configured ? '✦ Higgsfield' : '✦ Connect Higgsfield'}
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
          disabled={clips.length === 0}
        >
          Export MP4
        </button>
      </div>
    </div>
  );
}
