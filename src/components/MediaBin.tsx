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
  const draggingAssetId = useEditor((s) => s.draggingAssetId);
  const beginAssetDrag = useEditor((s) => s.beginAssetDrag);
  const placeAssetOnTimeline = useEditor((s) => s.placeAssetOnTimeline);
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
          // While the compose panel is open the bin is a reference picker, so the tile
          // stops being a drag source: adding to the timeline is not this screen's task,
          // and two meanings for one press is how a control becomes unpredictable.
          const composing = panel.open;
          const pickable = composing && referenceEligible(asset);
          const at = panel.referenceAssetIds.indexOf(asset.id);
          const draggable = !composing && !asset.missing;

          return (
            <div
              key={asset.id}
              className={`bin__tile${asset.missing ? ' bin__tile--missing' : ''}${draggingAssetId === asset.id ? ' bin__tile--dragging' : ''}${pickable ? ' bin__tile--pick' : ''}${at >= 0 ? ' bin__tile--picked' : ''}`}
              title={
                asset.missing
                  ? `${asset.name} — the file is no longer on disk${asset.path ? ` (${asset.path})` : ''}`
                  : composing
                    ? asset.name
                    : `${asset.name} · drag onto the timeline · Enter adds it at the playhead`
              }
              // A tile whose file is gone is not a source: a clip on it could only render as
              // "media offline" and would block the export. It keeps its ✕ and nothing else.
              // Focusable, but deliberately not `role="button"` — the role is in App's
              // INTERACTIVE list, which would take Delete and Backspace away from the
              // selection for as long as a tile held focus.
              tabIndex={draggable ? 0 : undefined}
              aria-label={draggable ? `Add ${asset.name} to the timeline` : undefined}
              onPointerDown={(e) => {
                // The timeline takes it from here — it is the half that knows where a drop
                // would land. A right-click must not arm a drag whose release never comes.
                if (e.button !== 0 || !draggable) return;
                beginAssetDrag(asset.id);
              }}
              onDoubleClick={() => draggable && placeAssetOnTimeline(asset.id)}
              onKeyDown={(e) => {
                // Enter alone. Space is play/pause everywhere in this app, and a media tile
                // is no place to take the transport key away from the user.
                if (e.key !== 'Enter' || !draggable) return;
                e.preventDefault();
                placeAssetOnTimeline(asset.id);
              }}
            >
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

              {/* The whole tile, as one real button — which is what makes `aria-pressed`
                  mean something, and keeps the tile itself the plain focusable div the
                  timeline drag needs it to be. */}
              {pickable && (
                <button
                  type="button"
                  className="bin__pick"
                  aria-pressed={at >= 0}
                  aria-label={`Use ${asset.name} as a reference`}
                  onClick={() => toggleImageReference(asset.id)}
                >
                  {at >= 0 && (
                    <span className="bin__pick-n" aria-hidden="true">
                      {at + 1}
                    </span>
                  )}
                </button>
              )}

              {/* Removing is not the composing screen's task, and the ✕ would sit under
                  the pick button anyway. */}
              {!composing && (
                <button
                  type="button"
                  className="bin__remove"
                  aria-label={`Remove ${asset.name}`}
                  title={
                    onTimeline > 0
                      ? `Remove ${asset.name} and its ${onTimeline} ${onTimeline === 1 ? 'clip' : 'clips'} on the timeline`
                      : `Remove ${asset.name}`
                  }
                  onPointerDown={(e) => e.stopPropagation()}
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
