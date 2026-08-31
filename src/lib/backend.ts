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
  /** The model endpoint chosen for THIS render — the selector's pick, resolved. */
  endpoint: string;
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
  error?: { title: string; message: string; retryable: boolean; build?: string };
}

export interface ExportProgress {
  stage: string;
  fraction: number;
}

const DESKTOP_ONLY = 'This needs the SolCut desktop app — run it with `pnpm tauri dev`.';

/** Kept in step with `solcut_higgsfield::DEFAULT_BASE_URL` / `DEFAULT_ENDPOINT`. */
export const DEFAULT_BASE_URL = 'https://api.higgsfield.ai';
export const DEFAULT_ENDPOINT = '/minimax/hailuo-02/standard/image-to-video';

/** One model the per-render selector offers: a label for humans, an endpoint for the API. */
export interface RenderModel {
  /** Stable id — what the store holds and a generation records. */
  id: string;
  label: string;
  /** The model endpoint posted to, appended to the base URL. */
  endpoint: string;
}

/**
 * The models the per-render selector offers, in menu order.
 *
 * Every entry's contract is a SolCut segment: a first frame, a last frame
 * (`image_url`/`end_image_url`, or the veo pair's own names) and a prompt, with nothing
 * else required — and every entry's route appears in the published OpenAPI document
 * (<https://docs.higgsfield.ai/docs/openapi.json>). Anything else can still be reached
 * through the Custom entry, which sends whatever endpoint Settings stores.
 *
 * Deliberately absent: Seedance — 2.5 has no route in the API (an earlier build guessed
 * `/bytedance/seedance/v2.5/pro/image-to-video` from the naming convention, and every
 * default render died on `404: model_not_found`), and the seedance v1 and kling
 * operations take no last frame at all, so a "transition" would never land on the second
 * photo. Also absent: the `higgsfield-ai/dop` trio, whose live endpoints are the API
 * face of a single-image motion-preset product and reject two-frame submissions in a way
 * their published schema does not predict.
 */
export const RENDER_MODELS: RenderModel[] = [
  { id: 'hailuo-02-standard', label: 'MiniMax Hailuo-02 Standard', endpoint: '/minimax/hailuo-02/standard/image-to-video' },
  { id: 'hailuo-02-pro', label: 'MiniMax Hailuo-02 Pro', endpoint: '/minimax/hailuo-02/pro/image-to-video' },
  { id: 'veo-3.1', label: 'Veo 3.1', endpoint: '/veo3.1/first-last-frame-to-video' },
  { id: 'veo-3.1-fast', label: 'Veo 3.1 Fast', endpoint: '/veo3.1/fast/first-last-frame-to-video' },
];

/** What a render uses when the user never touches the selector. */
export const DEFAULT_MODEL_ID = 'hailuo-02-standard';

/** The selector entry that sends the endpoint typed into Settings instead of a known model. */
export const CUSTOM_MODEL_ID = 'custom';

/**
 * The endpoint a model choice resolves to at render time. `custom` reads the endpoint
 * Settings stores; an unknown id falls back to the default model rather than sending
 * nothing, so a stale stored choice can never produce an endpoint-less request.
 */
export function modelEndpoint(modelId: string, customEndpoint?: string): string {
  if (modelId === CUSTOM_MODEL_ID) {
    const typed = customEndpoint?.trim();
    if (typed) return typed;
  }
  const model = RENDER_MODELS.find((m) => m.id === modelId);
  const fallback = RENDER_MODELS.find((m) => m.id === DEFAULT_MODEL_ID) ?? RENDER_MODELS[0];
  return (model ?? fallback).endpoint;
}

/** The human name for a model choice, for cards that show what is rendering. */
export function modelLabel(modelId: string): string {
  if (modelId === CUSTOM_MODEL_ID) return 'Custom endpoint';
  return RENDER_MODELS.find((m) => m.id === modelId)?.label ?? modelId;
}

/**
 * Offered as suggestions on the Settings endpoint box, so pointing at another model does
 * not mean reading the API reference first; anything else can still be typed in.
 */
export const KNOWN_ENDPOINTS = RENDER_MODELS.map((m) => m.endpoint);

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
