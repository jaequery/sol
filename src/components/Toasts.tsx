import { revealPath } from '../lib/backend';
import { useEditor } from '../state/store';

export function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  const dismiss = useEditor((s) => s.dismissToast);
  if (toasts.length === 0) return null;

  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`} role="status">
          <span className="toast__icon" aria-hidden="true">
            {toast.tone === 'ok' ? '✓' : '✕'}
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
                dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          ) : (
            <button type="button" onClick={() => dismiss(toast.id)}>
              Dismiss
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
