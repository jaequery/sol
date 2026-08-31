import { referenceEligible, useEditor } from '../state/store';
import { truncateName } from '../lib/timeline';
import { ImageCompose } from './ImageCompose';

const KIND_GLYPH = { photo: '▣', video: '▶', audio: '♪' } as const;

/** The imported media, its loading skeletons, and anything that failed to import. */
export function MediaBin() {
  const assets = useEditor((s) => s.assets);
  const clips = useEditor((s) => s.clips);
  const audioTracks = useEditor((s) => s.audioTracks);
  const importing = useEditor((s) => s.importing);
  const problems = useEditor((s) => s.importProblems);
  const dismiss = useEditor((s) => s.dismissImportProblems);
  const importViaDialog = useEditor((s) => s.importViaDialog);
  const removeAsset = useEditor((s) => s.removeAsset);
  const panel = useEditor((s) => s.imagePanel);
  const openImagePanel = useEditor((s) => s.openImagePanel);
  const toggleImageReference = useEditor((s) => s.toggleImageReference);
  const generations = useEditor((s) => s.generations);
  const cancelGeneration = useEditor((s) => s.cancelGeneration);
  const retryGeneration = useEditor((s) => s.retryGeneration);
  const dismissGeneration = useEditor((s) => s.dismissGeneration);

  const list = Object.values(assets);
  // Photo generations are the bin's own: they are shown here, where their result lands,
  // rather than in the inspector where a transition's progress belongs.
  const photoJobs = Object.values(generations).filter((g) => g.target.kind === 'image');
  const running = photoJobs.filter((g) => g.status === 'queued' || g.status === 'running');
  const failed = photoJobs.filter((g) => g.status === 'failed');
  const empty = list.length === 0 && importing === 0 && running.length === 0;

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
        {/* The other way media gets here. Its panel opens below, inside the bin, because
            the bin's own photos are what a generation works on top of. */}
        <button
          type="button"
          className="panel-head__action"
          aria-label="Generate an image"
          onClick={openImagePanel}
        >
          ✦ Generate
        </button>
      </div>
      <div className="bin">
        <ImageCompose />

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

        {failed.map((generation) => (
          <div key={generation.id} className="bin__problem" role="alert">
            <b>{generation.error?.title ?? 'The photo could not be generated'}</b>
            {generation.error?.message}
            <div className="bin__problem-actions">
              {generation.error?.retryable !== false && (
                <button
                  type="button"
                  aria-label={`Retry generating ${generation.prompt}`}
                  onClick={() => retryGeneration(generation.id)}
                >
                  Retry
                </button>
              )}
              <button
                type="button"
                aria-label={`Dismiss the failed photo ${generation.prompt}`}
                onClick={() => dismissGeneration(generation.id)}
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}

        {empty && problems.length === 0 && (
          <div className="bin__empty">
            <b>No media yet</b>
            Drop photos, videos and audio on the timeline, or{' '}
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
          const onTimeline =
            clips.filter((c) => c.assetId === asset.id).length +
            audioTracks.filter((t) => t.assetId === asset.id).length;
          const at = panel.referenceAssetIds.indexOf(asset.id);
          const pickable = panel.open && referenceEligible(asset);

          const face = (
            <>
              {asset.kind === 'photo' ? (
                <img src={asset.src} alt="" draggable={false} />
              ) : asset.kind === 'video' ? (
                <video src={asset.src} muted preload="metadata" />
              ) : (
                <div className="bin__audio" aria-hidden="true">
                  ♪
                </div>
              )}
              <span className="kind" aria-hidden="true">
                {KIND_GLYPH[asset.kind]}
              </span>
            </>
          );

          // While the panel is open the tile is a reference toggle, and its remove button
          // goes: removing is not this screen's task, and a button inside a button is not
          // something a screen reader or the DOM can make sense of.
          if (pickable) {
            return (
              <button
                key={asset.id}
                type="button"
                className={`bin__tile bin__tile--pick${at >= 0 ? ' bin__tile--picked' : ''}`}
                aria-pressed={at >= 0}
                aria-label={`Use ${asset.name} as a reference`}
                onClick={() => toggleImageReference(asset.id)}
              >
                {face}
                {at >= 0 && (
                  <span className="bin__pick-n" aria-hidden="true">
                    {at + 1}
                  </span>
                )}
                <span className="label">{truncateName(asset.name, 22)}</span>
              </button>
            );
          }

          return (
            <div
              key={asset.id}
              className={`bin__tile${asset.missing ? ' bin__tile--missing' : ''}`}
              title={
                asset.missing
                  ? `${asset.name} — the file is no longer on disk${asset.path ? ` (${asset.path})` : ''}`
                  : asset.name
              }
            >
              {face}
              {!panel.open && (
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
              )}
              <span className="label">{truncateName(asset.name, 22)}</span>
            </div>
          );
        })}

        {/* A photo on its way, in the same language an import already speaks. */}
        {running.map((generation) => (
          <div key={generation.id} className="bin__skeleton bin__skeleton--gen">
            <span className="bin__gen-mark" aria-label={`Generating ${generation.prompt}`}>
              ✦
            </span>
            <button
              type="button"
              className="bin__remove"
              aria-label={`Stop generating ${generation.prompt}`}
              onClick={() => void cancelGeneration(generation.id)}
            >
              ✕
            </button>
          </div>
        ))}

        {Array.from({ length: importing }, (_, i) => (
          <div key={`skeleton-${i}`} className="bin__skeleton" aria-label="Importing" />
        ))}
      </div>
    </div>
  );
}
