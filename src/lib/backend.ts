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
  /**
   * The Higgsfield CLI binary was found — generation can at least be attempted.
   *
   * Deliberately says nothing about the API key: renders go through the CLI, so a stored
   * key must never make the app offer a generation it cannot run.
   */
  configured: boolean;
  /** Where it was found, for the dialog to show; null when it wasn't. */
  cliPath: string | null;
  /** A CLI model id offered as the Model picker's Custom entry; blank for none. */
  customModel: string;
  /** A whole Cloud API credential is stored — both halves. */
  hasApiKey: boolean;
  /** e.g. `••••7fa2`, or blank. The key id itself never reaches this window, nor the secret. */
  apiKeyIdHint: string;
}

export interface SettingsInput {
  customModel?: string;
  /** Blank means "keep the stored one" — the key boxes always mount empty. */
  apiKeyId?: string;
  apiKeySecret?: string;
  /** Remove the stored credential. The only way out of blank-means-keep. */
  forgetApiKey?: boolean;
}

/** What one API key check concluded — its own heading, separate from the CLI check's. */
export interface KeyCheck {
  ok: boolean;
  title: string;
  text: string;
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
  /** The CLI model id chosen for THIS render — the selector's pick, resolved. */
  model: string;
}

export interface GenerationUpdate {
  generationId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
  /** The CLI's job id, once the submission has been accepted. */
  jobId?: string;
  elapsedSecs: number;
  slow: boolean;
  outputPath?: string;
  error?: { title: string; message: string; retryable: boolean; build?: string };
}

/**
 * One "make me a photo" request from the media bin's compose panel.
 *
 * Nothing here is a data URL: the references are the bin's own files, and the CLI
 * uploads a local path itself.
 */
export interface GenerateImageInput {
  generationId: string;
  prompt: string;
  /** Absolute paths of the bin photos to work from. Empty is plain text-to-image. */
  references: string[];
  /** The CLI image job type chosen for THIS request. */
  model: string;
  /** e.g. `16:9`. */
  aspectRatio: string;
}

export interface ExportProgress {
  stage: string;
  fraction: number;
}

const DESKTOP_ONLY = 'This needs the SolCut desktop app — run it with `pnpm tauri dev`.';

/** How the CLI is installed and signed in, quoted wherever the app has to say so. */
export const CLI_INSTALL = 'npm i -g @higgsfield/cli';
export const CLI_LOGIN = 'higgsfield auth login';
export const CLI_WORKSPACE = 'higgsfield workspace set <workspace_id>';

/** One model the per-render selector offers: a label for humans, a job id for the CLI. */
export interface RenderModel {
  /** Stable id — what the store holds and a generation records. */
  id: string;
  label: string;
  /** The CLI job type, e.g. `seedance_2_5` — what `higgsfield generate create` takes. */
  job: string;
}

/**
 * The models the per-render selector offers, in menu order.
 *
 * Every entry's contract is a SolCut segment: a first frame, a last frame and a prompt,
 * with nothing else required — every non-default entry documents `--start-image` and
 * `--end-image` in the CLI's own MODELS.md, and the default is the id Higgsfield's site
 * opens Seedance 2.5 with (`/ai/video?model=seedance_2_5`). The CLI checks each id
 * against the live catalog, so a wrong one fails by name instead of by 404. Anything
 * else the catalog offers (`higgsfield model list --video`) can still be reached through
 * the Custom entry, which sends whatever model id Settings stores.
 */
export const RENDER_MODELS: RenderModel[] = [
  { id: 'seedance-2.5', label: 'Seedance 2.5', job: 'seedance_2_5' },
  { id: 'seedance-2.0', label: 'Seedance 2.0', job: 'seedance_2_0' },
  { id: 'seedance-1.5-pro', label: 'Seedance 1.5 Pro', job: 'seedance1_5' },
  { id: 'kling-3.0', label: 'Kling v3.0', job: 'kling3_0' },
  { id: 'veo-3.1-lite', label: 'Veo 3.1 Lite', job: 'veo3_1_lite' },
];

/** What a render uses when the user never touches the selector. */
export const DEFAULT_MODEL_ID = 'seedance-2.5';

/** The selector entry that sends the model id typed into Settings instead of a known model. */
export const CUSTOM_MODEL_ID = 'custom';

/**
 * The CLI job id a model choice resolves to at render time. `custom` reads the model id
 * Settings stores; an unknown id falls back to the default model rather than sending
 * nothing, so a stale stored choice can never produce a model-less request.
 */
export function modelJob(modelId: string, customModel?: string): string {
  if (modelId === CUSTOM_MODEL_ID) {
    const typed = customModel?.trim();
    if (typed) return typed;
  }
  const model = RENDER_MODELS.find((m) => m.id === modelId);
  const fallback = RENDER_MODELS.find((m) => m.id === DEFAULT_MODEL_ID) ?? RENDER_MODELS[0];
  return (model ?? fallback).job;
}

/** The human name for a model choice, for cards that show what is rendering. */
export function modelLabel(modelId: string): string {
  if (modelId === CUSTOM_MODEL_ID) return 'Custom model';
  return RENDER_MODELS.find((m) => m.id === modelId)?.label ?? modelId;
}

/** One model the compose panel offers, with the limits its own CLI schema publishes. */
export interface ImageModel {
  /** Stable id — what the store holds and a generation records. */
  id: string;
  label: string;
  /** The CLI job type, e.g. `nano_banana_2`. */
  job: string;
  /**
   * The aspect ratios this model accepts. Per model rather than one shared list,
   * because the sets genuinely differ and sending a value a model does not publish
   * fails the whole generation.
   */
  aspects: string[];
  /** How many of the user's own photos it takes as references. */
  maxReferences: number;
}

