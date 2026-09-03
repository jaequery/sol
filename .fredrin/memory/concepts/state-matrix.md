# SolCut — UI state matrix

Every state the editor must handle, the trigger that produces it, what the user sees, and the way out.
Design direction: **Concept 1 — Midnight Studio** (approved). Each row has a corresponding frame in the
hi-fi walkthrough artifact.

## 1. Project / import

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 1 | **Empty (first run)** | App opened, no media | Timeline shows a dashed drop zone with "Drop photos, videos and audio here"; bin shows an import CTA; inspector shows "Nothing selected" | Drop a file, or click **+ Import** in the bin |
| 2 | **Drag-over** | OS file drag enters the window | Timeline drop zone lights up in accent; a vertical insertion marker shows where the clip will land; a count badge shows how many files are being dropped | Drop, or drag out |
| 3 | **Importing (loading)** | Files dropped / picked | Skeleton tiles animate in the media bin; the timeline shows a ghost clip at the insertion point; the rest of the UI stays interactive | Resolves to 4, or to 5 |
| 4 | **Imported (success)** | Probe succeeded | Clips appear on the single timeline in drop order, laid end to end from the drop boundary — anything already at or after it ripples along; first new clip is selected. A video lands at a provisional 5 s, because decoding it first would make the import feel broken, and its real length arrives a beat later: the reel **closes up behind the correction** rather than leaving black where a file was shorter than the guess, or two clips on one instant where it was longer. A length the user has typed or trimmed in that window is theirs and is not overwritten | — |
| 5 | **Unsupported / unreadable file** | Probe failed or MIME not in the allowlist | Inline error row in the bin naming the file and the reason; other files in the same drop still import | Dismiss, or re-import |
| 6 | **Media offline** | Source file moved/deleted after import | Clip renders hatched with a "media offline" badge; preview shows the reason; export is blocked with a pointer to the clip | Remove the clip and re-import (there is no relink) |
| 6a | **Bin has media** | One or more imports succeeded | The bin head keeps a **+ Import** button whatever the bin holds, so a second import never depends on the empty state's CTA | Click + Import |
| 6d | **Two ways media gets in** | Any state | Beside + Import the bin head carries **✦ Generate**, which opens the compose panel (section 12). Importing is untouched by it: the two are separate actions on the same panel, and neither is behind the other. While the panel is open a tile is a reference picker rather than a drag source (row 6c stands down) | Click either |
| 6c | **Tile dragged out of the bin** | Press a bin tile and carry it over the track (or Enter on a focused tile) | The track lights in accent and the insertion marker shows where it will land, exactly as an OS file drag does. Releasing over the track adds the asset there — a photo or video at the boundary nearest the pointer, a sound on a new lane at the exact release point — as a **fresh copy**, so an asset can appear on the track as often as it is dragged. Enter adds it at the playhead. Released anywhere else, or taken back off the track, nothing is added. A tile whose file has gone (state 6) is not a source at all — it keeps its ✕ and nothing else | Drag it again, or delete the clip |
| 6b | **Media removed** | ✕ on a bin tile | The tile goes, and so do that asset's clips on the timeline — a clip with no media could only ever render as "media offline". Any in-flight generation on those clips is cancelled, the selection falls back to nothing, and the playhead clamps to the shorter timeline. Emptying the bin returns it to state 1 | Re-import |

## 2. Selection

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 7 | **Nothing selected** | First run, or the selected clip was deleted | Inspector shows an explanatory empty state, not a blank panel. The 🗑 button and the Delete key are both dark — as they also are on a selected **cut**, which is a place rather than a thing and has nothing to delete. *(Clicking anywhere on the timeline — ruler, bare track, clip, or lane — cues the playhead; it does not clear the selection.)* | Select a clip |
| 8 | **Video clip selected** | Click a video clip | Inspector shows clip info, with **Duration** editable in seconds (state 38a), and the same hint a photo gets: put another clip beside it and bridge the cut with an AI transition (section 8) | Select a cut |
| 9 | **Photo clip selected** | Click a photo clip | The same card, plus a hint pointing at the ✦ chip: put another clip beside it and bridge the cut with an AI transition (section 8) | Select a cut |

