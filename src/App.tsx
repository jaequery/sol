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
import { useEditor } from './state/store';

export function App() {
  useBackendEvents();
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

/** Drives the playhead while playing, using real elapsed time rather than a fixed step. */
function usePlaybackClock() {
  const playing = useEditor((s) => s.playing);
  const advance = useEditor((s) => s.advance);
  const frame = useRef<number>(0);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();

    const tick = (now: number) => {
      advance(now - last);
      last = now;
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [playing, advance]);
}

function useKeyboardShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

      const store = useEditor.getState();
      if (e.code === 'Space') {
        e.preventDefault();
        store.togglePlay();
      } else if (e.key === 'k') {
        store.addKeyframeAtPlayhead();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        store.deleteSelection();
      } else if (e.key === 'Escape') {
        store.closeSettings();
        store.closeFilmWizard();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
