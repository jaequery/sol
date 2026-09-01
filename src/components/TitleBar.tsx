import { projectLabel, useEditor } from '../state/store';
import { ProjectMenu } from './ProjectMenu';

export function TitleBar() {
  const clips = useEditor((s) => s.clips);
  const generations = useEditor((s) => s.generations);
  const openSettings = useEditor((s) => s.openSettings);
  const runExport = useEditor((s) => s.runExport);
  const exporting = useEditor((s) => s.exporting);
  const saveError = useEditor((s) => s.saveError);
  const saveBlocked = useEditor((s) => s.saveBlocked);
  const projectPath = useEditor((s) => s.projectPath);
  const menuOpen = useEditor((s) => s.projectMenuOpen);
  const openProjectMenu = useEditor((s) => s.openProjectMenu);
  const closeProjectMenu = useEditor((s) => s.closeProjectMenu);

  const rendering = Object.values(generations).filter(
    (g) => g.status === 'queued' || g.status === 'running',
  ).length;

  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="doc">
        SolCut —{' '}
        {/*
          The project's name and the way to change which project it is, in one control. It
          used to be a clip count, which said nothing the timeline was not already showing
          and had nowhere to go once the bar had a real name to carry.
        */}
        <span className="doc__project">
          <button
            type="button"
            className="doc__name"
            aria-expanded={menuOpen}
            onClick={() => (menuOpen ? closeProjectMenu() : openProjectMenu())}
          >
            {projectLabel(projectPath)}
          </button>
          {menuOpen && <ProjectMenu />}
        </span>
        {/*
          The whole visible surface of autosave. A working one shows nothing — the work
          being there at the next launch is the confirmation — but a session that is not
          writing has to say so, or it is lost without the user ever being told. Two ways in:
          a write that failed, and a project this build must not overwrite.
        */}
        {(saveError || saveBlocked) && (
          <span
            className="doc__unsaved"
            role="status"
            title={
              saveError ??
              'This project is left untouched — open another, or start a new one, to save again.'
            }
          >
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
