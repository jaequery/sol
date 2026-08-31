# SolCut

A simplified CapCut-style video editor for the desktop, built with **Tauri 2**.

One timeline. Drop photos and videos onto it side by side. Select the cut between two
photos and describe the motion in words — **Higgsfield** renders a real video transition
from one still into the other and drops it onto the timeline at that cut.

## What it does

- **A single track.** Photos and videos land on the same lane in drop order. No layers, no
  compositing — that is the whole point of the design. Drag a clip to **anywhere** on the
  track: it lands exactly where you let go, gaps and all, and a gap is black film in the
  preview and in the export. One track cannot show two clips at once, so a clip dropped on
  top of another slides that one right rather than stacking. Drag either edge to change how
  long a clip runs — a video's edges trim its in- and out-points and cannot leave the source
  file — and hold **Snap** on to have a drop line itself up with a nearby edge or the
  playhead when it comes within a few pixels.
- **Audio tracks.** Sound files (mp3, wav, ogg, flac, aac, m4a) get their own lanes below
  the track — as many as you like, via **♪ Add audio** or a drop. Each lane holds one
  sound: drag it along the lane to place it, drag its edges to trim it, set its volume or
  mute it in the inspector. Audible lanes are mixed under the film on export; a sound that
  outlasts the last clip is cut at the film's end, never padded.
- **Prompt-driven AI transitions.** A ✦ chip stands on every cut between two photos —
  touching, or across a gap dragged open between them. Select it, describe the motion (or
  leave the default), and the two photos are rendered to stills and sent to Higgsfield as
  the first and last frame of the generation. The finished MP4 lands at the cut; the
  photos themselves are the anchor frames, so nothing else needs setting up. A **Model**
  selector on the same card picks which model renders it — **Seedance 2.5** unless another
  is chosen — and the pick rides with that render alone.
