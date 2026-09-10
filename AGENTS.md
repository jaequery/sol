# SolCut agent guidance

Read this file before changing media, timeline, export, project persistence, or
rendering behavior. Keep changes grounded in the existing Tauri + React editor;
do not invent a separate video-production pipeline.

## Repository map

- `src/` contains the React editor, Zustand state, media/timeline logic, project
  types, backend adapters, and tests.
- `src-tauri/` contains the desktop bridge and Rust implementation for media
  probing/import, project files, settings, and ffmpeg-backed operations.
- `src/components/` contains editor surfaces such as `MediaBin`, `Timeline`,
  `Preview`, `Inspector`, and `ExportDialog`.
- `src/lib/` contains browser-testable domain logic and backend interfaces.
- `src/state/` contains editor state and orchestration.
- `scripts/` contains repository validation scripts, including `css-audit.sh`.
- `design/` contains HTML design concepts and walkthrough artifacts; it is not
  the production render pipeline.
- `README.md` is the product and workflow reference. Confirm implementation
  details in source and tests when they differ.

There is no checked-in source-media, render-output, or generated-media
directory. Named projects are ordinary `.solcut` files at a user-selected
path. An unnamed project is stored as `project.json` in the app-data area, and
generated media is kept in SolCut's app-data area rather than beside the source
file.

## Development and validation

Install the repository with Node 20+ and pnpm 10+:

```bash
pnpm install
pnpm dev          # Vite UI in a browser; desktop-only actions refuse loudly
pnpm tauri dev    # Tauri desktop app
```

Before considering a media or export change complete, run the relevant checks:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm audit:css
```

Use the Tauri desktop app when testing real filesystem paths, native dialogs,
ffmpeg export, iCloud downloads, or external CLI integrations. The browser
mode is appropriate for UI and pure-domain tests but cannot prove desktop-only
behavior.

## Media model and conventions

- Photos and videos share one timeline lane. Audio uses separate audio lanes;
  each lane contains one placed sound.
- The implemented video extensions are `mp4`, `mov`, `webm`, `m4v`, `mkv`, and
  `avi`. Audio and photo extensions are defined alongside them in
  `src-tauri/src/media.rs`; update that source and its tests together when
  changing the supported set.
- Export is MP4 through ffmpeg. The project aspect ratio controls the output
  frame: 16:9 is the default, with 9:16, 1:1, 4:5, 4:3, 3:2, and 21:9 also
  supported. The short edge is 1080 pixels, and the export uses 30 fps and
  H.264.
- Preview and export must agree on framing. Photos fill and crop to the project
  frame; videos fit and letterbox. Transform order is rotate, flip, crop, fit,
  then zoom.
- Preserve the distinction between generated and source media. Generated
  photos and videos land in the media bin; they do not go onto the timeline
  until placed. A generated video is measured at its real duration.
- Do not silently normalize, rename, or replace a missing source. A moved or
  deleted path is represented as missing/offline and export refuses it by name.

## Render and external-tool rules

- `ffmpeg` and `ffprobe` must be available on `PATH` for export, video-sided
  transitions, and every local-motion transition. Check availability before
  starting work that depends on them; export must fail before writing a
  half-rendered result.
- Higgsfield renders use the official Higgsfield CLI and require its signed-in
  workspace. Generated videos are saved with an `.mp4` extension; do not infer
  their extension from an ambiguous response content type.
- Local motion is compositing, not image generation: Claude Code or Codex
  supplies a constrained motion recipe and ffmpeg creates the frames. Keep the
  transition name and duration validation closed over the existing vocabulary;
  never pass model output through as raw ffmpeg syntax.
- iCloud-evicted files may need to be downloaded before probing. HEIC imports
  are converted to JPEG with macOS `sips` because the webview and stock ffmpeg
  cannot read HEIC directly.
- Renders can be queued or interrupted. Do not add automatic retry or resume
  behavior unless the state model and tests explicitly support it; an
  interrupted job currently returns a Retry action instead.

## Asset handling

- Keep source media outside the repository unless a task explicitly requires a
  small fixture. Tests use their existing fixtures and stubs; do not add real
  camera footage just to exercise code.
- This repository has no established Git LFS, external object-storage, or
  checked-in render-output convention. Do not claim that one exists, add a
  binary-storage policy by implication, or commit large media as a substitute
  for a documented fixture.
- Prefer paths and generated app-data outputs already used by the application.
  Remember that `.solcut` projects store machine-local absolute media paths, so
  a project file is not a portable media bundle.
- Treat generated renders and downloaded API results as disposable outputs
  unless the task explicitly asks to preserve an artifact. Never overwrite a
  user's source file during import, transform, or export.

## Review expectations

For a change that affects video behavior, provide evidence appropriate to the
surface changed:

1. Add or update tests at the existing public seam. Keep pure timeline, aspect,
   transform, backend, project, and media rules covered by their neighboring
   tests; use the desktop app for native filesystem and process behavior.
2. Run the applicable pnpm checks and confirm the real exit codes. A successful
   UI-only build does not prove ffmpeg, native dialogs, or a real render.
3. For export or render changes, demonstrate a successful MP4 result with the
   expected project frame, 30 fps/H.264 settings, audio behavior, and any
   relevant transition or missing-media failure state.
4. Review the diff for accidental media binaries, secrets, machine-local paths,
   temporary files, and changes to generated output. Keep a preview or
   walkthrough artifact when the work changes a user-visible flow.

## Common gotchas

- `pnpm dev` does not provide the native capabilities that `pnpm tauri dev`
  provides; do not treat browser-mode success as proof of desktop behavior.
- A `.solcut` file records paths, not embedded media. Moving the project or its
  media can produce a valid project with offline assets.
- A video job's real duration matters when it is placed on the timeline; do not
  substitute a guessed still duration.
- Audio that runs beyond the film is cut at the film end during export; it is
  not padded.
- Aspect ratio is project-wide. Do not implement preview-only framing or export
  a transition with a shape different from the project frame.
- External CLI availability is not the same as authentication. Let the
  existing failure path name the missing login, workspace, or executable rather
  than inventing a fallback credential path.
