# SolCut

A simplified CapCut-style video editor for the desktop, built with **Tauri 2**.

One timeline. Drop photos and videos onto it side by side. Select the cut between two
photos and describe the motion in words — **Higgsfield** renders a real video transition
from one still into the other and stands it in the photos' place on the timeline, so the
cut plays as pure motion rather than stills padded around an animation.

## What it does

- **A single track.** Photos and videos land on the same lane in drop order. No layers, no
  compositing — that is the whole point of the design. Drag a clip to **anywhere** on the
  track: it lands exactly where you let go, gaps and all, and a gap is black film in the
  preview and in the export. One track cannot show two clips at once, so a clip dropped on
  top of another slides that one right rather than stacking. Drag either edge to change how
  long a clip runs — a video's edges trim its in- and out-points and cannot leave the source
  file — and hold **Snap** on to have a drop line itself up with a nearby edge or the
  playhead when it comes within a few pixels. Click anywhere along the timeline — the
  ruler, a gap, a clip, an audio lane — and the playhead cues exactly there, so play runs
  from the point you clicked; hold the button down on the ruler to scrub.
- **Photos you did not take.** The media bin generates as well as imports: **✦ Generate**
  beside **+ Import** opens a prompt box, and Higgsfield makes the photo. Describe it and
  that is the whole request — or click photos already in the bin to **generate on top of
  them**, up to fourteen references, and the picture is made from yours. A quiet **Options**
  disclosure picks the model (Nano Banana Pro by default, or Seedream 4.5, FLUX.2, GPT
  Image 2) and the aspect ratio, which follows the model. The finished photo lands in the
  bin as an ordinary photo — nothing moves on the timeline; you drag it on when you want
  it, and from there it can be animated like any other.
- **Audio tracks.** Sound files (mp3, wav, ogg, flac, aac, m4a) get their own lanes below
  the track — as many as you like, via **♪ Add audio** or a drop. Each lane holds one
  sound: drag it along the lane to place it, drag its edges to trim it, set its volume or
  mute it in the inspector. Audible lanes are mixed under the film on export; a sound that
  outlasts the last clip is cut at the film's end, never padded.
- **Prompt-driven AI transitions.** A ✦ chip stands on every cut between two photos —
  touching, or across a gap dragged open between them. Select it, describe the motion (or
  leave the default), and the two photos are rendered to stills and sent to Higgsfield as
  the first and last frame of the generation; the photos themselves are the anchor frames,
  so nothing else needs setting up. The finished MP4 **stands in the two photos' place**:
  they leave the track (staying in the media bin) and the clip wears both source
  thumbnails side by side, so playback across that span is pure motion, never a still
  frame. A **Model** selector on the same card picks which model renders it — **Seedance
  2.5** unless another is chosen — and the pick rides with that render alone. A quiet
  per-cut action keeps the photos on the track instead, inserting the finished clip
  between them. **✦ Animate all** fills every cut in one go, landing leg by leg — and once
  every leg has resolved, the run's photos leave the track too, so the whole chain ends as
  back-to-back animation.
