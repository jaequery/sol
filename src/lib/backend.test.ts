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
  it('defaults to MiniMax Hailuo-02 Standard', () => {
    expect(DEFAULT_MODEL_ID).toBe('hailuo-02-standard');
    expect(modelEndpoint(DEFAULT_MODEL_ID)).toBe('/minimax/hailuo-02/standard/image-to-video');
    expect(modelLabel(DEFAULT_MODEL_ID)).toBe('MiniMax Hailuo-02 Standard');
  });

  /**
   * The regression behind "API returned HTTP 404: model_not_found" on every default
   * render: the menu led with a Seedance 2.5 route guessed from the API's naming
   * convention, and the published OpenAPI document has no such path. Everything the
   * selector offers must be a route the API actually serves.
   */
  it('offers no guessed routes', () => {
    for (const model of RENDER_MODELS) {
      expect(model.endpoint).not.toContain('seedance');
    }
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
