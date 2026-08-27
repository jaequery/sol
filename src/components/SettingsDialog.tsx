import { useState } from 'react';
import { useEditor } from '../state/store';

export function SettingsDialog() {
  const open = useEditor((s) => s.settingsOpen);
  const settings = useEditor((s) => s.settings);
  const message = useEditor((s) => s.connectionMessage);
  const close = useEditor((s) => s.closeSettings);
  const save = useEditor((s) => s.saveSettings);
  const test = useEditor((s) => s.testConnection);

  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? '');
  const [model, setModel] = useState(settings?.model ?? '');
  const [endpoint, setEndpoint] = useState(settings?.endpoint ?? '');

  if (!open) return null;

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Higgsfield connection">
      <div className="modal">
        <div className="modal__head">✦ Higgsfield connection</div>
        <div className="modal__body">
          <div className="field">
            <label htmlFor="api-key">API key</label>
            <input
              id="api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={settings?.apiKeyHint || 'hf_…'}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="api-secret">API secret (optional)</label>
            <input
              id="api-secret"
              type="password"
              autoComplete="off"
              value={apiSecret}
              placeholder={settings?.hasSecret ? '•••• stored' : 'leave blank if unused'}
              onChange={(e) => setApiSecret(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="base-url">Base URL</label>
            <input id="base-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="endpoint">Endpoint path</label>
            <input id="endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="model">Model</label>
            <input id="model" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>

          {message && (
            <div className={message.ok ? 'okbox' : 'errbox'} role="status">
              <b>{message.ok ? 'Connection OK' : 'Could not connect'}</b>
              {message.text}
            </div>
          )}

          <p className="hint" style={{ marginTop: 0 }}>
            The key is stored by the desktop backend in an owner-only file and never reaches this
            window. Endpoint and model are editable so a change to the API can be pointed at without
            a new build.
          </p>
        </div>
        <div className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={() => void test()}>
            Test connection
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void save({ apiKey, apiSecret, baseUrl, model, endpoint })}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