## 3. Generation (Higgsfield, or a local backend)

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 13 | **Backend not ready** | A render surface is showing a backend this machine cannot run. Asked of the **chosen** backend, not of Higgsfield — a machine with a coding-agent CLI and no Higgsfield can render perfectly well | Inline callout replacing the button. Higgsfield: "Connect Higgsfield to generate" + Open settings. A local backend that is not installed: "Install the Claude Code CLI to composite" with its `npm install` line to paste and **no** settings button — there is nothing to connect. No ffmpeg with a local backend chosen: "ffmpeg is needed to composite". Nothing is sent in any of them | Install what it named, then reopen the dialog or reselect the cut |
| 13a | **Local motion chosen** | The Model selector's second group — Claude Code CLI or Codex CLI | The same card and the same button. The agent CLI is asked, in one call, for a motion recipe (`{transition, duration_secs}`); ffmpeg composites it locally. There is no job id, so the inspector shows none, and Animate all runs one cut at a time rather than pipelining on a submit-ack it never gets. About two cents and ten seconds a cut | Generate, or pick a Higgsfield model |
| 14 | **Settings dialog** | Open settings | Three things, in order: CLI status (found + path, or the three setup commands); the **API key** — id + secret, both masked and both starting empty, the id first focused, with a stored one showing only as a `••••7fa2` placeholder; and the custom model id (what the render cards’ Custom entry sends). Test connection reports the CLI's pass/fail in its own words | Save / Cancel / Escape — Escape discards, exactly as Cancel does |
| 14a | **API key checked** | Test key | Its own heading, never the CLI's: *API key accepted* (green) when the documented status route answers 404 to the credential, *API key rejected* on 401 quoting Higgsfield's `detail`, *Higgsfield refused the key* on 403 (an account that will not serve the call — usually an empty balance, not a bad key), *Could not prove the API key* for any other answer, and *Could not reach Higgsfield* for no answer at all. The key is proved from the boxes overlaid on what is stored, so it can be checked before it is saved; nothing is written and nothing is generated | Fix the key and check again, or Save / Cancel |
| 14b | **API key armed to be forgotten** | Forget key, offered only while one is stored | Both boxes clear, the hint reads "removed on Save", and the control retires itself. Typing into either box disarms it, so a forget and a new key can never both apply | Save removes it / Cancel keeps it |
| 15 | **Queued** | Job accepted by the API | The cut's ✦ chip becomes the progress surface reading ◐ QUEUED; the inspector's card is headed "Queued transition" and names the pair, the model and the job id (one line, the whole id on hover) | Cancel |
| 16 | **Running (partial/slow)** | Poll returns progress | The chip shows a live percentage; **the rest of the app stays fully usable** — you can select other clips, edit the track, start a second generation | Cancel, or wait |
| 17 | **Slow (> 90 s)** | Still running past the soft threshold | The card adds "Taking longer than usual — you can keep editing"; no spinner-lock, no modal | Cancel, or wait |
| 18 | **Failed — rate limited (429)** | API returns 429 | The chip turns error-red with "Rate limited"; inspector shows the message and a Retry (with the same prompt preserved) | Retry / dismiss |
| 19 | **Failed — not signed in** | The CLI's login expired or no billing workspace is selected | Same error affordance, message carries the CLI's own fix (`higgsfield auth login`, `hf workspace set …`) | Run the named command, retry |
| 20 | **Failed — network / timeout** | Transport error | Same error affordance with the transport reason | Retry |
| 21 | **Succeeded** | Poll returns a video URL and the download completes | The generated clip stands in the cut's stills' place on the timeline (or lands at the cut, when the photos are kept or there was no still to take), carries an "AI" badge, and is immediately playable in the preview | Play, or regenerate |

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
| 38a | **Typing a length** | Type seconds into the inspector's **Duration** box and press Enter, or leave the box | The tail edit of state 36 without the gesture, and bounded by exactly the same walls (37): growing pushes what is behind it, shrinking leaves a gap. It is the one control in the app that does not commit as you type — `""`, `"."` and `"1"` are all on the way to `"12"` — and a value that is not a length at all (empty, `abc`, `-3`) is refused rather than guessed at, saying so instead of putting the old number back in silence. A length the track will not give comes back clamped, with one line naming the wall it hit. **Every one of those notes belongs to the length it was produced at** and retires the moment the element leaves it: a wall explained by a typed entry must not still be on screen after the user has answered it by dragging the handle somewhere else | Escape puts the box back; Enter or leaving it commits |

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
| 42a | **Typing a sound's length** | The inspector's **Duration** box on a selected lane | State 38a in full, on a lane — the box, the walls and the notes' lifetime are one behaviour shared by every element with edge handles, never a per-type reimplementation. What differs is only what a lane is: the tail edit only, so the sound stays where it was put, clamped to the file behind it, and no lane pushes another — they float free and may overlap | Escape puts the box back; Enter or leaving it commits |
| 43 | **Muted lane** | 🔇 on the lane or the inspector | The lane dims and struck through; it is silent in preview and left out of the export entirely | Unmute |
| 44 | **Sound outlasts the visuals** | A lane's end passes the last clip | The ruler and playback extend to the end of the sound, so it is still heard; the *export* is the film's length, and the sound is cut there | Trim, or move it |
| 45 | **Audio media offline** | Source file gone since import | The lane block turns red with "media offline"; export is blocked with a pointer to the file | Re-import, or remove |

