/**
 * The model registry's resolution rules. Pure functions — the store trusts them to always
 * hand back a sendable CLI model id, so the edges are pinned here rather than found in a
 * failed render.
 */

import { describe, expect, it } from 'vitest';
import capability from '../../src-tauri/capabilities/default.json';
import {
  AGENT_BACKENDS,
  CUSTOM_MODEL_ID,
  DEFAULT_MODEL_ID,
  modelJob,
  modelLabel,
  providerOf,
  readinessHint,
  renderReady,
  RENDER_MODELS,
  type AgentStatus,
  type SettingsView,
} from './backend';

describe('the render-model registry', () => {
  it('defaults to Seedance 2.5 under the id the platform itself uses', () => {
    expect(DEFAULT_MODEL_ID).toBe('seedance-2.5');
    expect(modelJob(DEFAULT_MODEL_ID)).toBe('seedance_2_5');
    expect(modelLabel(DEFAULT_MODEL_ID)).toBe('Seedance 2.5');
  });

  /**
   * The regression behind "API returned HTTP 404: model_not_found" on every default
   * render: the app once addressed models as guessed REST routes. Everything the
   * selector offers is now a CLI job id the live catalog validates by name — never a
   * URL path.
   */
  it('offers CLI job ids, never endpoint paths', () => {
    for (const model of RENDER_MODELS) {
      expect(model.job).not.toContain('/');
    }
  });

  it('every listed model resolves to its own job id', () => {
    for (const model of RENDER_MODELS) {
      expect(modelJob(model.id)).toBe(model.job);
    }
  });

  it('the custom entry sends the model id Settings stores', () => {
    expect(modelJob(CUSTOM_MODEL_ID, 'wan2_7')).toBe('wan2_7');
    expect(modelJob(CUSTOM_MODEL_ID, '  seedance_2_0_mini  ')).toBe('seedance_2_0_mini');
    expect(modelLabel(CUSTOM_MODEL_ID)).toBe('Custom model');
  });

  it('custom with nothing stored falls back to the default rather than sending nothing', () => {
    for (const blank of [undefined, '', '   ']) {
      expect(modelJob(CUSTOM_MODEL_ID, blank)).toBe(modelJob(DEFAULT_MODEL_ID));
    }
  });

  it('an id the registry no longer knows falls back to the default', () => {
    expect(modelJob('retired-model')).toBe(modelJob(DEFAULT_MODEL_ID));
    expect(modelLabel('retired-model')).toBe('retired-model');
  });
});

describe('which backend a choice belongs to', () => {
  it('everything but a listed local backend is Higgsfield\u2019s', () => {
    for (const model of RENDER_MODELS) expect(providerOf(model.id)).toBe('higgsfield');
    expect(providerOf(CUSTOM_MODEL_ID)).toBe('higgsfield');
    expect(providerOf('retired-model')).toBe('higgsfield');
    for (const b of AGENT_BACKENDS) expect(providerOf(b.id)).toBe(b.id);
  });

  /**
   * The fail-open this closes, and the reason the fallback above cannot simply be reused:
   * `modelJob` resolves *any* unknown id to the default job, which is exactly right while
   * every id is Higgsfield's. The moment one is not, that same line turns a local pick into
   * a paid `seedance_2_5` render, and the only evidence is the bill. It throws instead, so
   * a caller that forgot to branch on the provider fails loudly rather than expensively.
   */
  it('a local backend has no job id, and never borrows Higgsfield\u2019s', () => {
    for (const b of AGENT_BACKENDS) {
      expect(() => modelJob(b.id)).toThrow(/no Higgsfield job id/);
      // Including with a model stored in Settings: the Custom entry is Higgsfield's escape
      // hatch, not a way to smuggle a paid job id onto a local render.
      expect(() => modelJob(b.id, 'wan2_7')).toThrow(/no Higgsfield job id/);
    }
  });

  it('a local backend still has a name for the card that shows what is rendering', () => {
    expect(modelLabel('claude-code')).toBe('Claude Code CLI');
    expect(modelLabel('codex')).toBe('Codex CLI');
  });
});

