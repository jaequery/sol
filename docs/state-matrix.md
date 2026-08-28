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
| 4 | **Imported (success)** | Probe succeeded | Clips appear on the single timeline in drop order; first new clip is selected | — |
| 5 | **Unsupported / unreadable file** | Probe failed or MIME not in the allowlist | Inline error row in the bin naming the file and the reason; other files in the same drop still import | Dismiss, or re-import |
| 6 | **Media offline** | Source file moved/deleted after import | Clip renders hatched with a "media offline" badge; preview shows the reason; export is blocked with a pointer to the clip | Relink, or remove clip |
| 6a | **Bin has media** | One or more imports succeeded | The bin head keeps a **+ Import** button whatever the bin holds, so a second import never depends on the empty state's CTA | Click + Import |
| 6b | **Media removed** | ✕ on a bin tile | The tile goes, and so do that asset's clips on the timeline — a clip with no media could only ever render as "media offline". Any in-flight generation on those clips is cancelled, the selection falls back to nothing, and the playhead clamps to the shorter timeline. Emptying the bin returns it to state 1 | Re-import |

## 2. Selection / keyframes

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 7 | **Nothing selected** | Click empty timeline | Inspector shows an explanatory empty state, not a blank panel | Select a clip |
| 8 | **Video clip selected** | Click a video clip | Inspector shows clip info + trim; the AI card is absent (animation is photos-only, per the ticket) | Select a photo |
| 9 | **Photo selected, 0 keyframes** | Click a photo clip | Inspector shows live transform values and a primary "Add keyframe" CTA; the keyframe lane is empty with a hint | Add a keyframe |
| 10 | **1 keyframe** | First keyframe added | Transform card is editable; AI card is **disabled** with the reason "Add a second keyframe to define a segment" | Add a second keyframe |
| 11 | **Segment selected (2+ keyframes)** | Click the segment between two keyframes | AI card enables, headed `KF1 → KF2` with the segment duration; prompt textarea focused | Type a prompt |
| 12 | **Prompt empty** | Segment selected, textarea blank | Generate is disabled with the inline reason "Describe the motion first" | Type ≥1 char |

## 3. Generation (Higgsfield)

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 13 | **No credential** | Generate clicked with no key ID *and* secret stored | Inline callout in the AI card: "Connect Higgsfield to generate" + Open settings; nothing is sent | Save both halves of the key |
| 14 | **Settings dialog** | Open settings | Key ID/secret fields (masked), base URL, model endpoint; Test connection reports pass/fail inline | Save / cancel |
| 15 | **Queued** | Job accepted by the API | Segment on the timeline becomes a hatched placeholder reading "Queued"; inspector shows the job id | Cancel |
| 16 | **Running (partial/slow)** | Poll returns progress | Placeholder shows a live percentage and a progress bar; **the rest of the app stays fully usable** — you can select other clips, add keyframes, start a second generation | Cancel, or wait |
| 17 | **Slow (> 90 s)** | Still running past the soft threshold | The placeholder adds "Taking longer than usual — you can keep editing"; no spinner-lock, no modal | Cancel, or wait |
| 18 | **Failed — rate limited (429)** | API returns 429 | Segment turns error-red with "Rate limited"; inspector shows the message and a Retry (with the same prompt preserved) | Retry / dismiss |
| 19 | **Failed — auth (401/403)** | Bad key | Same error affordance, message points at settings | Fix key, retry |
| 20 | **Failed — network / timeout** | Transport error | Same error affordance with the transport reason | Retry |
| 21 | **Succeeded** | Poll returns a video URL and the download completes | The generated clip replaces the segment on the timeline, carries an "AI" badge, and is immediately playable in the preview | Play, or regenerate |

## 4. Playback / export

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 22 | **Playing** | Space / play | Playhead sweeps; transport shows pause; preview interpolates the photo transform between keyframes in real time | Pause |
| 23 | **Exporting** | Export MP4 | Modal with per-stage progress (normalising clips → concatenating → finalising) and a cancel | Cancel, or finish |
| 24 | **Export succeeded** | ffmpeg exits 0 | Toast with the output path and "Reveal in folder" | Dismiss |
| 25 | **Export failed — ffmpeg missing** | `ffmpeg` not on PATH | Error dialog naming the missing binary and how to install it; export is refused rather than half-written | Install, retry |
| 26 | **Export failed — encode error** | ffmpeg exits non-zero | Error dialog with the tail of ffmpeg's stderr, copyable | Retry |

## 5. Overflow / scale

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 27 | **Long timeline** | More clips than fit | Timeline scrolls horizontally; the ruler and playhead stay in sync; zoom control rescales | Zoom out |
| 28 | **Long file name** | Name wider than the clip | Name truncates with an ellipsis in the middle and keeps the extension; full name in the tooltip and the bin | — |
| 29 | **Very short clip** | Clip narrower than its label | Label and duration are dropped in favour of the thumbnail; the clip stays grabbable at a 12 px minimum, and under 32 px the two resize handles step aside so there is still something to grab for a reorder | Zoom in |
| 30 | **Dense keyframes** | Many keyframes in a small span | Diamonds keep a minimum spacing and collapse into a "+n" cluster chip that expands on zoom | Zoom in |
| 31 | **Long prompt** | Prompt longer than the textarea | Textarea scrolls at a fixed height (never pushes the Generate button off-panel); the timeline segment chip truncates to one line | — |
| 32 | **Many generations** | Several jobs at once | Each placeholder shows its own progress; the title bar shows an aggregate "n rendering" chip | — |

## 6. Direct manipulation on the track