/**
 * The image models the compose panel offers, in menu order.
 *
 * Every entry's contract is the same: a prompt, and any number of the user's own photos
 * to work on top of — so the panel means the same thing whichever is chosen. The flags,
 * the reference caps and the aspect sets are the CLI's own, from its `MODELS.md`; the
 * CLI checks each id against the live catalog, so a model a plan does not carry fails by
 * name rather than silently.
 */
export const IMAGE_MODELS: ImageModel[] = [
  {
    id: 'nano-banana-pro',
    label: 'Nano Banana Pro',
    job: 'nano_banana_2',
    aspects: ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '9:16', '16:9', '21:9'],
    maxReferences: 14,
  },
  {
    id: 'seedream-4.5',
    label: 'Seedream 4.5',
    job: 'seedream_v4_5',
    aspects: ['1:1', '4:3', '16:9', '3:2', '21:9', '3:4', '9:16', '2:3'],
    maxReferences: 14,
  },
  {
    id: 'flux-2',
    label: 'FLUX.2',
    job: 'flux_2',
    aspects: ['1:1', '4:3', '3:4', '16:9', '9:16'],
    maxReferences: 14,
  },
  {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    job: 'gpt_image_2',
    aspects: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
    maxReferences: 14,
  },
];

/** What a photo is generated with when the panel's selector is never touched. */
export const DEFAULT_IMAGE_MODEL_ID = 'nano-banana-pro';

/**
 * The frame the editor exports at, so a generated photo drops onto the timeline without
 * bars down the sides. Every offered model accepts it.
 */
export const DEFAULT_IMAGE_ASPECT = '16:9';

/** The order ratios are offered in, so the menu reads the same whichever model is on. */
const ASPECT_ORDER = ['16:9', '1:1', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'];

function imageModel(modelId: string): ImageModel {
  return IMAGE_MODELS.find((m) => m.id === modelId) ?? IMAGE_MODELS[0];
}

/** The CLI job id an image model choice resolves to at generation time. */
export function imageModelJob(modelId: string): string {
  return imageModel(modelId).job;
}

/**
 * A known image model id, falling back to the default — so a choice recorded by an older
 * build can never make a request carry a model the CLI has never heard of.
 */
export function imageModelId(modelId: string): string {
  return imageModel(modelId).id;
}

/** The human name for an image model choice. */
export function imageModelLabel(modelId: string): string {
  return imageModel(modelId).label;
}

/** How many references the chosen model will take. */
export function imageReferenceLimit(modelId: string): number {
  return imageModel(modelId).maxReferences;
}

/** The ratios the chosen model accepts, in the menu's own order. */
export function imageAspects(modelId: string): string[] {
  const accepted = imageModel(modelId).aspects;
  return ASPECT_ORDER.filter((a) => accepted.includes(a));
}

/**
 * The aspect a request actually carries: the pick when the chosen model accepts it, and
 * otherwise the default — so switching models can never send a ratio the new one refuses.
 */
export function imageAspectFor(modelId: string, aspect: string): string {
  const accepted = imageAspects(modelId);
  if (accepted.includes(aspect)) return aspect;
  return accepted.includes(DEFAULT_IMAGE_ASPECT) ? DEFAULT_IMAGE_ASPECT : accepted[0];
}

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
    return { configured: false, cliPath: null, customModel: '', hasApiKey: false, apiKeyIdHint: '' };
  }
  return invoke<SettingsView>('get_settings');
}

export async function saveSettings(input: SettingsInput): Promise<SettingsView> {
  requireDesktop();
  return invoke<SettingsView>('save_settings', { input });
}

/**
 * The project the editor was last holding, or `null` when there is none.
 *
 * Untyped on purpose in both directions: what a project *is* lives in `lib/project.ts`,
 * and the Rust side only moves the bytes. A plain browser has nowhere to keep one, so it
 * simply has no project — the same silent answer `cancelGeneration` gives, because this is
 * not a user action to refuse loudly at.
 */
export async function loadProject(): Promise<unknown> {
  if (!isDesktop()) return null;
  return invoke<unknown>('load_project');
}

export async function saveProject(project: unknown): Promise<void> {
  if (!isDesktop()) return;
  await invoke('save_project', { project });
}

/**
 * Prove the CLI connection: one free, read-only CLI call that checks the binary, the
 * login and the billing workspace, and reports the CLI's own fix when one is missing.
 */
export async function testConnection(): Promise<string> {
  requireDesktop();
  return invoke<string>('test_connection');
}

/**
 * Prove the stored Cloud API key — a different credential from the CLI's, on a different
 * host, against a different balance. One free, read-only call that generates nothing.
 *
 * The input is what the dialog is showing; blank fields fall back to what is stored, so a
 * key can be proved before it is saved.
 */
export async function testApiKey(input: SettingsInput): Promise<KeyCheck> {
  requireDesktop();
  return invoke<KeyCheck>('test_api_key', { input });
}

export async function importPaths(paths: string[]): Promise<ImportResult> {
  requireDesktop();
  return invoke<ImportResult>('import_media', { paths });
}

export async function generateAnimation(input: GenerateInput): Promise<void> {
  requireDesktop();
  await invoke('generate_animation', { input });
}

/**
 * Start one image generation. Answers as soon as the CLI has the job; everything after
 * that arrives on the same `generation:update` events a transition uses.
 */
export async function generateImage(input: GenerateImageInput): Promise<void> {
  requireDesktop();
  await invoke('generate_image', { input });
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