- **A film from three photos — three images in, one .mp4 out.** **✦ New film from 3
  photos** — in the title bar and in the empty timeline — opens a panel that takes exactly
  three photos, puts them in order, and offers a prompt per transition already filled in.
  Generate runs the two Higgsfield transitions (photo 1 → 2 and 2 → 3) side by side and
  shows them landing leg by leg; the panel is not modal, so the editor stays usable while
  they render. When both are in, the film **puts itself on the timeline** — the two clips
  in order, badged AI and playable — and the panel offers **Export film**. See
  [the flow](#three-photos-to-an-mp4) below.
- **MP4 export** of the whole timeline via ffmpeg, audio lanes included.

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
| Higgsfield CLI | `npm i -g @higgsfield/cli`, signed in — needed for AI transitions only |
| Linux system libraries | `pkg-config`, `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`, `libjavascriptcoregtk-4.1-dev` |

On Debian/Ubuntu:

```bash
sudo apt install pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
                 libjavascriptcoregtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev ffmpeg
```

### Connecting Higgsfield

Renders run through the **official Higgsfield CLI**
([github.com/higgsfield-ai/cli](https://github.com/higgsfield-ai/cli)), signed in to your
higgsfield.ai account — so generations bill your **subscription's workspace**, not the
pay-per-token API platform, and the app itself holds no credential at all. In a terminal:

```bash
npm i -g @higgsfield/cli
higgsfield auth login
higgsfield workspace set <workspace_id>
```

**✦ Connect Higgsfield** in the title bar shows whether the CLI was found (looking on
`PATH` and in the usual npm/Homebrew prefixes), and **Test connection** runs one free,
read-only CLI call — `higgsfield model list --video` — which proves the binary, the login
and the billing workspace in one go, and repeats the CLI's own fix when one is missing.

What actually runs, per render:

| | |
|---|---|
| Submit | `higgsfield generate create <model> --prompt … --start-image … --end-image … --json` — the CLI uploads the two stills itself |
| Poll | `higgsfield generate get <job_id> --json`, backing off 2s → 10s |
| Result | the job's `result_url` on completion, downloaded next to the project |

**Which model renders is picked per render, not in this dialog.** Every place a render
starts — the cut card, a transition's Regenerate, the film wizard — carries a **Model**
selector, and whatever it shows when the button is pressed is what that render uses:
**Seedance 2.5** by default (`seedance_2_5`, the id Higgsfield's own site opens it with),
or Seedance 2.0, Seedance 1.5 Pro, Kling v3.0 and Veo 3.1 Lite — models whose CLI
reference documents both a `--start-image` *and* an `--end-image`, which is what a SolCut
transition needs. The choice travels with the request and is never written to disk, so a
fresh session is back on the default. Model ids are checked by the CLI against the live
catalog, so a model your plan does not carry fails by name — and switching models is one
click on the same card.

A **custom model** stays editable in the dialog, so any other job type the catalog offers
(`higgsfield model list --video`) can be pointed at without shipping a new build: the id
typed here appears in every Model selector as its **Custom** entry. (Settings files saved
by earlier builds stored API-platform keys and endpoints; they load harmlessly and are
dropped on the next save.)

## Three photos to an .mp4

The shortest path through SolCut. The film is nothing but the AI transitions between the
three photos, so no still is ever held on screen.

1. **✦ New film from 3 photos**, from the title bar or the empty timeline.
2. **Drop or choose exactly three photos.** A fourth, or a video, is left out by name with
   the reason. ↑ / ↓ order them — slot order is the film's running order.
3. **Both prompts arrive filled in.** Edit them or leave them; zero typing is required.
4. **Generate film.** The photos go into the media bin as *inputs* — nothing lands on the
   track — and the two transitions render side by side, each with its own progress and its
   own retry. The editor stays usable throughout.
5. **Both transitions in → the film assembles itself**: the two clips are appended to the
   track in order (photo 1 → 2, then 2 → 3), badged AI and immediately playable. It appends
   at the end of whatever is on the track *at that moment*, so editing while it renders is
   safe. A film with a failed leg assembles nothing — retry the leg, and only that leg.
6. **Export film** in the panel (or **Export MP4** in the title bar) opens the save dialog
   and runs the ffmpeg export: **H.264, 1920 × 1080, 30 fps**. The toast names the file and
   offers to reveal it.

Two transitions give a film of about 10 s at 5 s a leg — the model decides the exact
length, and the timeline takes it from the file. There is **no local fallback**: with no
Higgsfield credential the panel refuses up front and sends nothing, and export refuses
without ffmpeg on `PATH` rather than writing half a file.

## Checks

```bash
pnpm typecheck                                        # tsc --noEmit
pnpm lint                                             # eslint
pnpm test                                             # vitest — timeline logic + acceptance flow
cargo test -p solcut-higgsfield -p solcut-render      # API client + ffmpeg export
cargo clippy -p solcut-higgsfield -p solcut-render --all-targets -- -D warnings
cargo fmt --all --check
```

Everything above runs offline against a stub `higgsfield` executable. To prove the real
CLI on this machine — one read-only model listing, nothing generated and nothing charged,
plus a check that the default model `seedance_2_5` is in your account's catalog:

```bash
cargo test -p solcut-higgsfield --test live -- --nocapture
```

With no CLI installed (or one that is not signed in) it says so and passes, so it is safe
in a plain `cargo test` run.

## Layout

```
src/                     React + TypeScript editor
  types/project.ts       the data model
  lib/timeline.ts        pure timeline maths — placement, cuts, transitions
  lib/film.ts            pure film orchestration — three photos, two AI transitions
  lib/frames.ts          rendering a photo to a still for the API
  lib/backend.ts         the only place that talks to Tauri
  state/store.ts         zustand store
  components/            title bar, media bin, preview, inspector, timeline, film wizard,
                         dialogs
src-tauri/
  src/                   Tauri commands, the generation job loop, settings storage
  crates/higgsfield/     Higgsfield CLI wrapper — no Tauri or GUI dependencies
  crates/render/         ffmpeg filter graphs and export — no Tauri or GUI dependencies
design/                  the approved concept and the hi-fi UX walkthrough
docs/state-matrix.md     every UI state, its trigger, and its way out
```

The two crates under `src-tauri/crates/` are deliberately free of Tauri and GUI
dependencies: the interesting logic (CLI invocation and output handling, ffmpeg
filter-graph and argv building) is then testable on any machine, including CI without a
GTK toolchain.

## Known limits

- **A video can only be trimmed once its length is known.** The length is read from the
  file's metadata a moment after import; until it arrives the clip can be shortened but not
  lengthened, because nothing yet proves there are more frames to show. An audio track
  follows the same rule.
- **One sound per audio lane.** A lane is a single placed sound, not a sequence — add the
  same file again for a second cue. Previewing a lane uses the webview's audio decoder;
  the export decodes with ffmpeg either way, so a format the preview cannot play can still
  be mixed into the MP4.
- **A photo is held for at most 10 minutes**, and no clip goes under 100 ms.
- **A clip's head stops at the clip in front of it.** Pulling the head left reveals more of
  the source, so it needs empty track to move into; it stops at the neighbour's end (or at
  0:00) rather than shoving anything out of the way. The tail is the edge that pushes.
- **Export needs ffmpeg on `PATH`.** It is checked before anything is written, and refused
  with instructions rather than half-rendered.
- **Browser drops have no filesystem path.** `pnpm dev` in a browser can import and edit,
  but export needs the desktop app, which resolves real paths.
- **The model decides the clip length.** The models publish fixed duration choices and
  the CLI defaults them, so the file's own length is what the timeline keeps, not
  something the request asks for.
- **A film goes onto the track once.** It lands the moment its last transition is in, and
  is then an ordinary pair of clips: move, trim or delete them as you like. Retrying a leg
  afterwards updates the film's own record but never lays down a second copy.
- **Progress is queued-or-rendering.** The job status reports a state, not a percentage,
  so the bar only moves when one is volunteered.
- **Stills are uploaded, not inlined.** Each still is written to a temp file and handed
  to the CLI as `--start-image`/`--end-image`; the CLI uploads them itself and the files
  are removed the moment the submission is answered.
