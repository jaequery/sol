import { useEditor } from '../state/store';
import { truncateName } from '../lib/timeline';

/** The imported media, its loading skeletons, and anything that failed to import. */
export function MediaBin() {
  const assets = useEditor((s) => s.assets);
  const clips = useEditor((s) => s.clips);
  const importing = useEditor((s) => s.importing);
  const problems = useEditor((s) => s.importProblems);
  const dismiss = useEditor((s) => s.dismissImportProblems);
  const importViaDialog = useEditor((s) => s.importViaDialog);
  const removeAsset = useEditor((s) => s.removeAsset);

  const list = Object.values(assets);
  const empty = list.length === 0 && importing === 0;

  return (
    <div className="col">
      <div className="panel-head">
        Media <span className="right">{list.length || ''}</span>
        {/* Importing is not a first-run-only affordance: it stays here however full the bin is. */}
        <button
          type="button"
          className="panel-head__action"
          aria-label="Import media"
          onClick={() => void importViaDialog()}
        >
          + Import
        </button>
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

        {list.map((asset) => {
          const onTimeline = clips.filter((c) => c.assetId === asset.id).length;
          return (
            <div key={asset.id} className="bin__tile" title={asset.name}>
              {asset.kind === 'photo' ? (
                <img src={asset.src} alt="" draggable={false} />
              ) : (
                <video src={asset.src} muted preload="metadata" />
              )}
              <span className="kind" aria-hidden="true">
                {asset.kind === 'photo' ? '▣' : '▶'}
              </span>
              <button
                type="button"
                className="bin__remove"
                aria-label={`Remove ${asset.name}`}
                title={
                  onTimeline > 0
                    ? `Remove ${asset.name} and its ${onTimeline} ${onTimeline === 1 ? 'clip' : 'clips'} on the timeline`
                    : `Remove ${asset.name}`
                }
                onClick={() => removeAsset(asset.id)}
              >
                ✕
              </button>
              <span className="label">{truncateName(asset.name, 22)}</span>
            </div>
          );
        })}

        {Array.from({ length: importing }, (_, i) => (
          <div key={`skeleton-${i}`} className="bin__skeleton" aria-label="Importing" />
        ))}
      </div>
    </div>
  );
}
