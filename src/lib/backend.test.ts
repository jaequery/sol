/**
 * The model registry's resolution rules. Pure functions — the store trusts them to always
 * hand back a sendable endpoint, so the edges are pinned here rather than found in a 422.
 */

import { describe, expect, it } from 'vitest';
import {
  CUSTOM_MODEL_ID,
  DEFAULT_MODEL_ID,
  KNOWN_ENDPOINTS,
  modelEndpoint,
  modelLabel,
  RENDER_MODELS,
} from './backend';

describe('the render-model registry', () => {
  it('defaults to Seedance 2.5', () => {
    expect(DEFAULT_MODEL_ID).toBe('seedance-2.5');
    expect(modelEndpoint(DEFAULT_MODEL_ID)).toBe('/bytedance/seedance/v2.5/pro/image-to-video');
    expect(modelLabel(DEFAULT_MODEL_ID)).toBe('Seedance 2.5');
  });

  it('every listed model resolves to its own endpoint', () => {
    for (const model of RENDER_MODELS) {
      expect(modelEndpoint(model.id)).toBe(model.endpoint);
    }
  });

  it('the custom entry sends the endpoint Settings stores', () => {
    expect(modelEndpoint(CUSTOM_MODEL_ID, '/wan-25-preview/image-to-video')).toBe(
      '/wan-25-preview/image-to-video',
    );
    expect(modelEndpoint(CUSTOM_MODEL_ID, '  /reve/edit  ')).toBe('/reve/edit');
    expect(modelLabel(CUSTOM_MODEL_ID)).toBe('Custom endpoint');
  });

  it('custom with nothing stored falls back to the default rather than sending nothing', () => {
    for (const blank of [undefined, '', '   ']) {
      expect(modelEndpoint(CUSTOM_MODEL_ID, blank)).toBe(modelEndpoint(DEFAULT_MODEL_ID));
    }
  });

  it('an id the registry no longer knows falls back to the default', () => {
    expect(modelEndpoint('retired-model')).toBe(modelEndpoint(DEFAULT_MODEL_ID));
    expect(modelLabel('retired-model')).toBe('retired-model');
  });

  it('the Settings suggestions are exactly the pickable models', () => {
    expect(KNOWN_ENDPOINTS).toEqual(RENDER_MODELS.map((m) => m.endpoint));
  });
});
