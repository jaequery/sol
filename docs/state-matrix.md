# SolCut — UI state matrix

Every state the editor must handle, the trigger that produces it, what the user sees, and the way out.
Design direction: **Concept 1 — Midnight Studio** (approved). Each row has a corresponding frame in the
hi-fi walkthrough artifact.

## 1. Project / import

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 1 | **Empty (first run)** | App opened, no media | Timeline shows a dashed drop zone with "Drop photos and videos here"; bin shows an import CTA; inspector shows "Nothing selected" | Drop a file, or click Import |
| 2 | **Drag-over** | OS file drag enters the window | Timeline drop zone lights up in accent; a vertical insertion marker shows where the clip will land; a count badge shows how many files are being dropped | Drop, or drag out |
| 3 | **Importing (loading)** | Files dropped / picked | Skeleton tiles animate in the media bin; the timeline shows a ghost clip at the insertion point; the rest of the UI stays interactive | Resolves to 4, or to 5 |
| 4 | **Imported (success)** | Probe succeeded | Clips appear on the single timeline in drop order, laid end to end from the drop boundary — anything already at or after it ripples along; first new clip is selected | — |
| 5 | **Unsupported / unreadable file** | Probe failed or MIME not in the allowlist | Inline error row in the bin naming the file and the reason; other files in the same drop still import | Dismiss, or re-import |
| 6 | **Media offline** | Source file moved/deleted after import | Clip renders hatched with a "media offline" badge; preview shows the reason; export is blocked with a pointer to the clip | Remove the clip and re-import (there is no relink) |
| 6a | **Bin has media** | One or more imports succeeded | The bin head keeps a **+ Import** button whatever the bin holds, so a second import never depends on the empty state's CTA | Click + Import |
| 6b | **Media removed** | ✕ on a bin tile | The tile goes, and so do that asset's clips on the timeline — a clip with no media could only ever render as "media offline". Any in-flight generation on those clips is cancelled, the selection falls back to nothing, and the playhead clamps to the shorter timeline. Emptying the bin returns it to state 1 | Re-import |

## 2. Selection

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 7 | **Nothing selected** | First run, or the selected clip was deleted | Inspector shows an explanatory empty state, not a blank panel. The 🗑 button and the Delete key are both dark — as they also are on a selected **cut**, which is a place rather than a thing and has nothing to delete. *(Clicking anywhere on the timeline — ruler, bare track, clip, or lane — cues the playhead; it does not clear the selection.)* | Select a clip |
| 8 | **Video clip selected** | Click a video clip | Inspector shows clip info + trim; there is nothing AI to offer on a plain video | Select a photo, or a cut |
| 9 | **Photo clip selected** | Click a photo clip | Inspector shows clip info and a hint pointing at the ✦ chip: put another photo beside it and bridge the cut with an AI transition (section 8) | Select a cut |

## 3. Generation (Higgsfield)

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 13 | **No CLI** | Generate clicked with no Higgsfield CLI found on the machine | Inline callout in the cut card: "Connect Higgsfield to generate" + Open settings; nothing is sent | Install the CLI (`npm i -g @higgsfield/cli`) and sign in (`higgsfield auth login`) |
| 14 | **Settings dialog** | Open settings | CLI status (found + path, or the three setup commands) and the custom model id (what the render cards’ Custom entry sends, first focused); Test connection reports pass/fail inline in the CLI's own words | Save / Cancel / Escape — Escape discards, exactly as Cancel does |
| 15 | **Queued** | Job accepted by the API | The cut's ✦ chip becomes the progress surface reading ◐ QUEUED; the inspector shows the job id | Cancel |
| 16 | **Running (partial/slow)** | Poll returns progress | The chip shows a live percentage; **the rest of the app stays fully usable** — you can select other clips, edit the track, start a second generation | Cancel, or wait |
| 17 | **Slow (> 90 s)** | Still running past the soft threshold | The card adds "Taking longer than usual — you can keep editing"; no spinner-lock, no modal | Cancel, or wait |
| 18 | **Failed — rate limited (429)** | API returns 429 | The chip turns error-red with "Rate limited"; inspector shows the message and a Retry (with the same prompt preserved) | Retry / dismiss |
| 19 | **Failed — not signed in** | The CLI's login expired or no billing workspace is selected | Same error affordance, message carries the CLI's own fix (`higgsfield auth login`, `hf workspace set …`) | Run the named command, retry |
| 20 | **Failed — network / timeout** | Transport error | Same error affordance with the transport reason | Retry |
| 21 | **Succeeded** | Poll returns a video URL and the download completes | The generated clip lands at its cut on the timeline, carries an "AI" badge, and is immediately playable in the preview | Play, or regenerate |

