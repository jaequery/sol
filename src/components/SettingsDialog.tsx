import { useState } from 'react';
import { CLI_INSTALL, CLI_LOGIN, CLI_WORKSPACE } from '../lib/backend';
import { useEditor } from '../state/store';

/**
 * The Higgsfield connection dialog.
 *
 * Authentication belongs to the Higgsfield CLI (`higgsfield auth login`), billed to the
 * account's subscription workspace — the app holds no credential at all. So this dialog
 * is small: it says whether the CLI was found, shows the three setup commands only while
 * it is missing, proves the connection on demand, and stores the one thing the app still
 * keeps — a custom model id for the Model picker's escape-hatch entry.
 *
 * The form mounts fresh every time the dialog opens, so its field is seeded from the
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

  const [customModel, setCustomModel] = useState(settings?.customModel ?? '');

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Higgsfield connection">
      <div className="modal">
        <div className="modal__head">✦ Higgsfield connection</div>
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

          <div className="field">
            <label htmlFor="custom-model">Custom model</label>
            <input
              id="custom-model"
              autoComplete="off"
              autoFocus
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
              <b>{message.ok ? 'Connection OK' : 'Could not connect'}</b>
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
          <button type="button" className="btn btn--primary" onClick={() => void save({ customModel })}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
