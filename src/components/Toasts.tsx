import { useEffect } from 'react';
import { revealPath } from '../lib/backend';
import { useEditor, type Toast } from '../state/store';
import { Icon } from './Icon';

/**
 * How long a good-news toast stays before leaving on its own. An error never does: it is
 * the only record of something the user has to act on, so it waits to be dismissed.
 */
const OK_TOAST_MS = 6000;

export function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  const dismiss = useEditor((s) => s.dismissToast);
  if (toasts.length === 0) return null;

  return (
    <div className="toasts">
      {/* A run of failures — Animate all over a reel — must not need one click each. */}
      {toasts.length > 1 && (
        <button
          type="button"
          className="toasts__clear"
          onClick={() => useEditor.setState({ toasts: [] })}
        >
          Clear all
        </button>
      )}
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  );
}

function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const error = toast.tone === 'error';

  useEffect(() => {
    if (error) return;
    const timer = setTimeout(onDismiss, OK_TOAST_MS);
    return () => clearTimeout(timer);
    // The dismiss callback is stable for a toast's lifetime; only its identity matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id, error]);

  return (
    // An error is announced at once; a confirmation waits its turn.
    <div className={`toast toast--${toast.tone}`} role={error ? 'alert' : 'status'}>
      <span className="toast__icon" aria-hidden="true">
        <Icon name={error ? 'alert' : 'check'} size={13} />
      </span>
      <div className="toast__text">
        <b>{toast.title}</b>
        {toast.detail && <span title={toast.detail}>{toast.detail}</span>}
      </div>
      {toast.action ? (
        <button
          type="button"
          onClick={() => {
            void revealPath(toast.action!.path);
            onDismiss();
          }}
        >
          {toast.action.label}
        </button>
      ) : (
        <button type="button" className="toast__dismiss" onClick={onDismiss} aria-label="Dismiss">
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}