Position is still implied by a clip's index and length by `durationMs`/`trimStartMs` — these states
are the ways a user edits those two numbers by hand rather than by re-importing or splitting.

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 33 | **Idle clip** | Pointer over a clip | The body takes a grab cursor; a bar appears at each edge with a resize cursor. On a clip under 32 px wide the bars are omitted — they would cover the whole thing | Press, or move away |
| 34 | **Reordering** | Press a clip body and travel ≥ 4 px | The clip lifts and rides with the cursor; the rest of the track holds still and an insertion marker shows the boundary it would land on | Release to drop; dropping it back where it started is a no-op |
| 35 | **Press without travel** | Press and release under the threshold | Nothing moves; the press is a plain selection, exactly as before | — |
| 36 | **Resizing** | Drag either edge handle | The clip's new length is previewed live and every clip after it slides along, so the track reads the way it will once released. A photo's keyframes travel with the head and are pinned inside the new range; a video's `trimStartMs` walks with its head | Release |
| 37 | **Resize refused at a limit** | Dragging past a bound | The edge simply stops: a video cannot pass the first or last frame of its source (nor grow at all before its length is probed), a clip cannot go under 100 ms, and a photo cannot pass 10 minutes | Drag the other way |
| 38 | **Trimming without a mouse** | Handle focused, ← / → | The same edit at 100 ms a press, or 1 s with Shift | Tab away |

## 7. Audio lanes

A sound is not a clip: it lives on its own lane below the track, starts wherever it was
placed, and never reorders anything. Each lane holds one sound.

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

A ✦ chip stands on every boundary between two adjacent **photos**. The chip only ever
*selects* its cut — generation (a paid Higgsfield call) fires exclusively from the cut
card's button, ✦ Animate all, Retry, or Regenerate, so a stray click can never spend
credits and staleness never re-renders on its own.

| # | State | Trigger | What is shown | Way out |
|---|---|---|---|---|
| 46 | **Idle chip** | Two photos sit adjacent on the track | A small ✦ chip vertically centred on the boundary; the toolbar shows ✦ Animate all · n when at least one cut is fillable | Tap the chip, or Animate all |
| 47 | **Chip disabled (media offline)** | A photo on the cut lost its source file | The chip dims with the reason in its tooltip; nothing can be sent for a frame that cannot be rendered | Re-import the photo |
| 48 | **Cut selected** | Chip tapped | The chip takes the accent ring; the inspector shows the transition card naming both photos, an *optional* prompt (empty means the default `Smooth cinematic motion transition`), suggestion chips, and one ✦ Generate transition button | Generate, type first, or click elsewhere |
| 49 | **No credential** | Cut selected with no key stored | The card's button is replaced by the "Connect Higgsfield to generate" callout; nothing is sent | Save the key in settings |
| 50 | **Queued** | Generate pressed, job accepted | The chip widens into a dashed mono pill reading ◐ QUEUED — the cut has no width on the track, so the chip itself is the progress surface; the title bar counts the render | Cancel, or wait |
| 51 | **Running** | Poll returns progress | The pill shows ◐ n% (or elapsed seconds when the API reports no percentage); **the rest of the app stays fully usable** | Cancel, or wait |
| 52 | **Slow (> 90 s)** | Still running past the soft threshold | The pill takes an amber tint and the card adds the calm "taking longer than usual" advisory — no modal, no lock | Cancel, or wait |
| 53 | **Failed** | API error / rate limit / transport | The pill turns rose reading ✕ FAILED; the card explains and offers Retry (same cut, kept prompt) and Dismiss (timeline exactly as it was) | Retry, or dismiss |
| 54 | **Succeeded — inserted at the cut** | Render downloaded | The MP4 is inserted *at the cut* as a normal video clip with the ✦ AI badge, provisionally 5 s and probe-corrected to its real length; the reel grows, the chip disappears structurally (the boundary is no longer photo→photo), and both remaining cuts keep their chips | Play, edit, or fill the next cut |
| 55 | **Transition selected** | Click the generated clip | The AI transition card: From/To photos, editable prompt, ⟳ Regenerate. Trim, drag and delete work exactly as for any video clip | Regenerate, edit, or leave it |
| 56 | **Stale** | A source photo was reframed, reordered, replaced — or the pair otherwise changed | The clip wears an amber `⟳ SOURCES CHANGED` tag and the card says why; it still plays and exports. Nothing regenerates — or costs — on its own | One-tap Regenerate (uses the *current* neighbours), or ignore |
| 57 | **Orphaned** | A source photo was deleted, or a neighbour is no longer a photo | Amber `⟳ SOURCE MISSING` tag; Regenerate is disabled with the reason. The paid clip is kept — it renders and exports fine | Delete it for a hard cut, or leave it |
| 58 | **Transition deleted** | 🗑 / Delete on the clip | No confirm (the app has none anywhere, and no undo): the clip goes, the photo→photo cut — and its ✦ chip — structurally reappear, and the MP4 asset stays in the bin and on disk. Re-inserting means regenerating (a re-spend) | Regenerate from the chip |
| 59 | **Animate all** | ✦ Animate all · n in the toolbar | Every fillable cut queues; submissions go out strictly one at a time (a burst could trip the rate limit and strand half the batch), each chip showing its own state as its turn comes. A queued cut that went invalid is skipped, never stalled on | Wait, or keep editing |
| 60 | **Timeline moved mid-render** | The pair was reordered/deleted while rendering | The finished clip is **not** inserted somewhere wrong: a toast explains ("Transition finished, but its photos moved"), the new cuts show fresh chips, and the MP4 stays in the cache | Tap the ✦ on the new cut |
