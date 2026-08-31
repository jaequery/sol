import { useState } from 'react';
import { DEFAULT_BASE_URL, DEFAULT_ENDPOINT, KNOWN_ENDPOINTS } from '../lib/backend';
import { useEditor } from '../state/store';

/**
 * The Higgsfield connection dialog.
 *
 * The gate is deliberately a separate component from the form: the form mounts fresh every
 * time the dialog opens, so its fields are seeded from the settings that are stored *now*
 * rather than from whatever had loaded when the app first rendered. Seeding once at app
 * mount meant a saved base URL or endpoint showed as the default and saving quietly wrote
 * that default back — pointing the app at a host the credential is not for.
 */
export function SettingsDialog() {
  const open = useEditor((s) => s.settingsOpen);
  if (!open) return null;
  return <ConnectionForm />;
}

function ConnectionForm() {
  const settings = useEditor((s) => s.settings);
  const message = useEditor((s) => s.connectionMessage);
  const close = useEditor((s) => s.closeSettings);
  const save = useEditor((s) => s.saveSettings);
  const test = useEditor((s) => s.testConnection);

  // The credential boxes always start empty; blank means "keep what is stored".
  const [apiKeyId, setApiKeyId] = useState('');
  const [apiKeySecret, setApiKeySecret] = useState('');
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? DEFAULT_BASE_URL);
  const [endpoint, setEndpoint] = useState(settings?.endpoint ?? DEFAULT_ENDPOINT);

  const input = { apiKeyId, apiKeySecret, baseUrl, endpoint };

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
              autoFocus
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
            <label htmlFor="endpoint">Custom model endpoint</label>
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
            the desktop backend in an owner-only file that never reaches this window. Pasting the
            whole <code>key_id:key_secret</code> string into the ID box works too — it is split
            back apart. <b>Test connection</b> authenticates with whatever is in these fields, so a
            key can be proved before it is saved. The model itself is picked where a render is
            started; the custom endpoint here is what that picker's <b>Custom</b> entry sends — a
            path from the API reference, so a new model can be pointed at without a new build.
          </p>
        </div>
        <div className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={() => void test(input)}>
            Test connection
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save(input)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
