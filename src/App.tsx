import { useEffect, useRef } from 'react';
import { AudioMixer } from './components/AudioMixer';
import { ExportDialog } from './components/ExportDialog';
import { FilmWizard } from './components/FilmWizard';
import { Inspector } from './components/Inspector';
import { MediaBin } from './components/MediaBin';
import { Preview } from './components/Preview';
import { SettingsDialog } from './components/SettingsDialog';
import { Timeline } from './components/Timeline';
import { Toasts } from './components/Toasts';
import { TitleBar } from './components/TitleBar';
import { Transport } from './components/Transport';
import { onExportProgress, onGenerationUpdate } from './lib/backend';
import { nextPlayheadMs } from './lib/preview-sync';
import { useEditor, type RestoreOutcome } from './state/store';

export function App() {
  useBackendEvents();
  useProjectPersistence();
  usePlaybackClock();
  useKeyboardShortcuts();

  return (
    <div className="app">
      <TitleBar />
      <div className="body">
        <MediaBin />
        <div className="col">
          <div className="panel-head">
            Preview <span className="right">1920 × 1080 · 30 fps</span>
          </div>
          <Preview />
          <Transport />
        </div>
        <Inspector />
      </div>
      <Timeline />
      <AudioMixer />
      <FilmWizard />
      <SettingsDialog />
      <ExportDialog />
      <Toasts />
    </div>
  );
}

/** Subscribe to the Rust side's progress events for the lifetime of the app. */
function useBackendEvents() {
  const applyGenerationUpdate = useEditor((s) => s.applyGenerationUpdate);
  const setExportProgress = useEditor((s) => s.setExportProgress);
  const loadSettings = useEditor((s) => s.loadSettings);

  useEffect(() => {
    void loadSettings();
    const unlisten: Array<() => void> = [];
    let cancelled = false;

    // The effect can be torn down before `listen` resolves; drop the handle if so.
    const keep = (off: () => void) => {
      if (cancelled) off();
      else unlisten.push(off);
    };
    void onGenerationUpdate(applyGenerationUpdate).then(keep);
    void onExportProgress((p) => setExportProgress(p.stage, p.fraction)).then(keep);

    return () => {
      cancelled = true;
      unlisten.forEach((off) => off());
    };
  }, [applyGenerationUpdate, setExportProgress, loadSettings]);
}

/** How long the editor has to be still before the project is written. */
const SAVE_DEBOUNCE_MS = 500;
/**
 * How long a *continuously* changing timeline may go unwritten.
 *
 * Without a ceiling the debounce is pushed back by every mousemove, so a thirty-second
 * drag would save nothing at all. This is the promise that an edit lands even mid-gesture.
 */
const SAVE_MAX_WAIT_MS = 5000;

/**
 * The saved project: put it back at launch, then keep it written as the timeline changes.
 *
 * There is no save action anywhere in the app — this hook is the whole feature. Two rules
 * carry it:
 *
 * 1. **Restore answers before autosave starts.** Arming the subscription first would let
 *    an empty editor write over a good project before the read came back.
 * 2. **A `blocked` answer never writes.** If the stored project could not be read, or was
 *    written by a newer build, this session saves nothing rather than destroying it.
 */
function useProjectPersistence() {
  const restoreProject = useEditor((s) => s.restoreProject);
  // Survives StrictMode's deliberate mount/unmount/mount, so the restore runs once per
  // editor rather than twice — the second run would find its own work already on the
  // timeline and mistake it for the user having got there first.
  const outcome = useRef<RestoreOutcome | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let writing = false;
    let again = false;
    let pendingSince = 0;

    const flush = () => {
      pendingSince = 0;
      if (disposed) return;
      // One write at a time, or two of them race and the older timeline can land last.
      if (writing) {
        again = true;
        return;
      }
      writing = true;
      void useEditor
        .getState()
        .persistProject()
        .finally(() => {
          writing = false;
          if (again) {
            again = false;
            flush();
          }
        });
    };

    const schedule = () => {
      const now = Date.now();
      if (pendingSince === 0) pendingSince = now;
      clearTimeout(timer);
      timer = setTimeout(flush, Math.min(SAVE_DEBOUNCE_MS, Math.max(0, pendingSince + SAVE_MAX_WAIT_MS - now)));
    };

    const arm = (result: RestoreOutcome) => {
      outcome.current = result;
      if (disposed || result === 'blocked') return;
      unsubscribe = useEditor.subscribe((state, prev) => {
        // Only the document is worth writing. Reference equality is exact here — every
        // action replaces these immutably — and it is what keeps the playhead, which moves
        // sixty times a second during playback, from writing the file sixty times a second.
        if (
          state.clips === prev.clips &&
          state.assets === prev.assets &&
          state.audioTracks === prev.audioTracks &&
          state.cutPrompts === prev.cutPrompts &&
          state.cutModes === prev.cutModes
        ) {
          return;
        }
        schedule();
      });
    };

    if (outcome.current !== null) arm(outcome.current);
    else void restoreProject().then(arm);

    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [restoreProject]);
}

/**
 * Drives the playhead while playing.
 *
 * The wall clock is only the fallback: inside a playing video clip the element itself is
 * the master (`nextPlayheadMs`), so the timecode can never outrun the frame on screen and
 * a buffering video holds the playhead instead of falling behind it. `last = now` must
 * run unconditionally every tick — time spent held by a buffering element is discarded,
 * not accumulated, or releasing the hold would jump the playhead by the whole hold and
 * force the very seek the hold exists to avoid.
 */
function usePlaybackClock() {
  const playing = useEditor((s) => s.playing);
  const frame = useRef<number>(0);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();

    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      const s = useEditor.getState();
      s.advance(nextPlayheadMs(s.playheadMs, delta, s.clips, now) - s.playheadMs);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [playing]);
}

/** Anything that consumes a keypress itself — a shortcut must not talk over it. */
const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [contenteditable]';

function useKeyboardShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const store = useEditor.getState();

      // Escape first, and before the typing guard: the fields it has to rescue the user
      // from are exactly the ones that guard would skip. It closes one layer — the
      // innermost — rather than every dialog at once. Escape is Cancel here: an unsaved
      // credential is discarded, the same as the dialog's own Cancel button does.
      if (e.key === 'Escape') {
        if (store.exportState) useEditor.setState({ exportState: null });
        else if (store.settingsOpen) store.closeSettings();
        else if (store.filmWizardOpen) store.closeFilmWizard();
        // The compose panel keeps its draft when it closes, so Escape here is a way out
        // rather than a way to lose a typed prompt.
        else if (store.imagePanel.open) store.closeImagePanel();
        return;
      }

      // A scrim is over the app: the timeline underneath is not what the user is typing at.
      // The film panel is deliberately *not* in this list — it is non-modal by design, so
      // the editor stays usable while a film renders.
      if (store.settingsOpen || store.exportState) return;

      if (target?.closest(INTERACTIVE)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        store.togglePlay();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        store.deleteSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
