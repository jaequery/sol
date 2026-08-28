import { useState } from 'react';
import { DEFAULT_BASE_URL, DEFAULT_ENDPOINT, KNOWN_ENDPOINTS } from '../lib/backend';
import { useEditor } from '../state/store';

export function SettingsDialog() {
  const open = useEditor((s) => s.settingsOpen);
  const settings = useEditor((s) => s.settings);
  const message = useEditor((s) => s.connectionMessage);
  const close = useEditor((s) => s.closeSettings);
  const save = useEditor((s) => s.saveSettings);
  const test = useEditor((s) => s.testConnection);

  const [apiKeyId, setApiKeyId] = useState('');
  const [apiKeySecret, setApiKeySecret] = useState('');
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? DEFAULT_BASE_URL);
  const [endpoint, setEndpoint] = useState(settings?.endpoint ?? DEFAULT_ENDPOINT);

  if (!open) return null;

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Higgsfield connection">
      <div className="modal">
        <div className="modal__head">✦ Higgsfield connection</div>
        <div className="modal__body">
          <div className="field">
            <label htmlFor="api-key-id">API key ID</label>
            <input
              id="api-key-id"
              type="password"
              autoComplete="off"
              value={apiKeyId}
              placeholder={settings?.apiKeyIdHint || 'from cloud.higgsfield.ai'}
              onChange={(e) => setApiKeyId(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="api-key-secret">API key secret</label>
            <input
              id="api-key-secret"
              type="password"
              autoComplete="off"
              value={apiKeySecret}
              placeholder={settings?.hasSecret ? '•••• stored' : 'the other half of the key'}
              onChange={(e) => setApiKeySecret(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="base-url">Base URL</label>
            <input id="base-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="endpoint">Model endpoint</label>
            <input
              id="endpoint"
              list="higgsfield-endpoints"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
            <datalist id="higgsfield-endpoints">
              {KNOWN_ENDPOINTS.map((path) => (
                <option key={path} value={path} />
              ))}
            </datalist>
          </div>

          {message && (
            <div className={message.ok ? 'okbox' : 'errbox'} role="status">
              <b>{message.ok ? 'Connection OK' : 'Could not connect'}</b>
              {message.text}
            </div>
          )}

          <p className="hint" style={{ marginTop: 0 }}>
            A Higgsfield credential is an ID and a secret; both are needed, and both are stored by
            the desktop backend in an owner-only file that never reaches this window. The model
            endpoint picks which model renders the segment — it is the path from the API reference,
            so a new model can be pointed at without a new build.
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
            onClick={() => void save({ apiKeyId, apiKeySecret, baseUrl, endpoint })}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
