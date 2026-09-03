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

/** One coding-agent CLI as this machine has it. */
export interface AgentStatus {
  /** The id that travels with a request — `claude-code`, `codex`. */
  id: string;
  label: string;
  /** Where the binary was found; null when it was not. */
  path: string | null;
  /** Quoted verbatim when it is missing, so the fix can be pasted. */
  install: string;
  login: string;
}

export interface SettingsView {
  /**
   * The Higgsfield CLI binary was found — a *Higgsfield* generation can at least be
   * attempted.
   *
   * Deliberately says nothing about the API key: renders go through the CLI, so a stored
   * key must never make the app offer a generation it cannot run. And deliberately nothing
   * about `agents` either — a machine with a coding-agent CLI and no Higgsfield can still
   * composite transitions, and reading this as "generation is possible" is what used to gate
   * that off. Ask `renderReady` instead of this.
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
  /** Which coding-agent CLIs the backend found. Absent from a build that predates them. */
  agents: AgentStatus[];
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
  /**
   * The Higgsfield CLI model id chosen for THIS render — the selector's pick, resolved.
   * Absent for the local backends, which have no job id to send.
   */
  model?: string;
  /** Which backend renders it. See {@link providerOf}. */
  provider: Provider;
  /**
   * How long the stretch of timeline this transition will occupy currently runs. Only the
   * local backends use it, and only to choose a length.
   */
  spanMs?: number;
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

/**
 * One "make me a video out of these words" request from the media bin's create sheet.
 *
 * The thinnest of the three generation requests: no frames (a transition's two stills),
 * no references and no aspect ratio (a photo's). Text-to-video means the model invents the
 * whole shot, so the prompt and the model are the entire request.
 *
 * No `provider` either. The local backends composite an ffmpeg `xfade` between two stills
 * the editor supplies; with no stills there is nothing for them to composite, so
 * Higgsfield is the only thing that could serve this and offering a choice would imply
 * otherwise.
 */
export interface GenerateVideoInput {
  generationId: string;
  prompt: string;
  /** The CLI video job type chosen for THIS request. */
  model: string;
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

/** One entry in a model menu: what the store holds, and what a human reads. */
export interface ModelChoice {
  id: string;
  label: string;
}

/**
 * The models the create sheet offers for a **prompt-only video**.
 *
 * The same Higgsfield video models a transition can be rendered with — reusing that list
 * rather than declaring a second one is what keeps this feature from inventing model ids
 * the CLI has never heard of.
 *
 * Two things are deliberately absent. The **local backends**, because they composite
 * between two supplied stills and cannot make a shot from words, so a menu entry for them
 * would be one that always fails. And any **image** model, because those return a photo.
 *
 * `Custom` appears on the same terms it does in the transition picker: only when Settings
 * holds a model id that is not already listed, so the escape hatch for a job type the live
 * catalog offers stays reachable without a new build.
 */
export function videoModelChoices(customModel?: string, selectedId?: string): ModelChoice[] {
  const choices: ModelChoice[] = RENDER_MODELS.map((m) => ({ id: m.id, label: m.label }));
  const custom = (customModel ?? '').trim();
  const customIsItsOwn = custom !== '' && RENDER_MODELS.every((m) => m.job !== custom);
  // Kept while selected even if Settings has since matched a listed model, so the control
  // never shows an empty value — the same rule the transition picker follows.
  if (customIsItsOwn || selectedId === CUSTOM_MODEL_ID) {
    choices.push({ id: CUSTOM_MODEL_ID, label: `Custom — ${custom || 'Settings model'}` });
  }
  return choices;
}

/** Who renders a transition: Higgsfield, or one of the local agent-CLI backends. */
export type Provider = 'higgsfield' | 'claude-code' | 'codex';

/**
 * One local backend the same selector offers, below the Higgsfield group.
 *
 * These are **composited, not generated**. Neither the Claude Code CLI nor the Codex CLI has
 * an image or video model behind it; what they do is read the user's prose and choose the
 * motion, and ffmpeg makes the frames. That is a real transition between the two stills and
 * it costs about two cents instead of a plan credit — but it is a different thing from a
 * diffusion render, and the group heading says so rather than letting the menu imply
 * otherwise.
 */
export interface AgentBackend {
  /** The selector's id, the store's value, and what travels as `provider`. */
  id: Provider;
  label: string;
}

export const AGENT_BACKENDS: AgentBackend[] = [
  { id: 'claude-code', label: 'Claude Code CLI' },
  { id: 'codex', label: 'Codex CLI' },
];

/** The heading the local backends sit under, which is also the honest description of them. */
export const AGENT_GROUP_LABEL = 'Local motion — composited, not generated';

/** Who would render this choice. Anything not a local backend is Higgsfield's. */
export function providerOf(modelId: string): Provider {
  return AGENT_BACKENDS.find((b) => b.id === modelId)?.id ?? 'higgsfield';
}

/**
 * The CLI job id a model choice resolves to at render time. `custom` reads the model id
 * Settings stores; an unknown id falls back to the default model rather than sending
 * nothing, so a stale stored choice can never produce a model-less request.
 *
 * A **local** backend's id throws instead of falling back, and that is the whole point of
 * the guard. Every unknown id resolving to `seedance_2_5` is a good fail-safe while every
 * id is Higgsfield's; the moment one is not, the same line silently starts a paid render for
 * a cut the user asked to be composited locally, and the only evidence is the bill. Callers
 * ask `providerOf` first; this throws so that a caller which forgot cannot fail quietly.
 */
export function modelJob(modelId: string, customModel?: string): string {
  if (providerOf(modelId) !== 'higgsfield') {
    throw new Error(`${modelId} renders locally and has no Higgsfield job id`);
  }
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
  return (
    AGENT_BACKENDS.find((b) => b.id === modelId)?.label ??
    RENDER_MODELS.find((m) => m.id === modelId)?.label ??
    modelId
  );
}

/** The backend's status as this machine has it, or null when the choice is Higgsfield's. */
export function agentStatus(modelId: string, settings: SettingsView | null): AgentStatus | null {
  const provider = providerOf(modelId);
  if (provider === 'higgsfield') return null;
  return settings?.agents?.find((a) => a.id === provider) ?? null;
}

/**
 * Whether a render can be started at all with this choice.
 *
 * The question `settings.configured` used to be asked for, and the reason it could not stay:
 * that flag means "a binary named `higgsfield` is on disk", so on a machine with the Claude
 * Code CLI and no Higgsfield it gated off a backend that works perfectly.
 *
 * `ffmpegAvailable` is `null` until the probe lands and is treated as "not yet known", not
 * as absent — refusing during the first moments after launch would flicker the button. Only
 * a probe that came back `false` refuses, and it only refuses the local backends: ffmpeg is
 * what composites them, while Higgsfield returns a finished MP4 and needs it for nothing
 * unless a video is on one side of the cut.
 */
export function renderReady(
  modelId: string,
  settings: SettingsView | null,
  ffmpegAvailable: boolean | null,
): boolean {
  if (providerOf(modelId) === 'higgsfield') return Boolean(settings?.configured);
  if (ffmpegAvailable === false) return false;
  return Boolean(agentStatus(modelId, settings)?.path);
}

/** What to tell someone whose choice cannot render yet, or null when it can. */
export interface ReadinessHint {
  title: string;
  detail: string;
  /** A command to paste, when there is one. */
  command?: string;
  /** Whether Settings is where this gets fixed — only Higgsfield has anything to set. */
  opensSettings: boolean;
}

export function readinessHint(
  modelId: string,
  settings: SettingsView | null,
  ffmpegAvailable: boolean | null,
): ReadinessHint | null {
  if (renderReady(modelId, settings, ffmpegAvailable)) return null;

  if (providerOf(modelId) === 'higgsfield') {
    return {
      title: 'Connect Higgsfield to generate',
      detail: 'The Higgsfield CLI was not found. Nothing has been sent.',
      opensSettings: true,
    };
  }

  const status = agentStatus(modelId, settings);
  const label = status?.label ?? modelLabel(modelId);
  if (ffmpegAvailable === false) {
    return {
      title: 'ffmpeg is needed to composite',
      detail: `${label} chooses the motion, but ffmpeg makes the frames — install it and put it on your PATH.`,
      opensSettings: false,
    };
  }
  return {
    title: `Install ${label} to composite`,
    detail: 'It was not found on this machine. Nothing has been sent.',
    command: status?.install,
    opensSettings: false,
  };
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
    return {
      configured: false,
      cliPath: null,
      customModel: '',
      hasApiKey: false,
      apiKeyIdHint: '',
      agents: [],
    };
  }
  return invoke<SettingsView>('get_settings');
}

export async function saveSettings(input: SettingsInput): Promise<SettingsView> {
  requireDesktop();
  return invoke<SettingsView>('save_settings', { input });
}

/**
 * The untitled scratch project, or `null` when there is none.
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

/**
 * The project stored at `path`, or a throw naming why it could not be read.
 *
 * The counterpart to `loadProject`, and loud where that one is silent: this is a file the
 * user pointed at, so "there is nothing there" is an answer they have to be given rather
 * than an empty editor aimed at their project.
 */
export async function readProject(path: string): Promise<unknown> {
  requireDesktop();
  return invoke<unknown>('read_project', { path });
}

/**
 * The project the last write went to, or `null` for the untitled scratch.
 *
 * Guarded like `loadProject` rather than `readProject`: this runs at every launch,
 * including in a browser, where the answer is simply that there is no project to reopen.
 */
export async function lastProjectPath(): Promise<string | null> {
  if (!isDesktop()) return null;
  return invoke<string | null>('last_project_path');
}

/** Store the project — at `path`, or in the untitled scratch when there is none. */
export async function saveProject(project: unknown, path: string | null = null): Promise<void> {
  if (!isDesktop()) return;
  await invoke('save_project', { project, path });
}

/**
 * The projects to offer in the title bar's menu, newest first.
 *
 * Guarded like `loadProject`: a browser has no list, and an empty menu is the honest answer
 * rather than something to refuse over. Entries whose file has gone are already dropped on
 * the Rust side, so what comes back is what can actually be opened.
 */
export async function recentProjects(): Promise<string[]> {
  if (!isDesktop()) return [];
  return invoke<string[]>('recent_projects');
}

/**
 * Where a project called `name` would be created, or a throw saying why it cannot be.
 *
 * `near` is the open project, so a new one lands in the folder the last one is organised
 * in. The extension, the refusal of a name that is really a path, and the choice of folder
 * all live on the Rust side — `PathBuf` owns separators there, and a regex would own them
 * badly here.
 */
export async function newProjectPath(name: string, near: string | null): Promise<string> {
  requireDesktop();
  return invoke<string>('new_project_path', { name, near });
}

/**
 * Create a project at `path`, which must not already exist.
 *
 * Deliberately not `saveProject`: that one replaces whatever is there, which is what
 * autosave needs and precisely what creating must never do.
 */
export async function createProject(project: unknown, path: string): Promise<void> {
  requireDesktop();
  await invoke('create_project', { project, path });
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

/**
 * Start one prompt-only video generation. Answers as soon as the CLI has the job;
 * everything after that arrives on the same `generation:update` events the other two use.
 */
export async function generateVideo(input: GenerateVideoInput): Promise<void> {
  requireDesktop();
  await invoke('generate_video', { input });
}

/**
 * One frame out of a video on disk, as a JPEG data URL — the anchor a video side of a
 * transition is animated from, or to.
 *
 * A photo is already a still and is drawn straight in the webview (`lib/frames`); a video
 * is not, and its frame is pulled with the same ffmpeg the export uses, so the anchor and
 * the footage that lands beside it agree on rotation and pixel aspect. That does mean a
 * transition *involving video* needs ffmpeg on `PATH` — photo-to-photo ones still need
 * nothing but the CLI, and the failure names itself when it is missing.
 */
export async function captureVideoFrame(path: string, atMs: number): Promise<string> {
  requireDesktop();
  return invoke<string>('capture_video_frame', { path, atMs: Math.max(0, Math.round(atMs)) });
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

/**
 * The window is closing: `cb` is awaited, and only then does it actually go.
 *
 * Three things about this are not obvious, and getting any of them wrong is worse than not
 * having it at all.
 *
 * **It cannot use the bare `listen` above.** Tauri only delivers `tauri://close-requested`
 * to a *window-scoped* listener, and only auto-prevents the native close when it finds one
 * — an `Any`-target listener would fail silently in both directions, so the callback would
 * never run and the window would close anyway.
 *
 * **Nothing here calls `preventDefault`.** `onCloseRequested` awaits the handler and then
 * calls `destroy()` itself; preventing the default is how you keep a window *open*, which
 * is not what a flush wants. That also means the handler must never reject — the `destroy`
 * is downstream of it, so a thrown error leaves an app the user cannot quit. Hence the
 * catch: a last write that failed is not a reason to trap somebody in the editor.
 *
 * **`destroy` needs `core:window:allow-destroy`** in `src-tauri/capabilities/default.json`.
 * It is not in `core:window`'s default permission set, and without it the IPC call is
 * refused after the close has already been prevented — the same unquittable window.
 */
export async function onWindowClose(cb: () => void | Promise<void>): Promise<() => void> {
  if (!isDesktop()) return () => {};
  // Imported lazily, like the plugin modules below: `getCurrentWindow` reads
  // `__TAURI_INTERNALS__` metadata and throws outside a real webview, so it must stay off
  // the browser and jsdom module graphs entirely.
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow().onCloseRequested(async () => {
    try {
      await cb();
    } catch {
      // Deliberately swallowed. See above: a rejection here is an app that will not close.
    }
  });
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

/** The extension a project file is expected to carry. */
export const PROJECT_EXT = 'solcut';

/**
 * Where to save a project, or `null` if the picker was dismissed.
 *
 * The extension is forced on rather than suggested: the panel does not append one on every
 * platform, and a project saved as `beach` or `beach.v2` would then be hidden by the very
 * filter `pickProjectFile` opens with — a file the user cannot find again.
 */
export async function pickProjectSavePath(defaultName: string): Promise<string | null> {
  requireDesktop();
  const { save } = await import('@tauri-apps/plugin-dialog');
  const picked = await save({
    defaultPath: `${defaultName}.${PROJECT_EXT}`,
    filters: [{ name: 'SolCut project', extensions: [PROJECT_EXT] }],
  });
  if (!picked) return null;
  return picked.toLowerCase().endsWith(`.${PROJECT_EXT}`) ? picked : `${picked}.${PROJECT_EXT}`;
}

/** Which project to open, or `null` if the picker was dismissed. */
export async function pickProjectFile(): Promise<string | null> {
  requireDesktop();
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    multiple: false,
    filters: [{ name: 'SolCut project', extensions: [PROJECT_EXT] }],
  });
  return typeof picked === 'string' ? picked : null;
}

export async function revealPath(path: string): Promise<void> {
  if (!isDesktop()) return;
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
}