## 8. AI transitions

A ✦ chip stands on every cut between two clips side by side on the track — photo to photo,
video to video, or one of each; edges touching, or with a gap the user dragged open between
them. Each side gives up the frame at the cut: a photo *is* that frame, and a video's is
pulled off the file (with ffmpeg, so it matches what the export renders) at the exact point
the clip runs out or begins, trims included. A transition that has already landed is footage
like any other, so the boundaries on either side of it are cuts too — a landed render is
exactly the thing a user may want to run on into the next clip. That stands a chip beside
every landing; the chip only ever selects, so it costs nothing until Generate is pressed.

Where the finished render lands follows what is on the cut, because only a **still** can be
stood in for. Between two photos it **stands in the pair's place** by default: both leave
the track (staying in the media bin) and the span plays as pure motion, never padded by
stills. Beside real footage the same pick takes **only the photo**; the video keeps its span
and its trim. Between two videos there is no still at all, so the pick is not offered —
absent from the card rather than shown disabled — and the render lands between them. A quiet
per-cut action keeps the photos and inserts the clip between them instead, which is also how
a dragged-open gap gets filled. The chip only ever *selects* its cut — generation (a paid
Higgsfield call) fires exclusively from the cut card's button, ✦ Animate all, Retry, or
Regenerate, so a stray click can never spend credits and staleness never re-renders on its
own.

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 46 | **Idle chip** | Two clips sit side by side on the track — any kinds, landed transitions included, edge to edge or with a gap between them | A small ✦ chip standing in the gutter above the clip band, its foot on the shared edge — or on the middle of the gap (its tooltip names the gap's length) — so it never covers a clip's name; the toolbar shows ✦ Animate all · n counting the **photo-to-photo** cuts only | Tap the chip, or Animate all |
| 46a | **Cut with a transition side** | A landed transition beside any clip — a render then a photo, touching, or a gap the user has dragged open since it landed | The same chip and the same card. The render is a video here: its last (or first) frame is pulled off its file at the cut. A photo on the other side keeps the landing pick and is the only thing consumed; beside footage or another render there is no pick and the clip lands between them. Regenerate on a kept-frames clip reads a transition neighbour exactly as it reads any other clip | Generate, or click elsewhere |
| 47 | **Chip disabled (media offline)** | A clip on the cut lost its source file | The chip dims with the reason in its tooltip; nothing can be sent for a frame that cannot be rendered | Re-import the clip |
| 48 | **Cut selected** | Chip tapped | The chip takes the accent ring; the inspector shows the transition card naming both clips, a hint stating the outcome, an *optional* prompt (empty means the default `Smooth cinematic motion transition`), suggestion chips, a model selector (default Seedance 2.5, with a second group offering the **local motion** backends), and one ✦ Generate transition button. Beneath the button, a quiet text action toggles "keep the photo(s) on the track" per cut, remembered like its prompt — **absent entirely between two videos**, which have no still to stand in for | Generate, type first, or click elsewhere |
| 48a | **Cut selected — video on one or both sides** | Chip tapped on a cut with video | The same card. With a photo on the other side the landing pick stands, in the singular, and applies to that photo alone. With video on both sides there is no pick, and the hint says the clip lands between them. A video side needs ffmpeg on `PATH`; without it the render fails at submission and says so | Generate, or click elsewhere |
| 49 | **Backend not ready** | Cut selected while the Model selector shows a backend this machine cannot run | The card's button is replaced by the callout of state 13, which names the backend that is actually missing rather than always blaming Higgsfield | Install what it named, or pick a backend that is ready |
| 50 | **Queued** | Generate pressed, job accepted | The chip widens into a dashed mono pill reading ◐ QUEUED — the cut has no width on the track, so the chip itself is the progress surface; the title bar counts the render | Cancel, or wait |
| 51 | **Running** | Poll returns progress | The pill shows ◐ n% (or elapsed seconds when the API reports no percentage); **the rest of the app stays fully usable** | Cancel, or wait |
| 52 | **Slow (> 90 s)** | Still running past the soft threshold | The pill takes an amber tint and the card adds the calm "taking longer than usual" advisory — no modal, no lock | Cancel, or wait |
| 53 | **Failed** | API error / rate limit / transport | The pill turns rose reading ✕ FAILED; the card explains and offers Retry (same cut, kept prompt) and Dismiss (timeline exactly as it was) | Retry, or dismiss |
| 54 | **Succeeded — stands in the stills' place** | Render downloaded | The MP4 lands where the consumed span started and **every still on the cut leaves the track** (staying in the media bin), provisionally 5 s and probe-corrected to its real length; everything after shifts by the difference between the render and the span it replaced, so gaps further along keep their shape. **No black is left touching the render**: the clip behind it comes to rest against its tail — everything past that one moving with it, so their own spacing is kept — and the render comes back to meet the clip in front, because a transition is continuous film from one frame to the other and black beside it is the thing it was bought to remove. Black with no clip on the far side of it, at the head or the tail of the reel, is not a seam and stays. The same is true of a regeneration: a fresh file may not stand behind black just because the one it replaced did. The clip wears both sources side by side — footage as footage, a still as a still — plus the ✦ AI badge. Between two photos both go and the reel no longer carries their 10 s; beside a video only the photo goes and the footage keeps its span and trim; between two videos nothing is consumed at all. With **keep the photos** picked, the MP4 is instead inserted *at the cut*: it starts where the left clip ends and the right one comes to rest flush against its tail — a gap dragged open for it is consumed, not left as black — so the reel grows by the render's length minus the gap's. Either way the boundaries on each side of the landing are cuts of their own, with chips of their own, and the remaining cuts keep theirs. A transition that ran into the clip the landing stood in for — or into the far clip of the cut itself — now meets the landing on that very frame, and its record follows, so it does not go stale | Play, edit, or fill the next cut |
| 55 | **Transition selected** | Click the generated clip | The AI transition card: From/To sources, editable prompt, ⟳ Regenerate. Trim, drag and delete work exactly as for any video clip | Regenerate, edit, or leave it |
| 56 | **Stale** | A different clip now stands beside a kept-photos transition, or a video source was trimmed under one | A kept-photos (insert) clip goes stale by its neighbours: it wears an amber `⟳ SOURCES CHANGED` tag and the card says why; it still plays and exports. A clip standing in the stills' place consumed them, so those say nothing — but a video side it did *not* consume is still on the track, and trimming it moves the very frame the motion was rendered from, which is stale too — as does regenerating it, when that side is itself a transition (same clip, new file). Three seams are continuous *by construction* and never flag: a landing beside a transition, a transition regenerated toward its neighbours, and the probe correcting a provisional length — each re-stamps the records it touches, so two adjacent renders never flag each other stale in turn. Nothing regenerates — or costs — on its own | One-tap Regenerate (reads each side as it stands *now*), or ignore |
| 57 | **Orphaned** | A source asset left the media bin (the default landing), or a kept-photos clip no longer has a clip on both sides | Amber `⟳ SOURCE MISSING` tag; Regenerate is disabled with the reason. The paid clip is kept — it renders and exports fine | Delete it for a hard cut, or leave it |
| 58 | **Transition deleted** | 🗑 / Delete on the clip | No confirm (the app has none anywhere, and no undo): the clip goes and the MP4 asset stays in the bin and on disk. A clip that stood in the stills' place leaves **empty track** where those stills were — re-drag them from the media bin to rebuild it; any footage it left alone is still standing, and the cut it now forms with its new neighbour gets a chip. Deleting a kept-photos clip makes the original cut — and its ✦ chip — structurally reappear. Re-inserting means regenerating (a re-spend) | Re-add the photos from the bin, or regenerate from the chip |
| 59 | **Animate all** | ✦ Animate all · n in the toolbar | Every fillable **photo-to-photo** cut queues — video cuts are deliberately left out, because one tap must not start a paid render at every boundary of a reel of footage; submissions go out strictly one at a time (a burst could trip the rate limit and strand half the batch), each chip showing its own state as its turn comes. Landings stay **between** their photos while the run lives — a replace landing would consume clips out from under the cuts still queued — a queued cut that went invalid is skipped, never stalled on, and the toolbar button stands down for the duration | Wait, or keep editing |
| 59a | **Animate all — run complete** | The queue has drained and every leg is terminal (landed, failed, cancelled, or swept) | The run collapses: every photo whose touching legs all landed leaves the track, spans closing behind them (media staying in the bin), and each landing is stamped as standing in its photos' place — the chain is pure motion, back to back. A failed or cancelled leg keeps its photos, as does a landing the user deleted or split mid-run. A toast counts what landed | Play, export, or retry the kept cuts |
| 60 | **Timeline moved mid-render** | The pair was reordered/deleted while rendering | The finished clip is **not** inserted somewhere wrong: a toast explains ("Transition finished, but its clips moved"), the new cuts show fresh chips, and the MP4 stays in the cache | Tap the ✦ on the new cut |

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
| 68 | **No way in** | — | The panel has no entry point in the UI. The title bar's button was removed first, the empty timeline's call to action second, and nothing replaced either — so rows 69–83 are reachable only from `openFilmWizard` in the store, which is how a running film reopens its own panel | — |
| 69 | **Wizard open, nothing chosen** | `openFilmWizard` | A floating panel: a "Drop three photos here" zone with a **Choose photos** button, three numbered empty slots, and the two transition prompts already filled in | Choose photos, drop, or Close |
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
| 81 | **Reopening mid-film** | The panel reopened while a film runs | The same panel comes back on the in-flight run, not on a fresh intake — one film at a time, and the panel says so | Cancel film, or wait |
| 82 | **Run finished — whole** | Every leg in and placed (row 67) | The panel says **On the timeline — 2 transitions · 10.0s** and offers **Export film**, which is the title bar's export reached from where the user already is (row 67c). **Start over** forgets the film and returns the panel to row 69 | Export film, start over, or Close |
| 83 | **Run finished — a leg short** | The run stopped with a leg failed or cancelled | No export is offered at all — there is nothing whole to write — and the panel keeps the failed leg's message and **Retry this transition** (row 65). Retrying and succeeding finishes the film, which then places itself | Retry the leg, or start over |

## 11. The saved project

The editor autosaves the open project and puts it back at launch. Three things trigger a
write: a change to the document (debounced half a second, and at least every five seconds
through a continuous gesture), a five-second heartbeat while anything is still unwritten,
and the window closing, which is held open for one last write. Which project is open, and
how that changes, is section 13.

Autosave used to be deliberately invisible. It is not any more: one dim word sits beside the
project's name and says which state it is in — **Saving…**, **Saved**, **Not saved** — in
`--ink-3` for the first two and `--err` for the last. Nothing at all is shown until the
session's first write has actually landed, because a bar claiming "Saved" over a project
nothing has written is the exact lie the indicator exists to stop telling; `saveBlocked` is
checked ahead of everything else for the same reason.

What is saved is the **document** — the media bin's paths, the clips, the audio lanes and
prompts typed at a cut — plus two things about *where you were*:

- **The viewport**: playhead, zoom and the snap toggle. It never triggers a write of its own
  (the playhead moves sixty times a second during playback); it rides along with the next
  document write, the heartbeat, or the close.
- **A render still in flight**: its target, prompt and model, and nothing that belonged to
  the process — no job id, no progress. It comes back as row 92b below.

What is still **not** saved: a film, the selection, an unsent prompt draft, dialogs and
toasts. A finished AI transition is an ordinary clip by then, so it comes back with
everything else.

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 84 | **Restored** | App opened with a project stored | The last session's timeline, lanes and media bin, exactly as they were left — and at the playhead, zoom and snap setting it was left at. Nothing announces it; the title bar names the project and shows no save state until the session's first write lands. A project stored before viewports were saved simply keeps the zoom the user is already working at | Keep editing |
| 85 | **Nothing stored** | First ever launch, or the last session ended empty | Row 1, unchanged: the empty drop zone. No message, because nothing was lost | Drop a file |
| 86 | **Media gone since last time** | A restored file is no longer at its path | The project still restores whole. One toast names up to three files and counts the rest; each tile in the bin dims and its tooltip gives the path; the preview over that clip reads **MEDIA OFFLINE** (row 5) and export refuses by name rather than dying inside ffmpeg | Re-import the file and put it back on the track |
| 86a | **Saving** | A write is on the wire | **Saving…** beside the project name, in `--ink-3`. Not a live region: an always-announced one would read "Saving… Saved" at every debounce | Nothing to do |
| 86b | **Saved** | A write has landed this session | **Saved**, in `--ink-3`, with the time of the last write in its tooltip. Before the first write of a session there is nothing here at all | Nothing to do |
| 87 | **Saving failed** | The write was refused — disk full, permissions | One toast with the reason, then a persistent **Not saved** in the title bar beside the project name, in `--err`, whose tooltip repeats the reason. The heartbeat keeps retrying on its own, so it clears itself the moment a write succeeds — no edit required | Fix the disk; it retries itself |
| 87a | **Not saving at all** | The open project is one this build must not overwrite (rows 89, 90, 92) | The same **Not saved** chip, with a tooltip saying the project is left untouched. A session that is writing nothing has to say so, and this is the only place it can | Save as… or open another project — either one turns saving back on |
| 88 | **Project unreadable** | The stored file is not a project this build knows | A toast — "The saved project could not be read. Starting empty. Anything you do now replaces it." The editor opens empty and saving stays **on**: this build owns that file, and being able to replace it is the only way out of a bad one | Keep working; the next edit overwrites it |
| 89 | **Project from a newer SolCut** | The stored file's version is ahead of this build's | A toast saying so, an empty editor, and saving stays **off for the session** — overwriting it would destroy work a later build can still open | Update SolCut |
| 90 | **The project could not be read at all** | The read itself failed | Same refusal as row 89: nothing is written this session, because what is on disk may be perfectly good and unreadable only right now | Restart, or fix the permissions |
| 91 | **Edited before the restore landed** | A file dropped in the moment between launch and the read returning | The user's edit wins and stays on screen, but nothing is written over the stored project, and a toast says both | Restart SolCut to get the saved project back |
| 92 | **Last project would not open** | The remembered project is gone, unreadable, or from a newer build | An empty editor that *still names that project* in the title bar, with **Not saved** beside it and a toast saying so. It does **not** fall back to the untitled scratch: that would clear the only pointer to a file which may be sitting on an unplugged drive, and overwrite whatever untitled work the scratch holds | Plug the drive back in and relaunch, or open another project |
| 92a | **Leaving a session that never saved** | New/Open from any blocked session (rows 89–92) with work in it | The same save/discard question row 103 asks of untitled work. Having a *path* is not having somewhere to go: a blocked session is pointed at a file it must not touch, so its work has been written nowhere at all and a silent switch would take the untitled scratch with it | Save as…, Discard, or Cancel |
| 92b | **A render interrupted by the restart** | The app closed while a generation was in flight | It comes back as an ordinary failed card — a red **✕ FAILED** chip on its cut, or a card at the top of the media bin for a photo — reading **Interrupted**: *"SolCut closed while this was rendering. Nothing was sent again — Retry to start it over."* **Retry** and **Dismiss**, exactly as any failure. Nothing re-submits itself, and the bar's "n rendering" count stays at zero. It is written down only while the render is actually running, so the report is made once and the next save lets it go | Retry, or Dismiss |
| 92c | **A film leg interrupted** | The same, for a leg of a three-photo film | Nothing. A film's own state is not part of the project, so a leg has nothing to come back to; the record is refused rather than restored into a card that could never act | Start the film again |

## 12. Generating a photo (the compose panel)

The media bin's other way in: describe a photo and Higgsfield makes it — from the prompt
alone, or **on top of** photos already in the bin, attached as references. It runs through
the same CLI, the same job loop and the same `generation:update` events as a transition,
so every generation state in section 3 applies here too; the rows below are only what is
particular to a photo.

The panel lives *inside* the bin rather than over it, because the bin is the reference
picker — covering the tiles would defeat the flow. The result lands in the bin and nowhere
else: the timeline is never edited on the user's behalf.

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 92 | **Closed** | Default | Nothing but the **✦ Generate** button in the bin head | Click ✦ Generate |
| 93 | **Composing** | ✦ Generate clicked | A prompt box (focused) spanning the bin's columns, one line of guidance, an **Options** disclosure and a full-width **✦ Generate image**. Model and aspect ratio are behind Options, closed — the default path is type, then Generate | Generate, Cancel, or Escape |
| 94 | **Draft kept** | Cancel or Escape while composing | The panel closes and the prompt, the references and the picks are still there when it reopens. Only a generation that actually went clears them | Reopen |
| 95 | **Picking references** | Panel open | Every usable bin photo becomes a toggle: an accent border and a number in click order. Its ✕ stands down while composing — removing is not this screen's task. Videos, audio, offline photos, and photos with no file on disk (a browser drop) are not offered at all, because they cannot be uploaded | Click a picked photo to take it off |
| 96 | **Reference limit** | The chosen model's cap is reached | Further photos simply do not attach; the hint reads "n of 14 references". Switching to a model with a smaller cap trims the picks to fit | Take one off |
| 97 | **Options open** | Options clicked | **Image model** (Nano Banana Pro, Seedream 4.5, FLUX.2, GPT Image 2) and **Aspect ratio**. The ratios follow the model — each publishes its own set — and a ratio the new model does not take is swapped for one it does, rather than sent and refused | Hide options |
| 98 | **Not connected** | No Higgsfield CLI on the machine | The panel refuses up front: **✦ Generate image** is dark and a callout says so with **Open settings →**. Nothing is sent (section 3's rule, at the bin) | Connect, or Cancel |
| 99 | **Nothing asked for** | The prompt is empty or blank | **✦ Generate image** is dark. A prompt is always required, even where a model would accept references alone | Type something |
| 100 | **Generating** | ✦ Generate image pressed | The panel closes and clears, and a shimmering tile joins the bin wearing ✦ and a ✕ — the same language an import already speaks. The editor stays fully usable, the title bar's "n rendering" chip counts it, and another photo can be asked for straight away | Wait, or ✕ to stop |
| 101 | **Cancelled** | ✕ on a generating tile | The tile goes. Uploading a dozen references takes minutes, so the cancel is honoured the moment the submission is answered rather than a poll later; the job runs out on Higgsfield's side and its result is dropped | — |
| 102 | **Failed** | The CLI or the job refused | An error row in the bin in the CLI's own words, with **Retry** (only when retrying could help) and **Dismiss**. The prompt and references are on the generation's record, so a retry re-sends exactly what the first attempt did — and a reference removed from the bin meanwhile is simply left out | Retry, or dismiss |
| 103 | **Landed** | The job completed and the file downloaded | A new photo tile in the bin, named after the file itself, and one **Photo ready** toast. **Nothing on the timeline moves** — drag it on when you want it, exactly like an import. It is an ordinary photo asset with a real path, so it persists like any other (section 11) | Drag it to the track |

## 13. Which project is open

The title bar's project name is the control: clicking it opens a menu of **New project**,
**Open project…** and **Save as…**. There is no plain Save, because autosave has already
done it — the only save that means anything is the one that decides *where*, so that is the
only one offered.

A project that has a file is an ordinary `.solcut` anywhere on disk, and its **name is its
filename**; one that does not is *untitled* and lives in the `project.json` scratch beside
the settings until it is given a home. Switching writes the project being left before
anything on screen changes, and the app reopens whichever project was last written.

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 100 | **Untitled** | First run, or New project | The bar reads **Untitled project ▾**. Autosave goes to the scratch, exactly as it always did | Save as… |
| 101 | **Named** | Save as…, or opening a project | The bar reads the file's name without its extension. Autosave follows the file, and Save as… again moves it somewhere new rather than leaving a copy behind | New, Open, Save as… |
| 102 | **Switching, silently** | New or Open while the project has a file *it is actually writing to*, or while the editor is empty | The project being left is written first, then the timeline, bin, lanes and playhead are replaced in one step. Nothing is announced — there was nothing to lose | — |
| 103 | **Switching, asked** | New or Open with work in the editor — clips, lanes, or anything in the bin — and nowhere it is being written: an *untitled* project, or any **blocked** one (row 92a) | A modal: **Save this project first?** with Cancel · Discard · **Save as…**. Blocked belongs here because a path it may not touch is not somewhere to flush to, and the switch would otherwise write the empty document over the untitled scratch on its way in | Any of the three; Escape is Cancel |
| 103a | **Discarded** | Discard at row 103 | The work goes, *and so does the copy autosave left in the scratch* — otherwise a later New would destroy it silently, and the word would have been a lie | — |
| 103b | **Save panel dismissed** | Cancel in the native save panel, opened from row 103 | The modal stays exactly where it was and nothing switches, so a mis-click cannot take the work the modal exists to protect | Discard, Cancel, or Save as… again |
| 104 | **Opened file will not read** | Open project… on a file that is not a project, or is from a newer build | A toast naming which, and **nothing changes** — the project you were in is still open and the file is untouched. Unlike the scratch (row 88), a file the user pointed at is never replaced | Pick another file |
| 105 | **Already open** | Open project… on the project already open | Nothing at all — no read, no write, no swap. Reading it and then flushing over it would lose every edit since the last autosave, from both the screen and the file | — |
| 106 | **The flush is refused** | The project being left cannot be written — full disk, unplugged drive | The switch is abandoned and the project stays on screen, with the failed write's own toast. Everything since the last autosave landed would have gone with it | Fix the disk and switch again |
| 107 | **A render was in flight** | Any switch with a generation queued or running | It is cancelled. The clip it would land on is about to stop existing, so the job has nowhere to go, and paying for a result nothing can use is worse than stopping it | Regenerate in the project it belongs to |
| 108 | **An import was in flight** | A switch while files are still being stat'ed | The import lands in the project it was started in, or nowhere. It never lands in the project that happens to be open when it returns | Re-import |