- **A film from three photos — three images in, one .mp4 out.** A panel takes exactly
  three photos, puts them in order, and offers a prompt per transition already filled in.
  It has **no entry point in the UI right now** — the title bar's button went first and the
  empty timeline's call to action second, and nothing replaced either.
  Generate runs the two Higgsfield transitions (photo 1 → 2 and 2 → 3) side by side and
  shows them landing leg by leg; the panel is not modal, so the editor stays usable while
  they render. When both are in, the film **puts itself on the timeline** — the two clips
  in order, badged AI and playable — and the panel offers **Export film**. See
  [the flow](#three-photos-to-an-mp4) below.
- **MP4 export** of the whole timeline via ffmpeg, audio lanes included.
- **Your work is still there tomorrow.** The project saves itself as you edit — no save
  button, no dialog, nothing on screen while it works — and comes back when the app
  reopens: the same clips, trims, audio lanes and media bin. It lives in one
  `project.json` beside the settings, and holds paths rather than copies, so a file that
  moved away since last time comes back visibly **missing** (dimmed in the bin, MEDIA
  OFFLINE in the preview, and refused by name at export) instead of failing mid-render.

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
| Higgsfield CLI | `npm i -g @higgsfield/cli`, signed in — needed for AI transitions and generated photos only |
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
pay-per-token API platform, and the render path itself holds no credential at all
(Settings can also keep a Cloud **API key**, but nothing renders through it — see
[below](#the-api-key-which-is-a-different-credential)). In a terminal:

```bash
npm i -g @higgsfield/cli
higgsfield auth login
higgsfield workspace set <workspace_id>
```

**Settings** in the title bar opens the Higgsfield connection, which shows whether the
CLI was found (looking on `PATH` and in the usual npm/Homebrew prefixes), and where
**Test connection** runs one free,
read-only CLI call — `higgsfield model list --video` — which proves the binary, the login
and the billing workspace in one go, and repeats the CLI's own fix when one is missing. It
proves the photo path too: same binary, same login, same billing workspace.

What actually runs, per render:

| | |
|---|---|
| Submit a transition | `higgsfield generate create <model> --prompt … --start-image … --end-image … --json` — the CLI uploads the two stills itself; Seedance 2.5 additionally gets `--mode omni_reference`, the one mode in which it accepts frame inputs. The ack is the list of ids it queued (`["d2f79a31-…"]`) |
| Submit a photo | `higgsfield generate create <image model> --prompt … --image … --aspect_ratio … --json`, with `--image` repeated once per reference. The references are the bin's own files and the CLI uploads them, so nothing is written to a temp file. **No `--mode`**: that rule belongs to Seedance 2.5's video frame inputs and image models publish no such value |
| Poll | `higgsfield generate get <job_id> --json`, backing off 2s → 10s |
| Result | the job's `result_url` on completion, downloaded next to the project. A photo is named from the response's own content type — the media bin classifies by extension and nothing else, so a file saved under the wrong one would come back as the wrong kind of media at the next launch |

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
typed here appears in every Model selector as its **Custom** entry.

### The API key, which is a different credential

The same dialog also holds a **Higgsfield API key** — the `key_id` / `key_secret` pair
minted at [cloud.higgsfield.ai](https://cloud.higgsfield.ai). It is worth being blunt
about what it is and is not:

|  | The CLI | The API key |
|---|---|---|
| Host | `fnf-api-gw.higgsfield.ai` | `api.higgsfield.ai` |
| Authenticates with | an OAuth login on your higgsfield.ai account | `Authorization: Key {id}:{secret}` |
| Bills | your subscription's plan credits | a separate Cloud balance |

They are two systems, and the CLI has no notion of an API key at all — it carries no
`--api-key` flag and reads no credential from the environment. **Renders go through the
CLI**, so the key is not what generates: SolCut keeps it so it can be set in one place and
proved on demand.

Both halves are needed, and both are stored by the desktop backend in an owner-only file
that never reaches the app window — Settings only ever shows a `••••7fa2` mask and whether
a key is held. Pasting the whole `key_id:key_secret` string into the ID box works too; it
is split back apart. **Test key** asks the documented read-only route,
`GET /requests/{request_id}/status`, about a request id that belongs to nobody: a `404`
means the credential authenticated, a `401` means it did not (quoting Higgsfield's own
words), a `403` means the account would not serve the call — usually an empty balance
rather than a bad key — and anything else is reported as inconclusive rather than as a
pass. Nothing is generated and nothing is charged. It proves the key in the boxes overlaid
on the stored one, so a key can be checked before it is saved, and **Forget key** removes
a stored one. (Settings files saved by earlier builds stored the same key beside a base
URL and a model endpoint: the key is read back, and the two routing fields — which served
a submit path that no longer exists — are dropped on the next save.)

## Three photos to an .mp4

The shortest path through SolCut. The film is nothing but the AI transitions between the
three photos, so no still is ever held on screen.

**The panel has no button to open it.** Both of its entry points were removed, and until one
is put back the flow below is reachable only from `openFilmWizard` in the store.

1. **The film panel opens.**
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
Higgsfield CLI on the machine the panel refuses up front and sends nothing — a stored API
key is not a substitute, because it is not what renders — and export refuses without
ffmpeg on `PATH` rather than writing half a file.

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

The same opt-in file proves a **Cloud API key** against the real platform when one is in
the environment — one free, read-only call that generates nothing. With no key set it says
so and passes:

```bash
HF_API_KEY_ID=… HF_API_KEY_SECRET=… cargo test -p solcut-higgsfield --test live -- --nocapture
# or, as Higgsfield's own SDKs carry it:
HF_KEY=key_id:key_secret cargo test -p solcut-higgsfield --test live -- --nocapture
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
  lib/project.ts         the saved project — what persists, and what a bad file may not do
  lib/backend.ts         the only place that talks to Tauri
  state/store.ts         zustand store
  components/            title bar, media bin (+ the compose panel), preview, inspector,
                         timeline, film wizard, dialogs
src-tauri/
  src/                   Tauri commands, the generation job loop, settings and project storage
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
- **The last half-second of editing can be lost.** The project is written half a second
  after you stop, so quitting mid-gesture drops that last change. A continuously changing
  timeline is written at least every five seconds regardless.
- **A film still rendering when you quit is not resumed.** A leg that had already finished
  leaves its MP4 on disk unused. A film that fully assembled is on the track by then, and
  persists like any other clip.
- **A moved file is indistinguishable from a deleted one.** Nothing tracks media identity
  beyond the absolute path, so re-importing is the way back.
- **One project.** There is no New, Open or Save As — the editor holds a single project
  that saves itself.
- **A generated photo needs a prompt.** Some image models will work from references
  alone, but SolCut asks for a prompt every time — one rule beats four per-model ones. The
  reference photos themselves must be jpg, png or webp: the bin accepts more formats than
  Higgsfield takes as a reference, and one that is not is refused **by name** before
  anything is sent, as is a photo whose file has moved or that never had one (a browser
  drop). Which image models your plan carries is between you and Higgsfield — the CLI
  checks each id against the live catalog, so one you do not have fails by name.
- **A photo still generating when you quit is not resumed**, exactly like a film leg. The
  finished ones are ordinary bin photos by then and persist like any other import.
- **Stills are uploaded, not inlined.** Each still is written to a temp file and handed
  to the CLI as `--start-image`/`--end-image`; the CLI uploads them itself and the files
  are removed the moment the submission is answered.
