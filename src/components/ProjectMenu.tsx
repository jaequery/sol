import { useEffect } from 'react';
import { useEditor } from '../state/store';

/**
 * The three project actions, hung off the title bar's project name.
 *
 * They live behind the name rather than beside the Settings and Export buttons because the
 * name is already the one thing up there that is *about* the project — making it the
 * control adds no chrome at all, where three more buttons would put the rarest actions in
 * the app permanently on screen.
 *
 * There is no plain "Save": the project is autosaved wherever it lives, so the only save
 * that means anything is the one that gives it somewhere to live.
 *
 * `role="group"` rather than `role="menu"` follows the compose panel (`ImageCompose`): a
 * menu role promises arrow-key navigation between menuitems, and half-keeping that promise
 * is worse for a screen reader than not making it.
 */
export function ProjectMenu() {
  const close = useEditor((s) => s.closeProjectMenu);
  const requestNewProject = useEditor((s) => s.requestNewProject);
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

  return (
    <div className="menu" role="group" aria-label="Project">
      <button type="button" onClick={requestNewProject}>
        New project
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
