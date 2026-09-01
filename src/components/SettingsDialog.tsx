import { useState } from 'react';
import { CLI_INSTALL, CLI_LOGIN, CLI_WORKSPACE } from '../lib/backend';
import { useEditor } from '../state/store';

/**
 * The Settings dialog — the app's one settings surface, and where the Higgsfield
 * connection lives (entered from the title bar's Settings button, or any
 * "Connect Higgsfield" callout).
 *
 * It holds three things, and they are deliberately separate:
 *
 * 1. **The CLI**, which is what actually renders — found or not, proved by
 *    **Test connection**. Authentication is the CLI's own (`higgsfield auth login`),
 *    billed to the account's subscription workspace.
 * 2. **The API key** — the Cloud credential from `cloud.higgsfield.ai`. A different
 *    credential, a different host and a different balance: the CLI has no notion of an
 *    API key at all, so this one is *not* what generates. It is kept here so it can be
 *    set in one place and proved with **Test key**, which is why that control sits beside
 *    the fields rather than in the footer — a stale key must never make a machine with a
 *    working CLI report itself disconnected.
 * 3. **A custom model id** for the Model picker's escape-hatch entry.
 *
 * The form mounts fresh every time the dialog opens, so its fields are seeded from the
 * settings that are stored *now* rather than from whatever had loaded at first render.
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
  const testKey = useEditor((s) => s.testApiKey);

  // The credential boxes always start empty; blank means "keep what is stored", so the
  // secret never has to come back to this window to survive a save.
  const [apiKeyId, setApiKeyId] = useState('');
  const [apiKeySecret, setApiKeySecret] = useState('');
  // Blank-means-keep would otherwise make a stored key permanent. Forget is the way out,
  // and typing disarms it, so a forget and a new key can never both be in flight.
  const [forgetApiKey, setForgetApiKey] = useState(false);
  const [customModel, setCustomModel] = useState(settings?.customModel ?? '');
  // The check is a network round trip with a 30 s budget, so the button has to say it is
  // working — otherwise a slow answer is indistinguishable from a dead control.
  const [checking, setChecking] = useState(false);

  const stored = settings?.hasApiKey ?? false;
  const input = { apiKeyId, apiKeySecret, forgetApiKey, customModel };

  function typeKeyId(value: string) {
    setApiKeyId(value);
    setForgetApiKey(false);
  }
  function typeKeySecret(value: string) {
    setApiKeySecret(value);
    setForgetApiKey(false);
  }
  async function checkKey() {
    setChecking(true);
    try {
      await testKey(input);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="modal">
        <div className="modal__head">Settings</div>
        {/* The body's own hints name the CLI and the key, so the head stays a plain
            "Settings" with no second, redundant heading. */}
        <div className="modal__body">
          {settings?.configured ? (
            <p className="hint" style={{ marginTop: 0 }}>
              Higgsfield CLI found at <code>{settings.cliPath}</code>. Renders run through it
              and bill your higgsfield.ai subscription — <b>Test connection</b> proves the
              sign-in and workspace without generating anything.
            </p>
          ) : (
            <p className="hint" style={{ marginTop: 0 }}>
              Renders run through the official Higgsfield CLI, billed to your higgsfield.ai
              subscription — no CLI was found on this machine. In a terminal:
              <br />
              <code>{CLI_INSTALL}</code>
              <br />
              <code>{CLI_LOGIN}</code>
              <br />
              <code>{CLI_WORKSPACE}</code>
              <br />
              then reopen this dialog.
            </p>
          )}

          {/* Read-only, and no second Test button: these are picked per render in the Model
              selector, not connected here. What this answers is the one question Settings is
              the natural place for — what can this machine actually render with. */}
          <p className="hint">
            <b>Local motion.</b> A transition can also be composited here with ffmpeg, with a
            coding-agent CLI choosing the motion. Pick one in <b>Model</b> on any cut.
          </p>
          {(settings?.agents ?? []).map((agent) => (
            <p className="hint" key={agent.id}>
              {agent.path ? (
                <>
                  {agent.label} found at <code>{agent.path}</code>.
                </>
              ) : (
                <>
                  No {agent.label} on this machine — <code>{agent.install}</code>, then{' '}
                  <code>{agent.login}</code>.
                </>
              )}
            </p>
          ))}

          <div className="field">
            <label htmlFor="api-key-id">API key ID</label>
            <input
              id="api-key-id"
              type="password"
              autoComplete="off"
              autoFocus
              value={apiKeyId}
              placeholder={
                forgetApiKey ? '' : settings?.apiKeyIdHint || 'from cloud.higgsfield.ai'
              }
              onChange={(e) => typeKeyId(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="api-key-secret">API key secret</label>
            <input
              id="api-key-secret"
              type="password"
              autoComplete="off"
              value={apiKeySecret}
              placeholder={
                forgetApiKey || !stored ? 'the other half of the key' : '•••• stored'
              }
              onChange={(e) => typeKeySecret(e.target.value)}
            />
            <p className="hint" style={{ marginBottom: 0 }}>
              {forgetApiKey ? (
                <>The stored key is removed on <b>Save</b>. Type a new one to keep a key.</>
              ) : (
                <>
                  Optional, and separate from the CLI above — a Cloud credential from
                  cloud.higgsfield.ai, in two halves. It is <b>not</b> what renders, so it
                  is kept and proved here, nothing more. Both halves are held by the
                  desktop backend in an owner-only file that never reaches this window;
                  pasting the whole <code>key_id:key_secret</code> string into the ID box
                  works too.
                </>
              )}
            </p>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 7 }}>
              {stored && !forgetApiKey && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setApiKeyId('');
                    setApiKeySecret('');
                    setForgetApiKey(true);
                  }}
                >
                  Forget key
                </button>
              )}
              <button
                type="button"
                className="btn"
                disabled={checking}
                onClick={() => void checkKey()}
              >
                {checking ? 'Testing…' : 'Test key'}
              </button>
            </div>
          </div>

          <div className="field">
            <label htmlFor="custom-model">Custom model</label>
            <input
              id="custom-model"
              autoComplete="off"
              value={customModel}
              placeholder="a model id from `higgsfield model list --video`"
              onChange={(e) => setCustomModel(e.target.value)}
            />
            <p className="hint" style={{ marginBottom: 0 }}>
              Optional. Appears as the Model picker's <b>Custom</b> entry, so any model the
              CLI's catalog offers can be rendered with — without a new build. Blank hides
              the entry.
            </p>
          </div>

          {message && (
            <div className={message.ok ? 'okbox' : 'errbox'} role="status">
              <b>{message.title ?? (message.ok ? 'Connection OK' : 'Could not connect')}</b>
              {message.text}
            </div>
          )}
        </div>
        <div className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={() => void test()}>
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
