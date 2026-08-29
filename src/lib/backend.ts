/**
 * The bridge to the Rust side.
 *
 * Everything the desktop shell provides is funnelled through here, so the React tree never
 * imports Tauri directly and the whole app still renders in a plain browser (`pnpm dev`)
 * with the desktop-only actions failing loudly instead of silently doing nothing.
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AUDIO_EXTS, type MediaKind } from '../types/project';

export interface SettingsView {
  configured: boolean;
  apiKeyIdHint: string;
  hasSecret: boolean;
  baseUrl: string;
  /** The model endpoint, e.g. `/minimax/hailuo-02/standard/image-to-video`. */
  endpoint: string;
}

export interface SettingsInput {
  apiKeyId?: string;
  apiKeySecret?: string;
  baseUrl?: string;
  endpoint?: string;
}

export interface ImportedMedia {
  path: string;
  name: string;
  kind: MediaKind;
  sizeBytes: number;
}

export interface RejectedMedia {
  path: string;
  name: string;
  reason: string;
}

export interface ImportResult {
  imported: ImportedMedia[];
  rejected: RejectedMedia[];
}

export interface GenerateInput {
  generationId: string;
  prompt: string;
  startFrame: string;
  endFrame?: string;
}

export interface GenerationUpdate {
  generationId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
  /** The Higgsfield `request_id`, once the API has accepted the submission. */
  jobId?: string;
  elapsedSecs: number;
  slow: boolean;
  outputPath?: string;
  error?: { title: string; message: string; retryable: boolean };
}

export interface ExportProgress {
  stage: string;
  fraction: number;
}

const DESKTOP_ONLY = 'This needs the SolCut desktop app — run it with `pnpm tauri dev`.';

/** Kept in step with `solcut_higgsfield::DEFAULT_BASE_URL` / `DEFAULT_ENDPOINT`. */
export const DEFAULT_BASE_URL = 'https://api.higgsfield.ai';
export const DEFAULT_ENDPOINT = '/minimax/hailuo-02/standard/image-to-video';

/**
 * Documented endpoints whose contract is a SolCut segment: a first frame, a last frame
 * (`image_url`/`end_image_url`, or the veo pair's own names) and a prompt, with nothing
 * else required. Offered as suggestions in Settings so pointing at another model does
 * not mean reading the API reference first; anything else can still be typed in.
 *
 * Deliberately absent: the kling operations (their schema takes no last frame at all, so
 * a "transition" would never land on the second photo) and the `higgsfield-ai/dop` trio,
 * whose live endpoints are the API face of a single-image motion-preset product and
 * reject two-frame submissions in a way their published schema does not predict.
 */
export const KNOWN_ENDPOINTS = [
  '/minimax/hailuo-02/standard/image-to-video',
  '/minimax/hailuo-02/pro/image-to-video',
  '/veo3.1/first-last-frame-to-video',
  '/veo3.1/fast/first-last-frame-to-video',
];

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function requireDesktop(): void {
  if (!isDesktop()) throw new Error(DESKTOP_ONLY);
}

/** A path the webview can actually load. Falls back to the raw path outside Tauri. */
export function assetSrc(path: string): string {
  if (!isDesktop()) return path;
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

export async function getSettings(): Promise<SettingsView> {
  if (!isDesktop()) {
    return {
      configured: false,
      apiKeyIdHint: '',
      hasSecret: false,
      baseUrl: DEFAULT_BASE_URL,
      endpoint: DEFAULT_ENDPOINT,
    };
  }
  return invoke<SettingsView>('get_settings');
}

export async function saveSettings(input: SettingsInput): Promise<SettingsView> {
  requireDesktop();
  return invoke<SettingsView>('save_settings', { input });
}

/**
 * Prove a credential before committing to it.
 *
 * The dialog's own fields are sent, so the key being typed is the key that gets
 * authenticated; blank fields fall back to whatever the backend has stored.
 */
export async function testConnection(input: SettingsInput): Promise<string> {
  requireDesktop();
  return invoke<string>('test_connection', { input });
}

export async function importPaths(paths: string[]): Promise<ImportResult> {
  requireDesktop();
  return invoke<ImportResult>('import_media', { paths });
}

export async function generateAnimation(input: GenerateInput): Promise<void> {
  requireDesktop();
  await invoke('generate_animation', { input });
}

export async function cancelGeneration(id: string): Promise<void> {
  if (!isDesktop()) return;
  await invoke('cancel_generation', { id });
}

export async function ffmpegAvailable(): Promise<boolean> {
  if (!isDesktop()) return false;
  return invoke<boolean>('ffmpeg_available');
}

export async function exportTimeline(spec: unknown, outPath: string): Promise<string> {
  requireDesktop();
  return invoke<string>('export_timeline', { spec, outPath });
}

export async function onGenerationUpdate(cb: (u: GenerationUpdate) => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  return listen<GenerationUpdate>('generation:update', (e) => cb(e.payload));
}

export async function onExportProgress(cb: (p: ExportProgress) => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  return listen<ExportProgress>('export:progress', (e) => cb(e.payload));
}

export async function pickMediaFiles(): Promise<string[]> {
  requireDesktop();
  const { open } = await import('@tauri-apps/plugin-dialog');
  const extensions = await invoke<string[]>('supported_extensions');
  const picked = await open({
    multiple: true,
    filters: [{ name: 'Photos and videos', extensions }],
  });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

/** The "add audio track" picker: the same dialog, narrowed to sound files. */
export async function pickAudioFiles(): Promise<string[]> {
  requireDesktop();
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    multiple: true,
    filters: [{ name: 'Audio', extensions: AUDIO_EXTS }],
  });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

export async function pickExportPath(defaultName: string): Promise<string | null> {
  requireDesktop();
  const { save } = await import('@tauri-apps/plugin-dialog');
  return save({ defaultPath: defaultName, filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
}

export async function revealPath(path: string): Promise<void> {
  if (!isDesktop()) return;
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
}
