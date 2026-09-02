import { projectLabel, useEditor } from '../state/store';
import { Icon } from './Icon';
import { ProjectMenu } from './ProjectMenu';

export function TitleBar() {
  const clips = useEditor((s) => s.clips);
  const generations = useEditor((s) => s.generations);
  const openSettings = useEditor((s) => s.openSettings);
  const runExport = useEditor((s) => s.runExport);
  const exporting = useEditor((s) => s.exporting);
  const saveError = useEditor((s) => s.saveError);
  const saveBlocked = useEditor((s) => s.saveBlocked);
  const saving = useEditor((s) => s.saving);
  const savedAt = useEditor((s) => s.savedAt);
  const projectPath = useEditor((s) => s.projectPath);
  const menuOpen = useEditor((s) => s.projectMenuOpen);
  const openProjectMenu = useEditor((s) => s.openProjectMenu);
  const closeProjectMenu = useEditor((s) => s.closeProjectMenu);

  const rendering = Object.values(generations).filter(
    (g) => g.status === 'queued' || g.status === 'running',
  ).length;

  const save = saveState({ saveBlocked, saveError, saving, savedAt });

  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="doc" data-tauri-drag-region>
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
            onClick={() => (menuOpen ? closeProjectMenu() : void openProjectMenu())}
          >
            {projectLabel(projectPath)}
          </button>
          {menuOpen && <ProjectMenu />}
        </span>
        {/*
          The whole visible surface of autosave: one word, in the one slot. `role="status"`
          only on the problem states — an always-announced region would read "Saving… Saved"
          at every debounce, which is noise about the thing that is going *right*.
        */}
        {save && (
          <span
            className={'doc__save' + (save.problem ? ' doc__save--problem' : '')}
            role={save.problem ? 'status' : undefined}
            title={save.detail}
          >
            {save.text}
          </span>
        )}
      </span>
      <span className="spacer" data-tauri-drag-region />
      <div className="actions">
        {rendering > 0 && (
          <span className="chip-run" role="status">
            <Icon name="spinner" size={12} /> {rendering} rendering
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
          title={
            exporting
              ? 'A render is already running'
              : clips.length === 0
                ? 'Put something on the timeline to export'
                : 'Render the timeline to an MP4 file'
          }
        >
          {exporting ? 'Exporting…' : 'Export MP4'}
        </button>
      </div>
    </div>
  );
}

/** What the save indicator is showing, or `null` for the states worth showing nothing for. */
function saveState(s: {
  saveBlocked: boolean;
  saveError: string | null;
  saving: boolean;
  savedAt: number | null;
}): { text: string; detail: string; problem: boolean } | null {
  // Order is load-bearing, and `saveBlocked` has to come first: `persistProject` answers
  // "true" while blocked — nothing failed, there was simply nothing it was allowed to write
  // — so a session writing nothing at all would otherwise sit here claiming "Saved" beside
  // the name of a real file it is not touching.
  if (s.saveBlocked) {
    return {
      text: 'Not saved',
      detail: 'This project is left untouched — open another, or start a new one, to save again.',
      problem: true,
    };
  }
  if (s.saveError) return { text: 'Not saved', detail: s.saveError, problem: true };
  if (s.saving) return { text: 'Saving…', detail: 'Writing the project to disk.', problem: false };
  // Nothing at all until a write has actually landed. A fresh launch has saved nothing yet,
  // and the bar claiming otherwise is the exact lie this indicator exists to stop telling.
  if (s.savedAt === null) return null;
  return {
    text: 'Saved',
    detail: `Last saved at ${new Date(s.savedAt).toLocaleTimeString()}.`,
    problem: false,
  };
}
