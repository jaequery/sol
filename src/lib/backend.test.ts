/**
 * The model registry's resolution rules. Pure functions — the store trusts them to always
 * hand back a sendable CLI model id, so the edges are pinned here rather than found in a
 * failed render.
 */

import { describe, expect, it } from 'vitest';
import {
  CUSTOM_MODEL_ID,
  DEFAULT_MODEL_ID,
  modelJob,
  modelLabel,
  RENDER_MODELS,
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
