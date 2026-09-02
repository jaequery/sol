import { useEffect } from 'react';
import { projectLabel, useEditor } from '../state/store';

/**
 * The projects, and the three things that can be done to them, hung off the title bar's
 * project name.
 *
 * They live behind the name rather than beside the Settings and Export buttons because the
 * name is already the one thing up there that is *about* the project — making it the
 * control adds no chrome at all, where more buttons would put the rarest actions in the app
 * permanently on screen.
 *
 * The list above them is what makes switching an action rather than an errand: a project
 * the app remembers is one click, and `Open project…` is left for the file it does not.
 * The project already open is deliberately absent — its name is the control this menu hangs
 * from, directly above, and choosing it would do nothing.
 *
 * There is no plain "Save": the project is autosaved wherever it lives, so the only save
 * that means anything is the one that gives it somewhere else to live.
 *
 * `role="group"` rather than `role="menu"` follows the compose panel (`ImageCompose`): a
 * menu role promises arrow-key navigation between menuitems, and half-keeping that promise
 * is worse for a screen reader than not making it.
 */
export function ProjectMenu() {
  const close = useEditor((s) => s.closeProjectMenu);
  const recents = useEditor((s) => s.recentProjects);
  const projectPath = useEditor((s) => s.projectPath);
  const name = useEditor((s) => s.newProjectName);
  const openRecentProject = useEditor((s) => s.openRecentProject);
  const startNewProject = useEditor((s) => s.startNewProject);
  const setNewProjectName = useEditor((s) => s.setNewProjectName);
  const createNewProject = useEditor((s) => s.createNewProject);
  const requestOpenProject = useEditor((s) => s.requestOpenProject);
  const saveProjectAs = useEditor((s) => s.saveProjectAs);

  useEffect(() => {
    // The app has no click-outside anywhere else, so this is the timeline drag's own shape:
    // one global listener, put up and taken down with the surface it belongs to. It watches
    // `pointerdown` while the trigger opens on `click`, so the press that opened the menu
    // is long finished before this is listening and cannot close it again.
    //
    // Escape is deliberately not here — it is handled in `App.tsx` with every other layer,
    // so one press closes exactly one of them, innermost first.
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('.menu, .doc__name')) close();
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [close]);

  const others = recents.filter((path) => path !== projectPath);

  // Naming a project is the whole menu while it is happening. The list and the actions are
  // not choices the user is weighing any more — they have already made this one — and
  // leaving them up would be three ways to abandon a half-typed name by accident.
  if (name !== null) {
    return (
      <form
        className="menu menu--new"
        onSubmit={(e) => {
          e.preventDefault();
          void createNewProject();
        }}
      >
        <label htmlFor="new-project-name">New project</label>
        <input
          id="new-project-name"
          autoComplete="off"
          autoFocus
          placeholder="Beach reel"
          value={name}
          onChange={(e) => setNewProjectName(e.target.value)}
        />
        {/* Where it lands, before it lands there. Without this the one thing the native
            save panel was good at — showing the folder — is the one thing lost. */}
        <p className="hint">in {folderOf(projectPath)}</p>
        <button type="submit" className="btn btn--primary" disabled={name.trim() === ''}>
          Create
        </button>
      </form>
    );
  }

  return (
    <div className="menu" role="group" aria-label="Project">
      {/* Direct children of `.menu`, not wrapped in a list element: `.menu > button` is a
          direct-child selector, and a wrapper would silently drop every row out of it. */}
      {others.map((path) => (
        <button
          key={path}
          type="button"
          className="menu__recent"
          // Named past the label, as the switch dialog's Cancel is: the title bar's own
          // button carries the open project's bare name, and two of them would make every
          // by-name query in the suite ambiguous for whoever writes the next test.
          aria-label={`Open ${projectLabel(path)}`}
          title={path}
          onClick={() => openRecentProject(path)}
        >
          {projectLabel(path)}
        </button>
      ))}
      <button
        type="button"
        className={others.length > 0 ? 'menu__first' : undefined}
        onClick={startNewProject}
      >
        New project…
      </button>
      <button type="button" onClick={requestOpenProject}>
        Open project…
      </button>
      <button type="button" onClick={() => void saveProjectAs()}>
        Save as…
      </button>
    </div>
  );
}

/**
 * The folder a new project would land in, named the way someone would say it out loud.
 *
 * Just the containing folder, not the whole path: the point is to answer "where is this
 * going" at a glance, and a full path in a 168px popover answers it by not fitting. Mirrors
 * `new_project_path`'s own choice — beside the open project, else the documents folder.
 */
function folderOf(path: string | null): string {
  if (!path) return 'Documents';
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.pop() || '/';
}
