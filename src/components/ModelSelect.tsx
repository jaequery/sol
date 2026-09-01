/**
 * The per-render model picker.
 *
 * One control, present at every place a render can be started — the cut card, the
 * transition card's Regenerate, the film wizard. They all read and write the same
 * selection: the model is a per-render choice (whatever the selector shows when the
 * button is pressed is what that render uses), not a saved setting, so a fresh session
 * is back on the default — Seedance 2.5.
 *
 * A Custom entry appears only when Settings stores a model id that is not already in
 * the list: that id exists precisely so any job type the CLI's live catalog offers can
 * be pointed at without a new build, and a selector that could not reach it would
 * quietly retire the escape hatch.
 *
 * The **backend** rides in this same control rather than in one of its own, and the choice
 * is deliberate twice over. It travels exactly as the model id already does — per render,
 * never persisted — so it needed no new state; and a second dropdown would sit on three
 * surfaces answering a question most users only ever answer once. The group heading is the
 * one piece of new copy, and it does the honest work the menu otherwise would not: these
 * backends composite a transition, they do not generate one.
 */

import { AGENT_BACKENDS, AGENT_GROUP_LABEL, CUSTOM_MODEL_ID, RENDER_MODELS } from '../lib/backend';
import { useEditor } from '../state/store';

export function ModelSelect({ id }: { id: string }) {
  const modelId = useEditor((s) => s.modelId);
  const setModel = useEditor((s) => s.setModel);
  const settings = useEditor((s) => s.settings);

  const custom = (settings?.customModel ?? '').trim();
  const customIsItsOwn = custom !== '' && RENDER_MODELS.every((m) => m.job !== custom);

  return (
    <div className="field">
      <label htmlFor={id}>Model</label>
      <select id={id} value={modelId} onChange={(e) => setModel(e.target.value)}>
        <optgroup label="Higgsfield">
          {RENDER_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {/* Kept while selected even if Settings has since matched a listed model, so the
              control never shows an empty value; it resolves to the same job id anyway. */}
          {(customIsItsOwn || modelId === CUSTOM_MODEL_ID) && (
            <option value={CUSTOM_MODEL_ID}>Custom — {custom || 'Settings model'}</option>
          )}
        </optgroup>
        {/* Listed whether or not the CLI is installed: a menu that hid what this machine
            lacks could never explain why, and the card below says which one is missing and
            how to get it. */}
        <optgroup label={AGENT_GROUP_LABEL}>
          {AGENT_BACKENDS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </optgroup>
      </select>
    </div>
  );
}
