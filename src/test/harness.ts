/**
 * Shared setup for suites that mount the whole `App`.
 *
 * The `vi.mock` factories themselves cannot live here — they are hoisted to the top of the
 * importing file — but the store reset can, and it is the part that actually rots: it names
 * every key of the editor's state, so a suite carrying its own stale copy leaks state
 * between tests in ways that only show up as a mystery failure three files later.
 */

import { DEFAULT_MODEL_ID } from '../lib/backend';
import { resetPreviewSync } from '../lib/preview-sync';
import { emptyImagePanel, forgetSavedSnapshot, useEditor } from '../state/store';

/**
 * Put the editor back to first-run.
 *
 * `pxPerSecond: 100` is load-bearing rather than cosmetic: at 100 px per second one pixel
 * is exactly ten milliseconds, which is what lets a drag assertion be written in pixels.
 * The app's own default is 46.
 */
export function resetEditor(): void {
  // Media elements from an unmounted tree must not keep steering the next test's playhead.
  resetPreviewSync();
  // Nothing has been written for *this* editor, whatever the last one managed to write.
  forgetSavedSnapshot();
  useEditor.setState({
    settings: null,
    connectionMessage: null,
    assets: {},
    clips: [],
    audioTracks: [],
    selection: { kind: 'none' },
    playheadMs: 0,
    playing: false,
    generations: {},
    modelId: DEFAULT_MODEL_ID,
    cutPrompts: {},
    cutModes: {},
    animateQueue: null,
    animateSubmittingId: null,
    // A run left standing flips `resolveCutMode`'s fallback to insert for the next test,
    // which reads as a mode bug a long way from the test that actually leaked it.
    animateRun: null,
    film: null,
    filmWizardOpen: false,
    imagePanel: emptyImagePanel(),
    importProblems: [],
    importing: 0,
    draggingAssetId: null,
    toasts: [],
    exportState: null,
    exporting: false,
    ffmpegAvailable: null,
    settingsOpen: false,
    snapping: true,
    pxPerSecond: 100,
    saveError: null,
    saving: false,
    savedAt: null,
    projectPath: null,
    saveBlocked: false,
    pendingSwitch: null,
    projectMenuOpen: false,
    recentProjects: [],
    newProjectName: null,
  });
}

/** An asset's object URL, looked up by name — ids and blob URLs are never stable. */
export function srcOf(name: string): string | undefined {
  return Object.values(useEditor.getState().assets).find((a) => a.name === name)?.src;
}