## 4. Playback / export

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 21a | **Cued by click** | Click or press-and-drag anywhere along the timeline — the ruler (dragging scrubs), the bare track, a gap, a clip, or an audio lane | The playhead jumps to exactly the clicked time and the preview shows that frame, so play runs from the clicked point; a click on a clip or a sound also selects it. During playback a click keeps playing from the new point. A drag or a chip press never seeks | Space / ▶
| 22 | **Playing** | Space / play | Playhead sweeps; transport shows pause; the preview plays the single track as one continuous piece, photos held covering the frame. Space only reaches the transport when the focus is not on a control — a focused button gets its own keypress — and not at all while a scrim dialog is up. Play is live whenever the timeline has any length, sound included | Pause |
| 23 | **Exporting** | Export MP4 | Modal with per-stage progress (normalising clips → concatenating → finalising). There is no cancel: **Close** and Escape dismiss the dialog while the render carries on, and Export MP4 reads "Exporting…" and stays dark until it lands, so a second encode cannot start | Close/Escape (the render continues), or finish |
| 24 | **Export succeeded** | ffmpeg exits 0 | Toast with the output path and "Reveal in folder" | Dismiss |
| 25 | **Export failed — ffmpeg missing** | `ffmpeg` not on PATH | Error dialog naming the missing binary and how to install it. Recognised from the failure, not pre-flighted — `ffmpegAvailable` is loaded but not yet consulted | Install, then Try again |
| 26 | **Export failed — encode error** | ffmpeg exits non-zero | Error dialog with the tail of ffmpeg's stderr (not copyable). **Try again** is offered only for failures a retry could change — a clip with no file on disk fails the same pre-check every time, so that case gets the explanation and no button | Try again, Close, or Escape |

## 5. Overflow / scale

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 27 | **Long timeline** | More clips than fit | Timeline scrolls horizontally; the ruler and playhead stay in sync; zoom control rescales | Zoom out |
| 28 | **Long file name** | Name wider than the clip | Name truncates with an ellipsis in the middle and keeps the extension; full name in the tooltip and the bin | — |
| 29 | **Very short clip** | Clip narrower than its label | Label and duration are dropped in favour of the thumbnail; the clip stays grabbable at a 12 px minimum, and under 32 px the two resize handles step aside so there is still something to grab for a move | Zoom in |
| 30 | **Long prompt** | Prompt longer than the textarea | Textarea scrolls at a fixed height (never pushes the Generate button off-panel) | — |
| 31 | **Many generations** | Several jobs at once | Each cut's chip shows its own progress; the title bar shows an aggregate "n rendering" chip | — |

## 6. Direct manipulation on the track

A clip carries the time it starts at (`startMs`) and its length (`durationMs`/`trimStartMs`) — these
states are the ways a user edits those numbers by hand rather than by re-importing or splitting.
Placement is free: a clip goes wherever it is dropped, and the track may have holes in it. The one
thing a single track cannot do is show two clips at once, so an edit that would overlap slides the
other clip along instead of stacking on it.

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 33 | **Idle clip** | Pointer over a clip | The body takes a grab cursor; a bar appears at each edge with a resize cursor. On a clip under 32 px wide the bars are omitted — they would cover the whole thing | Press, or move away |
| 34 | **Moving** | Press a clip body and travel ≥ 4 px | The clip is drawn at the spot it would land on, lifted off the track, so the drop is previewed exactly — including the gap it leaves behind. It cannot start before 0:00 | Release to drop; dropping it back where it started is a no-op |
| 34a | **Dropped on another clip** | Released overlapping a clip | The dropped clip keeps the spot and the clip under it walks right just far enough to clear it, cascading if that pushes into a third. Gaps elsewhere are left alone | Drag either clip again |
| 34b | **Snapping aid** | **⇥ Snap** on (the default), drop within 8 px of an edge | The drop lines up exactly with that edge — another clip's start or end, a sound's, the playhead, or 0:00. Switched off, a drop lands precisely where it was released | Toggle ⇥ Snap |
| 34c | **Gap on the track** | Any drop or trim that leaves empty track | The track simply shows the panel behind it; the preview reads that stretch as black with a "GAP" label, playback runs through it, and the export renders it as black, silent film | Move a clip into it |
| 35 | **Press without travel** | Press and release under the threshold | Nothing moves; the press is a plain selection, exactly as before | — |
| 36 | **Resizing** | Drag either edge handle | The clip's new length is previewed live. A tail growing into the next clip pushes it along; a shrinking tail leaves a gap rather than dragging anything back. A video's `trimStartMs` walks with its head, and the head moves the clip's own start so its tail stays on the frame it was on | Release |
| 37 | **Resize refused at a limit** | Dragging past a bound | The edge simply stops: a video cannot pass the first or last frame of its source (nor grow at all before its length is probed), a clip cannot go under 100 ms, a photo cannot pass 10 minutes, and a head cannot be pulled back past 0:00 or past the clip in front of it | Drag the other way |
| 38 | **Moving or trimming without a mouse** | Clip or handle focused, ← / → | The same edit at 100 ms a press, or 1 s with Shift — the body slides the clip, a handle moves that edge | Tab away |

