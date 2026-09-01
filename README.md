# SolCut

A simplified CapCut-style video editor for the desktop, built with **Tauri 2**.

One timeline. Drop photos and videos onto it side by side. Select any cut between two
clips and describe the motion in words — **Higgsfield** renders a real video transition
from the frame on one side into the frame on the other, so the cut plays as motion rather
than a hard join. Between two photos it stands in the stills' place; where the footage is
real video, the footage stays.

The same cut can also be composited **locally** instead, with the **Claude Code CLI** or the
**Codex CLI** reading your words to pick the motion and ffmpeg making the frames — a couple
of cents rather than a plan credit. Both live in the same Model selector; see
[Local motion](#local-motion-the-agent-cli-backends).

## What it does

- **A single track.** Photos and videos land on the same lane in drop order. No layers, no
  compositing — that is the whole point of the design. A tile already in the **media bin**
  can be dragged back out onto the track whenever you like — it goes in at the boundary
  nearest where you let go, as a fresh copy, so the same photo can appear as often as you
  drag it, and a sound lands on its own lane at exactly the point it was released. Enter on
  a focused tile does the same at the playhead, without a mouse. Deleting a clip is
  therefore no longer a one-way door. A tile whose file has gone missing is not a source:
  it keeps its ✕ and nothing else. Drag a clip to **anywhere** on the
  track: it lands exactly where you let go, gaps and all, and a gap is black film in the
  preview and in the export. One track cannot show two clips at once, so a clip dropped on
  top of another slides that one right rather than stacking. Drag either edge to change how
  long a clip runs — a video's edges trim its in- and out-points and cannot leave the source
  file — or type the length in seconds into the inspector, which is the same edit without
  the gesture. Hold **Snap** on to have a drop line itself up with a nearby edge or the
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
  sound: drag it along the lane to place it, drag its edges to trim it, and set its length,
  its volume or its mute in the inspector. Audible lanes are mixed under the film on export; a sound that
  outlasts the last clip is cut at the film's end, never padded.
- **Prompt-driven AI transitions.** A ✦ chip stands on every cut between two clips —
  photo to photo, video to video, or one of each; touching, or across a gap dragged open
  between them. Select it, describe the motion (or leave the default), and each side gives
  up the frame at the cut: a photo *is* that frame, and a video's is pulled off the file at
  the exact point it runs out or begins, trims and all. The two go to Higgsfield as the
  first and last frame of the generation, so nothing else needs setting up. A **Model**
  selector on the same card picks what renders it — **Seedance 2.5** unless another is
  chosen — and the pick rides with that render alone. The same control carries the backend:
  below the Higgsfield models sits **Local motion — composited, not generated**, where the
  **Claude Code CLI** or the **Codex CLI** reads your words, picks the motion, and ffmpeg
  makes the frames on your own machine (see
  [below](#local-motion-the-agent-cli-backends)).

  Where the finished MP4 lands follows what is on the cut, because only a **still** can be
  stood in for. Between two photos it **stands in both their places**: they leave the track
  (staying in the media bin) and the clip wears both source thumbnails side by side, so
  playback across that span is pure motion, never a held frame. Beside real footage the
  same pick takes **only the photo** — the video keeps its span and its trim, because that
  is film the user shot, not a still waiting to be replaced. Between two videos there is no
  still at all, so the option is not offered and the render simply lands between them. A
  quiet per-cut action keeps the photos on the track instead, inserting the finished clip
  between them. **✦ Animate all** fills every photo-to-photo cut in one go, landing leg by
  leg — and once every leg has resolved, the run's photos leave the track too, so the whole
  chain ends as back-to-back animation. It stays photo-only on purpose: one tap should not
  start a paid render at every boundary of a reel of footage.
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
- **Your work is still there tomorrow.** The project saves itself as you edit, again every
  few seconds while anything is unwritten, and once more as the window closes — no save
  button to remember. It comes back when the app reopens: the same clips, trims, audio
  lanes and media bin, at the same playhead and the same zoom. A write that failed keeps
  being retried on its own rather than waiting for you to touch something, and the title bar
  says which state it is in — **Saving…**, **Saved**, or **Not saved** — in one dim word
  beside the project's name. It holds paths rather than copies, so a file that moved away
  since last time comes back visibly **missing** (dimmed in the bin, MEDIA OFFLINE in the
  preview, and refused by name at export) instead of failing mid-render. A render that was
  still going when the app closed comes back as an **Interrupted** card offering Retry: the
  job itself cannot be resumed, and nothing is ever re-sent on your behalf.
- **More than one project.** The title bar's project name is also the menu that changes
  which project it is: **New project**, **Open project…**, **Save as…**. A project you have
  named is an ordinary `.solcut` file wherever you put it, and autosave follows it there; an
  unnamed one lives in a `project.json` beside the settings until you give it a home. There
  is no plain Save, because there is nothing for it to do — the only save that means
  anything is the one that decides *where*. Switching projects writes the one you are
  leaving first, and the app reopens whichever one you were last in.

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
| ffmpeg + ffprobe | on `PATH` — needed for export, for a transition with video on either side, and for **every** local motion transition |
| Higgsfield CLI | `npm i -g @higgsfield/cli`, signed in — needed for Higgsfield transitions and generated photos only |
| Claude Code CLI *or* Codex CLI | optional — `npm install -g @anthropic-ai/claude-code` (`claude auth login`) or `npm install -g @openai/codex` (`codex login`). Only for the local motion backends |
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

### Local motion: the agent CLI backends

Beside Higgsfield, a transition can be composited on your own machine with a **coding-agent
CLI choosing the motion**. Pick **Claude Code CLI** or **Codex CLI** in the Model selector on
any cut; nothing else about the flow changes.

**Be clear about what this is.** Neither CLI generates pixels — they are coding agents, with
no image or video model behind them. So the work is split: the agent reads your prose and
answers with a *motion recipe*, and ffmpeg makes the frames. Ask for "the camera sweeps
across to the right, quick and snappy" and it answers `{"transition": "wiperight",
"duration_secs": 0.6}`, which SolCut composites into a real MP4 between your two frames.
That is a genuine transition and it costs about **two cents and ten seconds** instead of a
plan credit — but it is compositing, not diffusion, and the menu heading says so rather than
letting you find out from the result.

The recipe is a **closed vocabulary**: sixteen of ffmpeg's `xfade` motions, all present
since ffmpeg 4.3, and a length between 1 and 8 seconds. That is a security property rather
than a limitation — nothing the model writes is ever parsed as ffmpeg syntax, so there is no
filter-graph injection to guard against, and an answer naming anything else is refused by
name before ffmpeg is spawned. It is also why **no permission bypass is involved**: Claude
Code is run with `--tools ""`, which empties its tool array outright, so there is nothing to
permit in the first place.

What actually runs, per transition:

| | |
|---|---|
| Ask Claude Code | `claude -p <prompt> --output-format json --tools "" --json-schema <schema> --model haiku`, plus `--strict-mcp-config`, `--setting-sources ""`, `--disable-slash-commands` and `--no-session-persistence` so your own configuration cannot change what SolCut is answered. The recipe arrives in `structured_output`, guaranteed by the schema |
| Ask Codex | `codex exec <prompt> --sandbox read-only --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules -C <tmpdir>`. Codex has **no** way to disable tools and no structured-output mode, so its posture is genuinely weaker — a read-only agent that may still run shell commands — and its answer is read by a tolerant parser rather than guaranteed by a schema |
| Composite | `ffmpeg -loop 1 -t D -i start -loop 1 -t D -i end -filter_complex "…xfade=transition=<name>:duration=D:offset=0"`. Each still is held for exactly `D` and the crossfade runs the whole of it, so the output is `D` seconds of **pure motion with no held frame** — which is what lets it stand in for the photos it replaces, exactly as a Higgsfield render does |

Both CLIs are found the way the Higgsfield one is: `PATH` first, then the npm and Homebrew
prefixes a GUI-launched app does not inherit. Found means the binary is there and nothing
more — one that is not signed in fails at render time with its own words, which name their
own fix. A CLI that has updated past the flags above is reported as *that*, with the
reinstall line, rather than as a usage screen you did not ask for.

**The child inherits SolCut's environment**, so if you have `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` set, these calls bill the way your own terminal would. That is deliberate:
filtering it would make SolCut behave differently from the CLI you already tested.

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
length, and the timeline takes it from the file. The film renders with **whatever the Model
selector shows**, both legs alike, so it can be composited locally as readily as it can be
generated. What it will not do is guess: a backend this machine cannot run makes the panel
refuse up front and send nothing, naming the one that is missing — a stored API key is not
a substitute, because it is not what renders — and export refuses without ffmpeg on `PATH`
rather than writing half a file.

## Checks

```bash
pnpm typecheck                                        # tsc --noEmit
pnpm lint                                             # eslint
pnpm test                                             # vitest — timeline logic + acceptance flow
cargo test -p solcut-agent -p solcut-higgsfield -p solcut-render
cargo clippy -p solcut-agent -p solcut-higgsfield -p solcut-render --all-targets -- -D warnings
cargo fmt --all --check
```

Everything above runs offline against a stub `higgsfield` executable. To prove the real
CLI on this machine — one read-only model listing, nothing generated and nothing charged,
plus a check that the default model `seedance_2_5` is in your account's catalog:

```bash
cargo test -p solcut-higgsfield --test live -- --nocapture
```

The agent CLIs have their own live check, opt-in **twice over** — the CLI being installed is
not taken as consent, because unlike the free model listing above this one spends real money
(about two cents a run):

```bash
SOLCUT_LIVE_AGENT=1 cargo test -p solcut-agent --test live -- --nocapture
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

## Keyboard

| Key | Does |
|---|---|
| `Space` | Play / pause |
| `Home` / `End` | Cue the start / the end of the timeline |
| `←` / `→` | Step the playhead 100 ms; with `Shift`, 1 s |
| `S` | Split the clip under the playhead |
| `⌫` / `Delete` | Delete the selected clip or sound |
| `Esc` | Close the innermost dialog or panel |
| `Tab` onto a clip, then `←` / `→` | Nudge the clip (its edge handles trim it the same way) |
| `Tab` onto the ruler, then `←` / `→` / `Home` / `End` | Scrub without a mouse |

Every button in the app is reachable by `Tab` and answers to `Space` and `Enter`; the
dialogs keep focus inside themselves while they are open. The toolbar shows the main keys.

## Layout

```
src/                     React + TypeScript editor
  types/project.ts       the data model
  lib/timeline.ts        pure timeline maths — placement, cuts, transitions
  lib/film.ts            pure film orchestration — three photos, two AI transitions
  lib/frames.ts          rendering a photo to a still for the API (a video's frame comes
                         off ffmpeg — see `capture_video_frame`)
  lib/project.ts         the saved project — what persists, and what a bad file may not do
  lib/backend.ts         the only place that talks to Tauri
  state/store.ts         zustand store
  components/            title bar (+ the project menu), media bin (+ the compose panel),
                         preview, inspector, timeline, film wizard, dialogs
src-tauri/
  src/                   Tauri commands, the generation job loop, settings and project
                         storage (`project.rs` has no Tauri dependency, so it is testable
                         without the desktop shell)
  crates/agent/          the Claude Code / Codex backends — the whole run, not just the CLI
                         call, so a machine that cannot build the shell can still test it
  crates/higgsfield/     Higgsfield CLI wrapper — no Tauri or GUI dependencies
  crates/render/         ffmpeg filter graphs, export, and the xfade compositor — no Tauri
                         or GUI dependencies
design/                  the approved concept and the hi-fi UX walkthrough
.fredrin/memory/
  concepts/state-matrix.md   every UI state, its trigger, and its way out
  notes/                     ticket sweeps and working notes
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
- **A tile is dragged with the mouse, not a finger.** The bin scrolls, and a touch drag
  scrolls it rather than carrying the tile; Enter on a focused tile is the way in without a
  pointer. Mouse and pen are unaffected.
- **A tile dragged out mid-import lands at the default 5 s.** A video's real length is read
  from the file a moment after import, and a clip placed from the bin copies whatever the
  asset knows at that instant. Trim or stretch it once the length is in.
- **Browser drops have no filesystem path.** `pnpm dev` in a browser can import and edit,
  but export needs the desktop app, which resolves real paths.
- **The model decides the clip length.** The models publish fixed duration choices and
  the CLI defaults them, so the file's own length is what the timeline keeps, not
  something the request asks for. Local motion is the same in spirit — the agent picks the
  length — except that it is told how much track it is replacing, and the answer is clamped
  to 1–8 seconds so one click can never trade two five-second photos for a blink.
- **Local motion composites; it does not generate.** Sixteen `xfade` motions, chosen from
  your words. It will not invent what lies between two photos the way a video model does —
  it will move convincingly between them, for about two cents.
- **Animate all is serial on a local backend.** The pipelining that starts the next cut the
  moment the previous one is accepted keys off a job id, which a local render never has, so
  the cuts run one at a time. Slower on a long reel, and cheaper.
- **A film goes onto the track once.** It lands the moment its last transition is in, and
  is then an ordinary pair of clips: move, trim or delete them as you like. Retrying a leg
  afterwards updates the film's own record but never lays down a second copy.
- **Progress is queued-or-rendering.** The job status reports a state, not a percentage,
  so the bar only moves when one is volunteered.
- **Closing the window flushes; ⌘Q on macOS does not.** The project is written half a
  second after you stop, at least every five seconds while anything is unwritten, and once
  more when the window is closed — the close is held for that write. macOS's own Quit
  terminates the process without ever asking the window to close, so quitting that way falls
  back on the five-second interval and can drop the last few seconds. Closing the window
  (or ⌘W) loses nothing.
- **An interrupted render is reported once, not remembered for ever.** A generation that was
  in flight comes back as an **Interrupted** card with Retry; it is written down only while
  it is actually running, so once that card has been shown, the next save lets it go. The
  timeline is untouched either way and the cut is still one tap from generating.
- **A film still rendering when you quit is not resumed, and leaves no card.** A film's own
  state is not part of the project, so a leg in flight has nothing to come back to and is
  deliberately not recorded. A leg that had already finished leaves its MP4 on disk unused.
  A film that fully assembled is on the track by then, and persists like any other clip.
- **A moved file is indistinguishable from a deleted one.** Nothing tracks media identity
  beyond the absolute path, so re-importing is the way back.
- **A project file is machine-local.** It stores the absolute paths of your media, and
  generated clips live in SolCut's own data directory, so a `.solcut` opened on another
  machine restores as a full timeline of missing media. Moving or renaming one *on the same
  machine* is fine — the file is the project, and its name is the project's name.
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
