# SolCut

A simplified CapCut-style video editor for the desktop, built with **Tauri 2**.

One timeline. Drop photos and videos onto it side by side. Put keyframes on a photo to set
how it is framed over time, then describe the motion between two of them in words —
**Higgsfield** renders that segment as a real video clip and drops it back onto the
timeline in place of the still.

## What it does

- **A single track.** Photos and videos land on the same lane in drop order. No layers, no
  compositing — that is the whole point of the design. Drag a clip along the track to
  reorder it, or either of its edges to change how long it runs — a video's edges trim its
  in- and out-points and cannot leave the source file.
- **2D keyframes on photos.** Scale, position, rotation and opacity, interpolated between
  keyframes and previewed live as you scrub.
- **Prompt-driven AI segments.** Select the gap between two keyframes, describe the motion,
  and the two keyframe framings are rendered to stills and sent to Higgsfield as the first
  and last frame of the generation. The finished MP4 replaces that segment.
- **A film from three photos.** **✦ New film from 3 photos** — in the title bar and in the
  empty timeline — opens a panel that takes exactly three photos, puts them in order, and
  offers a prompt per transition already filled in. Generate runs the two Higgsfield
  transitions (photo 1 → 2 and 2 → 3) side by side and shows them landing leg by leg; the
  panel is not modal, so the editor stays usable while they render.
- **MP4 export** of the whole timeline via ffmpeg, keyframe motion included.

## Running it

```bash
pnpm install
pnpm tauri dev      # the desktop app
pnpm dev            # the UI alone in a browser; desktop-only actions refuse loudly
```

### Requirements

| | |
|---|---|
| Node | 20+ with pnpm 10+ |
| Rust | stable (1.80+) |
| ffmpeg + ffprobe | on `PATH` — needed for export only |
| Linux system libraries | `pkg-config`, `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`, `libjavascriptcoregtk-4.1-dev` |

On Debian/Ubuntu:

```bash
sudo apt install pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
                 libjavascriptcoregtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev ffmpeg
```

### Connecting Higgsfield

Create a credential at [cloud.higgsfield.ai](https://cloud.higgsfield.ai) — it comes as a
**key ID and a secret**, and both are needed. Open **✦ Connect Higgsfield** in the title
bar and paste them in. They are stored by the Rust backend in an owner-only file under the
app config directory and never reach the webview.

The integration follows the public API at [docs.higgsfield.ai](https://docs.higgsfield.ai):

| | |
|---|---|
| Base URL | `https://api.higgsfield.ai` |
| Auth | `Authorization: Key {key_id}:{key_secret}` |
| Keyframe upload | `POST /files/generate-upload-url`, then a presigned `PUT` |
| Submit | `POST /higgsfield-ai/dop/standard` with `{prompt, image_url, end_image_url}` |
| Poll | the `status_url` from the submit response, backing off 2s → 10s |
| Result | `video.url` on a `completed` request |

The base URL and the model endpoint are editable in the same dialog, so another documented
model — or an API revision — can be pointed at without shipping a new build. The dialog
suggests the endpoints that take a first frame; DoP is the default because it is the one
that also takes a *last* frame, which is what a SolCut segment is.

## Checks

```bash
pnpm typecheck                                        # tsc --noEmit
pnpm lint                                             # eslint
pnpm test                                             # vitest — timeline logic + acceptance flow
cargo test -p solcut-higgsfield -p solcut-render      # API client + ffmpeg export
cargo clippy -p solcut-higgsfield -p solcut-render --all-targets -- -D warnings
cargo fmt --all --check
```

## Layout

```
src/                     React + TypeScript editor
  types/project.ts       the data model
  lib/timeline.ts        pure timeline maths — layout, interpolation, segment replacement
  lib/film.ts            pure film orchestration — three photos, two AI transitions
  lib/frames.ts          rendering a keyframe to a still for the API
  lib/backend.ts         the only place that talks to Tauri
  state/store.ts         zustand store
  components/            title bar, media bin, preview, inspector, timeline, film wizard,
                         dialogs
src-tauri/
  src/                   Tauri commands, the generation job loop, settings storage
  crates/higgsfield/     Higgsfield API client — no Tauri or GUI dependencies
  crates/render/         ffmpeg filter graphs and export — no Tauri or GUI dependencies
design/                  the approved concept and the hi-fi UX walkthrough
docs/state-matrix.md     every UI state, its trigger, and its way out
```

The two crates under `src-tauri/crates/` are deliberately free of Tauri and GUI
dependencies: the interesting logic (API envelope handling, keyframe→ffmpeg expression
building) is then testable on any machine, including CI without a GTK toolchain.

## Known limits

- **Photo scale is 1.0–4.0.** `zoompan` cannot zoom out past the frame, so scaling a photo
  below "cover" — which would show empty background — is not part of the model. The editor
  and the exporter agree on this.
- **A video can only be trimmed once its length is known.** The length is read from the
  file's metadata a moment after import; until it arrives the clip can be shortened but not
  lengthened, because nothing yet proves there are more frames to show.
- **A photo is held for at most 10 minutes**, and no clip goes under 100 ms.
- **Export needs ffmpeg on `PATH`.** It is checked before anything is written, and refused
  with instructions rather than half-rendered.
- **Browser drops have no filesystem path.** `pnpm dev` in a browser can import and edit,
  but export needs the desktop app, which resolves real paths.
- **The model decides the clip length.** No Higgsfield endpoint takes a free-form duration
  — DoP has no duration parameter at all, and the others publish fixed choices — so the
  segment's own length is what the timeline keeps, not something the request asks for.
- **Progress is queued-or-rendering.** The request status endpoint reports a state, not a
  percentage, so the bar only moves when the API volunteers one.
- **Keyframes are uploaded, not inlined.** Every model parameter that takes an image takes
  a URL, so each still is PUT to Higgsfield's presigned storage first. Uploaded inputs are
  tagged `retention=temporary`, and outputs are kept for at least seven days.