## 7. Audio lanes

A sound is not a clip: it lives on its own lane below the track and never moves anything on it.
Placement works the same way as a clip's — dropped where it was released, snapping aid included.
Each lane holds one sound.

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 39 | **Audio added** | ♪ Add audio in the toolbar, or an audio file dropped on the timeline | A new lane appears under the track with the sound on it — at the playhead for the toolbar, at the drop point for a drop; the sound is selected and the inspector shows its card | Drag, trim, or delete it |
| 40 | **Unsupported audio file** | A file no lane can play (e.g. `.aiff`) | The same inline error row as state 5, naming the file and the accepted formats; nothing is added | Dismiss, or re-import |
| 41 | **Moving a sound** | Press its body and travel ≥ 4 px | The sound rides with the cursor along its lane — position previews live; it cannot start before 0:00. Arrow keys nudge it without a mouse | Release |
| 42 | **Trimming a sound** | Drag either edge | Like a video: the head walks the in-point so the sound stays on the samples it was on, the tail cannot pass the end of the source, and nothing grows before the length is probed | Release |
| 43 | **Muted lane** | 🔇 on the lane or the inspector | The lane dims and struck through; it is silent in preview and left out of the export entirely | Unmute |
| 44 | **Sound outlasts the visuals** | A lane's end passes the last clip | The ruler and playback extend to the end of the sound, so it is still heard; the *export* is the film's length, and the sound is cut there | Trim, or move it |
| 45 | **Audio media offline** | Source file gone since import | The lane block turns red with "media offline"; export is blocked with a pointer to the file | Re-import, or remove |

## 8. AI transitions

