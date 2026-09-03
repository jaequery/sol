import { referenceEligible, useEditor } from '../state/store';
import { Icon } from './Icon';

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
  const closeImagePanel = useEditor((s) => s.closeImagePanel);
  const toggleImageReference = useEditor((s) => s.toggleImageReference);
  const generations = useEditor((s) => s.generations);
  const cancelGeneration = useEditor((s) => s.cancelGeneration);
  const retryGeneration = useEditor((s) => s.retryGeneration);
  const dismissGeneration = useEditor((s) => s.dismissGeneration);

  const list = Object.values(assets);
  // The bin's own generations — a photo asked for, or a video — are shown here, where
  // their result lands, rather than in the inspector where a transition's progress
  // belongs. Both kinds, because the sheet closes on send: this is the only place a
  // generation can report progress, fail, or offer its Retry.
  const binJobs = Object.values(generations).filter(
    (g) => g.target.kind === 'image' || g.target.kind === 'video',
  );
  const running = binJobs.filter((g) => g.status === 'queued' || g.status === 'running');
  const failed = binJobs.filter((g) => g.status === 'failed');
  const empty = list.length === 0 && importing === 0 && running.length === 0;
  // While the compose panel is open the bin is a reference picker, so a tile stops being
  // a drag source: adding to the timeline is not this screen's task, and two meanings for
  // one press is how a control becomes unpredictable.
  const composing = panel.open;

  return (
    <div className="col">
      <div className="panel-head">
        <span className="panel-head__title">Media</span>
        <div className="panel-head__actions">
          {/* Importing is not a first-run-only affordance: it stays here however full the bin is. */}
          <button
            type="button"
            className="panel-head__action"
            aria-label="Import media"
            title="Import photos, videos and sounds from disk"
            onClick={() => void importViaDialog()}
          >
            <Icon name="import" size={13} /> Import
          </button>
          {/* The other way media gets here. Its sheet opens over the preview stage rather
              than in this column, which is too narrow to compose in — but the bin stays a
              reference picker while it is open, which is why the button lives here.
              Pressed while the sheet is open, it closes it again. */}
          <button
            type="button"
            className={`panel-head__action${composing ? ' panel-head__action--on' : ''}`}
            aria-label="Generate a photo or video"
            aria-pressed={composing}
            title="Ask Higgsfield for a new photo or video"
            onClick={composing ? closeImagePanel : openImagePanel}
          >
            <Icon name="sparkle" size={13} /> Generate
          </button>
        </div>
      </div>
      <div className="bin" data-composing={composing ? 'true' : undefined}>
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
            <b>
              {generation.error?.title ??
                `The ${generation.target.kind === 'video' ? 'video' : 'photo'} could not be generated`}
            </b>
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
                aria-label={`Dismiss the failed ${
                  generation.target.kind === 'video' ? 'video' : 'photo'
                } ${generation.prompt}`}
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
            <button type="button" className="linklike" onClick={importViaDialog}>
              import
            </button>
            .
          </div>
        )}

        {list.map((asset) => {
          const onTimeline =
            clips.filter((c) => c.assetId === asset.id).length +
            audioTracks.filter((t) => t.assetId === asset.id).length;
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
              // Focusable, but deliberately not `role="button"`: Space is the transport key
              // everywhere in this app, and a button that swallowed it would take play
              // away from the user for as long as a tile held focus.
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
              <div className="bin__thumb">
                {asset.missing ? null : asset.kind === 'photo' ? (
                  <img src={asset.src} alt="" draggable={false} />
                ) : asset.kind === 'video' ? (
                  // `draggable={false}` for the same reason the photo above carries it: a
                  // native drag started here would strand the tile drag with no pointerup.
                  <video src={asset.src} muted preload="metadata" draggable={false} />
                ) : (
                  <div className="bin__audio" aria-hidden="true">
                    <Icon name="music" size={22} />
                  </div>
                )}
                {/* A photo is what a bin is for; only a sound and a video need saying. */}
                {asset.kind !== 'photo' && !asset.missing && (
                  <span className="kind" aria-hidden="true">
                    <Icon name={asset.kind === 'video' ? 'play' : 'music'} size={10} />
                    {asset.kind === 'video' ? 'VIDEO' : 'AUDIO'}
                  </span>
                )}

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
                    <Icon name="x" size={13} />
                  </button>
                )}
              </div>
              {/* One truncation, the CSS one; the whole name is a hover away. */}
              <span className="bin__name" title={asset.name}>
                {asset.name}
              </span>
            </div>
          );
        })}

        {/* A photo on its way, in the same language an import already speaks. */}
        {running.map((generation) => (
          <div key={generation.id} className="bin__skeleton bin__skeleton--gen">
            <span className="bin__gen-mark" aria-label={`Generating ${generation.prompt}`}>
              <Icon name="sparkle" size={14} />
            </span>
            <button
              type="button"
              className="bin__remove"
              aria-label={`Stop generating ${generation.prompt}`}
              onClick={() => void cancelGeneration(generation.id)}
            >
              <Icon name="x" size={13} />
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
