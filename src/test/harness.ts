/**
 * Shared setup for suites that mount the whole `App`.
 *
 * The `vi.mock` factories themselves cannot live here — they are hoisted to the top of the
 * importing file — but the store reset can, and it is the part that actually rots: it names
 * every key of the editor's state, so a suite carrying its own stale copy leaks state
 * between tests in ways that only show up as a mystery failure three files later.
 */

import { DEFAULT_MODEL_ID } from '../lib/backend';
import { useEditor } from '../state/store';

/**
 * Put the editor back to first-run.
 *
 * `pxPerSecond: 100` is load-bearing rather than cosmetic: at 100 px per second one pixel
 * is exactly ten milliseconds, which is what lets a drag assertion be written in pixels.
 * The app's own default is 46.
 */
export function resetEditor(): void {
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
    animateQueue: null,
    animateSubmittingId: null,
    film: null,
    filmWizardOpen: false,
    importProblems: [],
    importing: 0,
    toasts: [],
    exportState: null,
    exporting: false,
    ffmpegAvailable: null,
    settingsOpen: false,
    snapping: true,
    pxPerSecond: 100,
  });
}

/** An asset's object URL, looked up by name — ids and blob URLs are never stable. */
export function srcOf(name: string): string | undefined {
  return Object.values(useEditor.getState().assets).find((a) => a.name === name)?.src;
}
