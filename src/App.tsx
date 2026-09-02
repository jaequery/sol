import { useEffect, useRef } from 'react';
import { AudioMixer } from './components/AudioMixer';
import { ExportDialog } from './components/ExportDialog';
import { FilmWizard } from './components/FilmWizard';
import { Inspector } from './components/Inspector';
import { MediaBin } from './components/MediaBin';
import { Preview } from './components/Preview';
import { SettingsDialog } from './components/SettingsDialog';
import { SwitchProjectDialog } from './components/SwitchProjectDialog';
import { Timeline } from './components/Timeline';
import { Toasts } from './components/Toasts';
import { TitleBar } from './components/TitleBar';
import { Transport } from './components/Transport';
import { isDesktop, onExportProgress, onGenerationUpdate, onWindowClose } from './lib/backend';
import { nextPlayheadMs } from './lib/preview-sync';
import { canSplitAt, timelineEndMs } from './lib/timeline';
import { liveGenerationKey, unsavedChanges, useEditor, type RestoreOutcome } from './state/store';

/**
 * Which window chrome this build is drawn under. On macOS the desktop app hides the
 * native title bar and lets the traffic lights float over ours (tauri.conf.json), so the
 * title bar has to leave them room; nowhere else does.
 */
function platform(): 'mac' | 'other' {
  return isDesktop() && /Mac/.test(navigator.platform) ? 'mac' : 'other';
}

