import { useEditor } from '../state/store';

/**
 * The one question a project switch ever asks.
 *
 * A project with a file is written to it and swapped without a word, and an empty editor
 * has nothing to lose — so this is only ever seen by an *untitled* project with work in it,
 * which is the one that has nowhere to be flushed to.
 *
 * There is no body text on purpose. The heading is the question, the three buttons are the
 * answers, and a paragraph restating them would be the only thing on screen that is
 * neither.
 */
export function SwitchProjectDialog() {
  const pending = useEditor((s) => s.pendingSwitch);
  const resolveSwitch = useEditor((s) => s.resolveSwitch);

  if (!pending) return null;

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Save this project first?">
      <div className="modal">
        <div className="modal__head">Save this project first?</div>
        <div className="modal__foot">
          <button
            type="button"
            className="btn btn--ghost"
            // Named past its own label, as the compose panel's close button is: a bare
            // "Cancel" is already the settings dialog's, and two of them make every
            // by-name query in the suite ambiguous for whoever writes the next test.
            aria-label="Cancel — keep this project open"
            disabled={pending.saving}
            onClick={() => void resolveSwitch('cancel')}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={pending.saving}
            onClick={() => void resolveSwitch('discard')}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn--primary"
            // The save panel is a native window over this one; the buttons behind it stand
            // down rather than letting a second one be opened underneath.
            disabled={pending.saving}
            onClick={() => void resolveSwitch('save')}
          >
            {pending.saving ? 'Saving…' : 'Save as…'}
          </button>
        </div>
      </div>
    </div>
  );
}
