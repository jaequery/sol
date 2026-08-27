import { useEditor } from '../state/store';
import { truncateName } from '../lib/timeline';

/** The imported media, its loading skeletons, and anything that failed to import. */
export function MediaBin() {
  const assets = useEditor((s) => s.assets);
  const importing = useEditor((s) => s.importing);
  const problems = useEditor((s) => s.importProblems);
  const dismiss = useEditor((s) => s.dismissImportProblems);
  const importViaDialog = useEditor((s) => s.importViaDialog);

  const list = Object.values(assets);
  const empty = list.length === 0 && importing === 0;

  return (
    <div className="col">
      <div className="panel-head">
        Media <span className="right">{list.length || ''}</span>
      </div>
      <div className="bin">
        {problems.length > 0 && (
          <div className="bin__problem" role="alert">
            <b>
              Could not import {problems.length} {problems.length === 1 ? 'file' : 'files'}
            </b>
            {problems.map((p, i) => (
              <div key={`${p.name}-${i}`}>
                {p.name} — {p.reason}
              </div>
            ))}
            <button type="button" onClick={dismiss}>
              Dismiss
            </button>
          </div>
        )}

        {empty && problems.length === 0 && (
          <div className="bin__empty">
            <b>No media yet</b>
            Drop photos and videos anywhere, or{' '}
            <button
              type="button"
              onClick={importViaDialog}
              style={{ background: 'none', border: 0, padding: 0, textDecoration: 'underline', color: 'inherit' }}
            >
              import
            </button>
            .
          </div>
        )}

        {list.map((asset) => (
          <div key={asset.id} className="bin__tile" title={asset.name}>
            {asset.kind === 'photo' ? (
              <img src={asset.src} alt="" draggable={false} />
            ) : (
              <video src={asset.src} muted preload="metadata" />
            )}
            <span className="kind" aria-hidden="true">
              {asset.kind === 'photo' ? '▣' : '▶'}
            </span>
            <span className="label">{truncateName(asset.name, 22)}</span>
          </div>
        ))}

        {Array.from({ length: importing }, (_, i) => (
          <div key={`skeleton-${i}`} className="bin__skeleton" aria-label="Importing" />
        ))}
      </div>
    </div>
  );
}
