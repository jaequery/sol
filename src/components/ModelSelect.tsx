/**
 * The per-render model picker.
 *
 * One control, present at every place a render can be started — the cut card, the
 * transition card's Regenerate, the film wizard. They all read and write the same
 * selection: the model is a per-render choice (whatever the selector shows when the
 * button is pressed is what that render uses), not a saved setting, so a fresh session
 * is back on the default — Seedance 2.5.
 *
 * A Custom entry appears only when Settings stores an endpoint that is not already in
 * the list: that endpoint exists precisely so an undocumented model or an API revision
 * can be pointed at without a new build, and a selector that could not reach it would
 * quietly retire the escape hatch.
 */

import { CUSTOM_MODEL_ID, RENDER_MODELS } from '../lib/backend';
import { useEditor } from '../state/store';

export function ModelSelect({ id }: { id: string }) {
  const modelId = useEditor((s) => s.modelId);
  const setModel = useEditor((s) => s.setModel);
  const settings = useEditor((s) => s.settings);

  const custom = (settings?.endpoint ?? '').trim();
  const customIsItsOwn = custom !== '' && RENDER_MODELS.every((m) => m.endpoint !== custom);

  return (
    <div className="field">
      <label htmlFor={id}>Model</label>
      <select id={id} value={modelId} onChange={(e) => setModel(e.target.value)}>
        {RENDER_MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        {/* Kept while selected even if Settings has since matched a listed model, so the
            control never shows an empty value; it resolves to the same endpoint anyway. */}
        {(customIsItsOwn || modelId === CUSTOM_MODEL_ID) && (
          <option value={CUSTOM_MODEL_ID}>Custom — {custom || 'Settings endpoint'}</option>
        )}
      </select>
    </div>
  );
}
