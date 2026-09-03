/**
 * The media bin's create sheet: ask Higgsfield for a photo, or for a video.
 *
 * **Where it sits, and why it moved.** It used to be a strip inside the bin, which is a
 * 280px column — a prompt box, a mode, a model row and a button in a space that narrow is
 * how the panel came to look like a form rather than a tool. It is now a sheet floating
 * over the preview stage, which is the widest thing on screen. What it is emphatically
 * *not* is a modal: the bin has to stay visible and clickable, because in photo mode every
 * usable tile in it is a reference toggle and covering them would defeat the flow. So there
 * is no scrim, no `aria-modal` and no focus trap — trapping Tab here would put those very
 * tiles out of keyboard reach. The film panel has the same posture for the same reason.
 *
 * **What is on screen.** One prompt, one action, and one hint that says where the result
 * goes. Everything else — the model, and the aspect ratio when there is one — is behind a
 * disclosure, because media that matches the project's own frame is what almost every
 * generation wants. The mode switch changes four things (the prompt's label, the hint, the
 * disclosed options and the action) and moves nothing.
 */

import { useState } from 'react';
import * as backend from '../lib/backend';
import { useEditor } from '../state/store';
import { Icon } from './Icon';

export function CreateSheet() {
  const panel = useEditor((s) => s.imagePanel);
  const settings = useEditor((s) => s.settings);
  const setImagePrompt = useEditor((s) => s.setImagePrompt);
  const setImageModel = useEditor((s) => s.setImageModel);
  const setImageAspect = useEditor((s) => s.setImageAspect);
  const setCreateMode = useEditor((s) => s.setCreateMode);
  const setVideoModel = useEditor((s) => s.setVideoModel);
  const closeImagePanel = useEditor((s) => s.closeImagePanel);
  const startImageGeneration = useEditor((s) => s.startImageGeneration);
  const startVideoGeneration = useEditor((s) => s.startVideoGeneration);
  const openSettings = useEditor((s) => s.openSettings);

  const [showOptions, setShowOptions] = useState(false);

  if (!panel.open) return null;

  const video = panel.mode === 'video';
  const connected = Boolean(settings?.configured);
  const attached = panel.referenceAssetIds.length;
  const limit = backend.imageReferenceLimit(panel.modelId);

  return (
    // `role="dialog"` without `aria-modal`, like the film panel: this names the layer for a
    // screen reader without claiming the rest of the app is unavailable, which it is not.
    <div className="sheet" role="dialog" aria-label="Generate a photo or video">
      <div className="sheet__head">
        <span className="sheet__title">Generate</span>
        {/* Two buttons rather than a radiogroup: the app already expresses a
            mutually-exclusive pair this way (the inspector's insert/overwrite), and a
            vocabulary used twice beats a second one used once. */}
        <div className="seg" role="group" aria-label="What to generate">
          <button
            type="button"
            className={`seg__btn${video ? '' : ' seg__btn--on'}`}
            aria-pressed={!video}
            onClick={() => setCreateMode('photo')}
          >
            Photo
          </button>
          <button
            type="button"
            className={`seg__btn${video ? ' seg__btn--on' : ''}`}
            aria-pressed={video}
            onClick={() => setCreateMode('video')}
          >
            Video
          </button>
        </div>
        {/* Named for what it closes: a bare "Close" would answer to the same query as the
            settings dialog's, and the two mean different things. */}
        <button
          type="button"
          className="sheet__close"
          aria-label="Close the generate panel"
          onClick={closeImagePanel}
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      <div className="sheet__body">
        <label className="visually-hidden" htmlFor="create-prompt">
          {video ? 'Describe the video to generate' : 'Describe the photo to generate'}
        </label>
        <textarea
          id="create-prompt"
          className="prompt"
          autoFocus
          placeholder={video ? 'Describe the shot…' : 'Describe the photo…'}
          value={panel.prompt}
          onChange={(e) => setImagePrompt(e.target.value)}
        />

        <p className="hint">
          {video
            ? 'The model decides the length. The clip lands in the media bin.'
            : attached === 0
              ? 'Click photos in the bin to generate on top of them.'
              : `${attached} of ${limit} references — click a photo to add or remove it.`}
        </p>

        <button
          type="button"
          className="disclosure"
          aria-expanded={showOptions}
          onClick={() => setShowOptions(!showOptions)}
        >
          <Icon name={showOptions ? 'chevron-down' : 'chevron-right'} size={12} />
          {showOptions ? 'Hide options' : 'Options'}
        </button>

        {showOptions &&
          (video ? (
            /* Labelled "Video model" rather than "Model": the transition picker of that
               name can be on screen at the same time, in the inspector. There is no aspect
               ratio here on purpose — a prompt-only request does not carry one, so a
               control for it would be a lie. */
            <div className="field">
              <label htmlFor="create-video-model">Video model</label>
              <select
                id="create-video-model"
                value={panel.videoModelId}
                onChange={(e) => setVideoModel(e.target.value)}
              >
                {backend
                  .videoModelChoices(settings?.customModel, panel.videoModelId)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
              </select>
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="create-image-model">Image model</label>
                <select
                  id="create-image-model"
                  value={panel.modelId}
                  onChange={(e) => setImageModel(e.target.value)}
                >
                  {backend.IMAGE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="create-image-aspect">Aspect ratio</label>
                <select
                  id="create-image-aspect"
                  value={panel.aspect}
                  onChange={(e) => setImageAspect(e.target.value)}
                >
                  {backend.imageAspects(panel.modelId).map((aspect) => (
                    <option key={aspect} value={aspect}>
                      {aspect}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ))}

        {!connected && (
          <div className="callout" role="status">
            <b>Connect Higgsfield to generate</b>
            {backend.isDesktop()
              ? `${video ? 'Videos' : 'Photos'} are generated by Higgsfield — there is no local generator to fall back on. Nothing has been sent.`
              : 'Generating needs the SolCut desktop app — run it with `pnpm tauri dev`. Nothing has been sent.'}
            <button type="button" onClick={openSettings}>
              Open settings →
            </button>
          </div>
        )}
      </div>

      {/* Outside the scrolling body on purpose. At the 1080x660 minimum window the stage is
          short enough that an opened disclosure pushes the action past the fold, and a
          primary action you have to go looking for is a broken one. */}
      <div className="sheet__foot">
        <button
          type="button"
          className="block-btn"
          disabled={!connected || panel.prompt.trim() === ''}
          onClick={() => (video ? startVideoGeneration() : startImageGeneration())}
        >
          <Icon name="sparkle" size={14} /> {video ? 'Generate video' : 'Generate photo'}
        </button>
      </div>
    </div>
  );
}