export function App() {
  useBackendEvents();
  useProjectPersistence();
  usePlaybackClock();
  useKeyboardShortcuts();

  return (
    <div className="app" data-platform={platform()}>
      <TitleBar />
      <div className="body">
        <MediaBin />
        <div className="col">
          <div className="panel-head">
            <span className="panel-head__title">Preview</span>
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
      <SwitchProjectDialog />
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
 * How often the editor is asked whether anything is still unwritten.
 *
 * The change stream is not the whole story, which is why this exists at all rather than
 * being a second way to do the same job:
 *
 * - **A write that failed** — an unplugged drive, a full disk — used to sit there unwritten
 *   until the user happened to make another edit. Now it is retried on its own.
 * - **Where the user is looking** deliberately does not trigger the debounce, because the
 *   playhead moves sixty times a second during playback. This is what gets it to disk.
 * - **Anything the change stream misses** lands within one interval instead of never.
 *
 * Deliberately the same number as the ceiling above: both answer "how stale is the file
 * allowed to be", and two different answers to that would be two things to reason about.
 */
const SAVE_HEARTBEAT_MS = 5000;
/**
 * How long the last write gets before the window closes anyway.
 *
 * The close is *held* for the flush, so a write that never settles is a window that never
 * shuts. Losing the last edit is a bad outcome; an editor the user cannot quit is a worse
 * one, so the wait is bounded.
 */
const CLOSE_FLUSH_TIMEOUT_MS = 3000;

/**
 * The saved project: put it back at launch, then keep it written as the editor changes.
 *
 * Autosave is still the whole of how a project reaches disk — Save as… only decides *which*
 * file that is. Three rules carry it:
 *
 * 1. **Restore answers before *any* writer starts.** Arming a writer first would let an
 *    empty editor write over a good project before the read came back. There are three
 *    writers now — the change subscription, the heartbeat and the close flush — and all
 *    three are armed in `arm`, together, for exactly this reason. Before that, the close
 *    listener is not registered at all, so a window closed during a slow restore closes
 *    natively and writes nothing: fail-open, which is the safe direction.
 * 2. **The refusal lives in the store, not here.** A project that must not be overwritten
 *    sets `saveBlocked`, and `persistProject` writes nothing while it is up. This hook used
 *    to enforce that by never subscribing, which also meant a session could never be
 *    un-blocked: opening another project or naming this one had no way to turn saving back
 *    on. It subscribes unconditionally now, and the store decides each write.
 * 3. **The restore happens once per editor**, however many times the effect runs.
 */
function useProjectPersistence() {
  const restoreProject = useEditor((s) => s.restoreProject);
  /**
   * The restore, shared across StrictMode's deliberate mount → unmount → mount.
   *
   * This holds the *promise*, and that is the whole fix. It used to hold the outcome, which
   * is only assigned once the promise resolves — long after StrictMode's remount, which is
   * synchronous. So both effect runs found it null and started their own restore; the first
   * installed the project and the second found clips already on the timeline, concluded the
   * editor had been in use, and switched saving off for the rest of the session. In a
   * development build — how the app is actually run — that meant every launch with a
   * non-empty project wrote nothing at all, and the next launch was back where the last one
   * started. Holding the promise makes the second run await the first run's answer.
   */
  const restore = useRef<Promise<RestoreOutcome> | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    const unlisten: Array<() => void> = [];
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

    /**
     * The write the window is held open for.
     *
     * Awaitable where `flush` is not, which is the whole point: the store queues every
     * writer, and a `persistProject` joining that queue both waits for anything already in
     * flight and re-reads the newest state when its own turn comes — so this one call
     * subsumes the pending debounce and any deferred re-flush behind it.
     */
    const flushNow = async () => {
      clearTimeout(timer);
      pendingSince = 0;
      if (disposed) return;
      await useEditor.getState().persistProject();
    };

    const schedule = () => {
      const now = Date.now();
      if (pendingSince === 0) pendingSince = now;
      clearTimeout(timer);
      timer = setTimeout(flush, Math.min(SAVE_DEBOUNCE_MS, Math.max(0, pendingSince + SAVE_MAX_WAIT_MS - now)));
    };

    // Takes no argument on purpose: what the restore *concluded* is the store's business —
    // a refusal has already set `saveBlocked` there — and the writers arm either way, so
    // that naming this project or opening another can turn saving back on.
    const arm = () => {
      if (disposed || unsubscribe) return;

      unsubscribe = useEditor.subscribe((state, prev) => {
        // Only the document is worth writing on sight. Reference equality is exact here —
        // every action replaces these immutably — and it is what keeps the playhead, which
        // moves sixty times a second during playback, from writing the file sixty times a
        // second. Where the user is *looking* is saved too, but it rides along with the next
        // write and the heartbeat rather than causing one.
        if (
          state.clips === prev.clips &&
          state.assets === prev.assets &&
          state.audioTracks === prev.audioTracks &&
          state.cutPrompts === prev.cutPrompts &&
          state.cutModes === prev.cutModes &&
          // A render starting or ending changes what is worth recording. Compared by
          // reference first so the common case costs nothing: `applyGenerationUpdate`
          // replaces this object on every poll to move a progress bar, and none of that
          // reaches the file — hence the projection rather than the object.
          (state.generations === prev.generations ||
            liveGenerationKey(state.generations) === liveGenerationKey(prev.generations))
        ) {
          return;
        }
        schedule();
      });

      heartbeat = setInterval(() => {
        const state = useEditor.getState();
        if (state.saveBlocked || !unsavedChanges(state)) return;
        flush();
      }, SAVE_HEARTBEAT_MS);

      // The effect can be torn down before `listen` resolves; drop the handle if so —
      // otherwise StrictMode leaves two handlers registered, both racing to close.
      void onWindowClose(async () => {
        // Bounded: the close is held for this, so a write that never settles would be a
        // window that never shuts.
        await Promise.race([
          flushNow(),
          new Promise<void>((resolve) => setTimeout(resolve, CLOSE_FLUSH_TIMEOUT_MS)),
        ]);
      }).then((off) => (disposed ? off() : unlisten.push(off)));
    };

    if (restore.current === null) restore.current = restoreProject();
    void restore.current.then(arm);

    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      unsubscribe?.();
      unlisten.forEach((off) => off());
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
/** Where a keypress is text. Delete here is a backspace, never a timeline edit. */
const TEXT_ENTRY = 'input, textarea, select, [contenteditable]';

/** The playhead's step under ← →, and with Shift held. Matches the clips' own nudge. */
const STEP_MS = 100;
const COARSE_STEP_MS = 1000;

/**
 * The editor's keys, all of them:
 *
 * - Space plays and pauses; Home and End cue the two ends; ← → step the playhead
 *   (Shift for a second at a time); S splits at the playhead.
 * - Delete and Backspace remove the selection — from anywhere that is not a text field,
 *   so a clip reached by Tab can be deleted without first clicking away from it.
 * - Escape closes the innermost layer.
 *
 * Space and the arrows stand back from any control that answers to them itself: a
 * focused button is activated by Space, and a focused clip nudges itself with the arrows.
 */
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
        // The switch question is asked over everything else and answered before anything
        // else can be, so it is the innermost layer whenever it is up. Escape is its Cancel:
        // the project on screen stays, exactly as the dialog's own Cancel does.
        if (store.pendingSwitch) void store.resolveSwitch('cancel');
        else if (store.exportState) useEditor.setState({ exportState: null });
        else if (store.settingsOpen) store.closeSettings();
        // Above the film panel, which it is drawn over and which stays open behind it.
        else if (store.projectMenuOpen) store.closeProjectMenu();
        else if (store.filmWizardOpen) store.closeFilmWizard();
        // The compose panel keeps its draft when it closes, so Escape here is a way out
        // rather than a way to lose a typed prompt.
        else if (store.imagePanel.open) store.closeImagePanel();
        return;
      }

      // A scrim is over the app: the timeline underneath is not what the user is typing at.
      // The film panel is deliberately *not* in this list — it is non-modal by design, so
      // the editor stays usable while a film renders.
      if (store.settingsOpen || store.exportState || store.pendingSwitch) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const onControl = Boolean(target?.closest(INTERACTIVE));
      const typing = Boolean(target?.closest(TEXT_ENTRY));

      if (e.code === 'Space') {
        if (onControl) return;
        e.preventDefault();
        store.togglePlay();
        return;
      }
      if (typing) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        store.deleteSelection();
      } else if (e.key === 'Home') {
        e.preventDefault();
        store.setPlayhead(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        store.setPlayhead(timelineEndMs(store.clips, store.audioTracks));
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !onControl) {
        e.preventDefault();
        const step = e.shiftKey ? COARSE_STEP_MS : STEP_MS;
        store.setPlayhead(Math.max(0, store.playheadMs + (e.key === 'ArrowLeft' ? -step : step)));
      } else if ((e.key === 's' || e.key === 'S') && !onControl) {
        if (!canSplitAt(store.clips, store.playheadMs)) return;
        e.preventDefault();
        store.splitAtPlayhead();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