describe('whether a choice can render on this machine', () => {
  const agent = (path: string | null): AgentStatus => ({
    id: 'claude-code',
    label: 'the Claude Code CLI',
    path,
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude auth login',
  });
  const settings = (configured: boolean, agents: AgentStatus[]): SettingsView => ({
    configured,
    cliPath: configured ? '/usr/local/bin/higgsfield' : null,
    customModel: '',
    hasApiKey: false,
    apiKeyIdHint: '',
    agents,
  });

  it('asks after the chosen backend, not after Higgsfield', () => {
    // Both directions matter. A Higgsfield-only machine must not offer a local render, and —
    // the bug this replaced — a machine with only a coding-agent CLI must not be told it
    // cannot generate at all.
    const higgsfieldOnly = settings(true, [agent(null)]);
    expect(renderReady(DEFAULT_MODEL_ID, higgsfieldOnly, true)).toBe(true);
    expect(renderReady('claude-code', higgsfieldOnly, true)).toBe(false);

    const agentOnly = settings(false, [agent('/usr/local/bin/claude')]);
    expect(renderReady('claude-code', agentOnly, true)).toBe(true);
    expect(renderReady(DEFAULT_MODEL_ID, agentOnly, true)).toBe(false);
  });

  it('refuses a local render with no ffmpeg, but never a Higgsfield one', () => {
    // ffmpeg is what composites a local transition; Higgsfield hands back a finished MP4 and
    // needs it only when a video is on one side of the cut, which is checked elsewhere.
    const both = settings(true, [agent('/usr/local/bin/claude')]);
    expect(renderReady('claude-code', both, false)).toBe(false);
    expect(renderReady(DEFAULT_MODEL_ID, both, false)).toBe(true);
  });

  it('treats an unprobed ffmpeg as unknown rather than absent', () => {
    // `null` is the state during the first moments after launch. Reading it as "missing"
    // would flicker every Generate button off and then on again.
    const both = settings(true, [agent('/usr/local/bin/claude')]);
    expect(renderReady('claude-code', both, null)).toBe(true);
  });

  it('says what is missing, and quotes the command when there is one', () => {
    const agentOnly = settings(false, [agent('/usr/local/bin/claude')]);
    expect(readinessHint('claude-code', agentOnly, true)).toBeNull();

    const higgsfield = readinessHint(DEFAULT_MODEL_ID, agentOnly, true);
    expect(higgsfield).toMatchObject({
      title: 'Connect Higgsfield to generate',
      opensSettings: true,
    });
    expect(higgsfield?.command).toBeUndefined();

    // A local backend is installed, not connected — so there is nothing in Settings to open,
    // and the thing to show is the line you paste into a terminal.
    const missing = readinessHint('claude-code', settings(true, [agent(null)]), true);
    expect(missing).toMatchObject({ opensSettings: false });
    expect(missing?.command).toBe('npm install -g @anthropic-ai/claude-code');
    expect(missing?.title).toContain('the Claude Code CLI');

    const noFfmpeg = readinessHint('claude-code', settings(true, [agent('/bin/claude')]), false);
    expect(noFfmpeg?.title).toBe('ffmpeg is needed to composite');
  });

  it('a build that predates the local backends reports them as absent, not as a crash', () => {
    // `agents` arrives from the Rust side; a settings payload written before it existed has
    // no such field, and reading one must not throw in the middle of rendering a card.
    const legacy = { ...settings(true, []), agents: undefined } as unknown as SettingsView;
    expect(renderReady('claude-code', legacy, true)).toBe(false);
    expect(renderReady(DEFAULT_MODEL_ID, legacy, true)).toBe(true);
    expect(readinessHint('claude-code', legacy, true)?.opensSettings).toBe(false);
  });
});


/**
 * The one line of Tauri configuration that a broken build would announce by being
 * unquittable rather than by failing a check.
 *
 * `onWindowClose` subscribes to `tauri://close-requested`. Merely *having* that listener
 * makes Tauri prevent the native close and hand control to the frontend, and the API's own
 * wrapper then calls `destroy()` once the handler resolves. `destroy` is not in
 * `core:window`'s default permission set, so without this grant the close is prevented, the
 * destroy is refused by the ACL, and the window never shuts — with no error anywhere the
 * user can see. Nothing else in the test suite can reach that, because it lives in the
 * desktop shell; so it is asserted here as configuration.
 */
describe('the desktop shell’s permissions', () => {
  it('grants the window destroy that the close-flush depends on', () => {
    expect(capability.permissions).toContain('core:window:allow-destroy');
  });
});