A ✦ chip stands on every cut between two **photos** side by side on the track — edges
touching, or with a gap the user dragged open between them, which is exactly where a
transition goes: the render fills it. The chip only ever
*selects* its cut — generation (a paid Higgsfield call) fires exclusively from the cut
card's button, ✦ Animate all, Retry, or Regenerate, so a stray click can never spend
credits and staleness never re-renders on its own.

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 46 | **Idle chip** | Two photos sit side by side on the track — edge to edge, or with a gap between them | A small ✦ chip vertically centred on the shared edge, or floating in the middle of the gap (its tooltip names the gap's length); the toolbar shows ✦ Animate all · n when at least one cut is fillable | Tap the chip, or Animate all |
| 47 | **Chip disabled (media offline)** | A photo on the cut lost its source file | The chip dims with the reason in its tooltip; nothing can be sent for a frame that cannot be rendered | Re-import the photo |
| 48 | **Cut selected** | Chip tapped | The chip takes the accent ring; the inspector shows the transition card naming both photos, an *optional* prompt (empty means the default `Smooth cinematic motion transition`), suggestion chips, a model selector (default Seedance 2.5), and one ✦ Generate transition button | Generate, type first, or click elsewhere |
| 49 | **No CLI** | Cut selected with no Higgsfield CLI found | The card's button is replaced by the "Connect Higgsfield to generate" callout; nothing is sent | Install and sign in to the CLI |
| 50 | **Queued** | Generate pressed, job accepted | The chip widens into a dashed mono pill reading ◐ QUEUED — the cut has no width on the track, so the chip itself is the progress surface; the title bar counts the render | Cancel, or wait |
| 51 | **Running** | Poll returns progress | The pill shows ◐ n% (or elapsed seconds when the API reports no percentage); **the rest of the app stays fully usable** | Cancel, or wait |
| 52 | **Slow (> 90 s)** | Still running past the soft threshold | The pill takes an amber tint and the card adds the calm "taking longer than usual" advisory — no modal, no lock | Cancel, or wait |
| 53 | **Failed** | API error / rate limit / transport | The pill turns rose reading ✕ FAILED; the card explains and offers Retry (same cut, kept prompt) and Dismiss (timeline exactly as it was) | Retry, or dismiss |
| 54 | **Succeeded — inserted at the cut** | Render downloaded | The MP4 is inserted *at the cut* as a normal video clip with the ✦ AI badge, provisionally 5 s and probe-corrected to its real length. It starts where the left photo ends and the right photo comes to rest flush against its tail — a gap the user dragged open for it is consumed, not left as black — so the reel grows by the render's length minus the gap's; the chip disappears structurally (the boundary is no longer photo→photo), and both remaining cuts keep their chips | Play, edit, or fill the next cut |
| 55 | **Transition selected** | Click the generated clip | The AI transition card: From/To photos, editable prompt, ⟳ Regenerate. Trim, drag and delete work exactly as for any video clip | Regenerate, edit, or leave it |
| 56 | **Stale** | A source photo was replaced, or a different clip now stands beside the transition | The clip wears an amber `⟳ SOURCES CHANGED` tag and the card says why; it still plays and exports. Nothing regenerates — or costs — on its own | One-tap Regenerate (uses the *current* neighbours), or ignore |
| 57 | **Orphaned** | A source photo was deleted, or a neighbour is no longer a photo | Amber `⟳ SOURCE MISSING` tag; Regenerate is disabled with the reason. The paid clip is kept — it renders and exports fine | Delete it for a hard cut, or leave it |
| 58 | **Transition deleted** | 🗑 / Delete on the clip | No confirm (the app has none anywhere, and no undo): the clip goes, the photo→photo cut — and its ✦ chip — structurally reappear, and the MP4 asset stays in the bin and on disk. Re-inserting means regenerating (a re-spend) | Regenerate from the chip |
| 59 | **Animate all** | ✦ Animate all · n in the toolbar | Every fillable cut queues; submissions go out strictly one at a time (a burst could trip the rate limit and strand half the batch), each chip showing its own state as its turn comes. A queued cut that went invalid is skipped, never stalled on | Wait, or keep editing |
| 60 | **Timeline moved mid-render** | The pair was reordered/deleted while rendering | The finished clip is **not** inserted somewhere wrong: a toast explains ("Transition finished, but its photos moved"), the new cuts show fresh chips, and the MP4 stays in the cache | Tap the ✦ on the new cut |

## 9. Film — three photos, two transitions

The film is nothing but the AI transitions between the three photos
(photo 1 → 2, photo 2 → 3), concatenated. A leg is an ordinary generation and is counted by
the title bar's "n rendering" chip like any other — what is different is where its result
goes. A film's clips are held back until every leg has landed, so a failed leg never leaves
half a film on the track; when the last one does land the film puts *itself* on the track,
in one piece, and the only thing left between three photos and an .mp4 is the save dialog.

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 61 | **Film idle** | Three photos chosen | Each leg carries a prefilled, editable prompt; nothing has been sent | Start, or edit a prompt |
| 62 | **Film refused — no CLI** | Start with no Higgsfield CLI found | An error toast pointing at settings. No film is created and nothing is sent — there is no local renderer to fall back to | Install and sign in to the CLI |
| 63 | **Film running** | Both legs queued | Each leg shows its own status and progress; the film shows a combined bar and its own count | Cancel, or wait |
| 64 | **Leg landed, film unfinished** | One leg succeeded | The finished MP4 is **parked in film state, not placed on the timeline**; the film still reads "1 of 2 succeeded" | Wait for the other leg |
| 65 | **Film partial — a leg failed** | A leg returns an error | The failed leg carries the API's own message (rows 18–20) and a retry that re-runs **only** that leg; the leg that landed keeps its file | Retry the leg, or dismiss |
| 66 | **Film cancelled** | Cancel a running film | Legs in flight go `cancelled` — polling stops, the request already with the API is not recalled, exactly as a single cancel does. A leg that already rendered keeps its file | Retry a leg, or dismiss |
| 67 | **Film succeeded** | Every leg in | The film goes onto the track **by itself, in one piece and in segment order** — whichever leg came back first — each clip badged AI and immediately playable. It is appended at the end of whatever is on the track *at that moment*, because the editor stayed usable while it rendered | Play, or export |
| 67a | **Assembling** | The last leg's file is being measured | The brief gap between "both transitions are in" and the clips appearing: the finished MP4 is probed for its real length first, so the clips land at the length the file actually is. The panel says "putting them on the timeline…" and offers no export yet | Resolves to 67 |
| 67b | **Assembled once** | A leg completes again after the film has landed — a retry, or a repeated update | Nothing new is placed. The film records which clips are it, and those clips are then ordinary timeline clips: moving, trimming or deleting them is an edit, not an invitation to lay the film down twice | — |
| 67c | **Film exported** | **Export film** in the panel | The ordinary export path (rows 23–26): the save dialog, then ffmpeg at **H.264 1920 × 1080 30 fps**, then the toast naming the file with **Reveal**. It writes the *timeline*, which after 67 is the film — plus anything else the user put there | Reveal, or dismiss |

## 10. The 3-image film wizard

The chrome over section 9: how three photos get chosen, ordered, prompted and watched. The
panel is deliberately **not modal** — a film takes minutes and the editor behind it stays
live — so it floats, closing it only hides it, and stopping a render is the explicit Cancel
rather than a side effect of getting the panel out of the way. Rows 68–83 are the wizard's
own states; what the film underneath is doing is rows 61–67c.

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 68 | **Two ways in** | App running | **✦ New film from 3 photos** sits in the title bar, and again inside the empty timeline's drop zone next to "Drop photos, videos and audio here". Both open the same panel | Click either |
| 69 | **Wizard open, nothing chosen** | Either entry action | A floating panel: a "Drop three photos here" zone with a **Choose photos** button, three numbered empty slots, and the two transition prompts already filled in | Choose photos, drop, or Close |
| 70 | **Drag-over the wizard** | OS file drag over the drop zone | The zone lights up in accent, exactly as the timeline's does | Drop, or drag out |
| 71 | **Under three photos** | 1 or 2 photos chosen | The empty slots stay visible and an inline reason reads "2 of 3 photos chosen — add 1 more."; **Generate film** is disabled | Add the rest |
| 72 | **A fourth photo offered** | More files dropped than slots | The extras are listed by name with the reason "a film takes exactly 3 photos, and three are already chosen"; the three that fit are kept | Dismiss, or remove one and re-add |
| 73 | **A non-photo offered** | A video or unsupported file dropped | Named inline with its own reason — a video reads "a film is made from three photos — a video cannot be one of them", anything else lists the photo extensions | Dismiss |
| 74 | **Reordering** | ↑ / ↓ on a filled slot | The slot swaps with its neighbour and the numbers follow: slot order *is* the film's running order, so it is what decides the two transition pairs | Move it back |
| 75 | **Removing a photo** | ✕ on a filled slot | The slot empties, the ones after it move up, and the panel falls back to row 71 | Add another |
| 76 | **Prompts** | Panel open | One editable textarea per transition, headed "Transition 1 · photo 1 → photo 2", pre-filled from `defaultFilmPrompt` — zero typing is required to generate | Edit, or leave as is |
| 77 | **Refused — no CLI** | No Higgsfield CLI found | A "Connect Higgsfield to generate" callout with **Open settings →**, and **Generate film** stays disabled. Nothing is imported and nothing is sent — there is no local renderer to fall back on. In a plain browser the same callout says rendering needs the desktop app | Install and sign in to the CLI |
| 78 | **Ready** | Exactly 3 photos and the CLI found | **Generate film** enables. Pressing it imports the three photos into the media bin — **assets only, nothing on the track**, because a film's material is the transitions and the photos are inputs — then starts both legs | Generate, or Close |
| 79 | **Import refused** | The backend will not take one of the files | The panel keeps the run view out and shows "The film could not start" with the backend's own per-file reason; no film is created | Remove the file, retry |
| 80 | **Watching the run** | A film is under way | The panel switches to the run view: the three photos as a strip, a combined bar with "n of 2 succeeded", and a row per leg with its own status, bar, error (rows 18–20) and **Retry this transition**. The editor behind it stays fully usable, and the title bar's "n rendering" chip counts the legs | Cancel film, or Close (the film keeps running) |
| 81 | **Reopening mid-film** | Entry action clicked while a film runs | The same panel comes back on the in-flight run, not on a fresh intake — one film at a time, and the panel says so | Cancel film, or wait |
| 82 | **Run finished — whole** | Every leg in and placed (row 67) | The panel says **On the timeline — 2 transitions · 10.0s** and offers **Export film**, which is the title bar's export reached from where the user already is (row 67c). **Start over** forgets the film and returns the panel to row 69 | Export film, start over, or Close |
| 83 | **Run finished — a leg short** | The run stopped with a leg failed or cancelled | No export is offered at all — there is nothing whole to write — and the panel keeps the failed leg's message and **Retry this transition** (row 65). Retrying and succeeding finishes the film, which then places itself | Retry the leg, or start over |
