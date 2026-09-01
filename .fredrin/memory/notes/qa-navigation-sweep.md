# SolCut — full navigation & regression sweep

**Ticket:** SOL-FQBWEU · **Date:** 2026-08-30 · **Build:** branch `fredrin-cmtf1635-mtf17slx`, base `2390c70`

Every button and menu in the application was inventoried, traced to the action behind it, and
clicked. The sweep is automated (`src/App.navigation.test.tsx`, 43 tests) so it runs in CI and
guards the findings rather than describing them once.

**Scope:** 52 `<button>` call sites and 10 form inputs across 12 components. The app is a
single-window desktop editor — it has **no router, no `<a href>` anywhere, and no custom
native menu**, so "navigation menus route correctly" and "no broken links" are satisfied by
construction; what stands in for navigation here is the four dialog/panel surfaces (settings,
film wizard, export, toasts) and the timeline toolbar. All four were opened, exercised, and
closed by every exit they offer.

> **Later additions.** The counts above are this sweep's own, on the date above. The suite
> is the living inventory, and a surface added since carries its own coverage in the same
> file, under the same console-error gate:
>
> - **The compose panel** (SOL-UY06FH) — the media bin's `✦ Generate`. Covered by
>   `describe('the compose panel')`: both bin-head actions open what they name, Cancel and
>   Escape both close it without costing the draft, Escape closes the innermost layer
>   first, the Options disclosure toggles both controls, its picker does not answer to the
>   transition picker's `Model` label, `✦ Generate image` offers nothing it would refuse
>   (empty prompt, no CLI), and a bin tile becomes a reference toggle whose remove button
>   stands down — which is what keeps a `<button>` out of a `<button>`.
> - **The Duration box** (SOL-VEKYO9) — the inspector's numeric length. Covered by
>   `describe('a typed length')`, which is driven by a `RESIZABLE` table rather than one
>   sampled clip: every case runs once per element type that wears edge handles, and a
>   sibling test reads back every resize handle the app renders and fails if a resizable
>   element type is missing from that table. That is what makes "any element type, not a
>   subset" falsifiable instead of a sentence in a ticket.

**Result: 19 defects found and fixed, 14 more found and documented below.**

---

## 1. Defects found and fixed

Each is covered by a regression test; 15 of the 43 sweep tests exist specifically to keep
these from coming back.

### Dead clicks — a control that did nothing at all

| # | Where | Expected | Actual |
|---|---|---|---|
| **A1** | Timeline toolbar, `⌖` Select tool (`Timeline.tsx:405`) | Selects the select tool | **No `onClick` at all.** Hard-coded `tool--on`, so it permanently read as the active tool. A focus stop that did nothing. **Removed** — there is no second tool to pick; its sibling "◆ Add keyframe" went with the keyframes concept in 2390c70 and this was its leftover twin. |
| **A6** | Film panel, `Export film` (`FilmWizard.tsx:379`) | Exports the film | **Nothing happened.** The offer was gated on `assembledClipIds`, which is written once and never cleared — it recorded that a film *had been* laid down, not that its clips were still there. Delete them and the button stayed, while `runExport` returned immediately at `clips.length === 0`: no save dialog, no progress, no toast. |
| **A8** | Export dialog, `Try again` (`ExportDialog.tsx:50`) | Retries the export | **Nothing visible happened.** For a clip with no file on disk, retry re-entered `runExport`, hit the same pre-check, and re-rendered the identical message. Now offered only when a retry could plausibly end differently. |
| **A9** | 🔴 **Every button in the app** (`App.tsx:98`) | Space activates the focused button | **The playhead toggled instead.** The Space shortcut called `preventDefault()` for every target that was not an `<input>`/`<textarea>`, which suppresses a button's own activation. Tab to "Generate film", press Space — the film did not start. **All 52 buttons were dead under keyboard operation.** The single largest defect in this sweep. |

### Buttons that offered an edit their action refused

| # | Where | Expected | Actual |
|---|---|---|---|
| **A2** | Timeline toolbar, `🗑` Delete | Dark unless something deletable is selected | Lit up for a selected **cut**, which `deleteSelection` deliberately ignores ("a cut is a place, not a thing"). Click, nothing. |
| **A3** | Timeline toolbar, `✂` Split | Dark unless the playhead is inside a clip | Lit whenever *any* clip existed. Silent no-op in a gap, before the first clip, on a boundary, and at the end. Both now ask one shared predicate that the store's own guard also asks, so button and action cannot drift. |
| **A4** | Transport, `▶` Play | Live whenever the timeline has length | **Dark on an audio-only project.** The button measured the visual track alone while `togglePlay` measured the whole timeline — so Space played a project the Play button refused. Reachable from empty in two clicks via `♪ Add audio`. |
| **A5** | Transport, `⏭` and the duration readout | Reflect the whole timeline | Under-reported whenever a sound outlasted the last clip; `⏭` landed short of the real end. |
| **A7** | Film panel callout | States what is on the timeline | Rendered "On the timeline — **0 transitions · 0.0s**" directly above the dead Export button. |

### Menus and keyboard

| # | Where | Expected | Actual |
|---|---|---|---|
| **B1** | Escape, in any dialog field | Closes the dialog | **Did nothing.** The `INPUT`/`TEXTAREA` guard returned *before* the Escape branch, so Escape failed in precisely the place it was needed — with the cursor in a dialog's own field, which is the primary interaction with both the settings dialog and the wizard. |
| **B2** | Escape, with two layers open | Closes the topmost | Closed **both** dialogs at once. |
| **B3** | Export dialog | Has a way out | No Escape, no scrim click — its own Close button was the only exit. |
| **B4** | `Backspace` / `Delete` behind a modal | Does nothing | **Deleted the selected clip** behind the scrim, with no feedback. Also lacked `preventDefault`, unlike Space. Now suppressed under a scrim — but deliberately *not* under the film panel, which is non-modal by design so the editor stays usable while a film renders. |
| **B5** | Settings and export dialogs | Open focused | Neither autofocused; the user had to click into the first field. |

### State integrity behind the buttons

| # | Where | Expected | Actual |
|---|---|---|---|
| **C1** | `Export MP4` (`store.ts:927`) | One render at a time | **Two concurrent ffmpeg renders.** Dismissing the progress dialog nulled the only state the button consulted, so it went live again — a second save dialog, a second encode. Worse, the first run's completion then wiped the second run's dialog and toasted the first run's filename. Now guarded by a store flag that survives the dialog being dismissed, and the button reads "Exporting…". |
| **C2** | Film panel, reopening | Opens clean | Showed **the previous run's error box** as if it had just happened — the panel is hidden by an early return, not unmounted, so its local state outlived a close. The user's chosen photos and prompts are deliberately kept; only the last run's complaints are cleared. |
| **C3** | Title bar credential state (`store.ts:900`) | Independent of ffmpeg | **One rejected IPC call made a configured app report "✦ Connect Higgsfield"** and gated off every generate path. Both awaits sat in a single `set()`, so a failing ffmpeg probe threw the settings away with it. |

### Copy and dead style

| # | Where | Expected | Actual |
|---|---|---|---|
| **D1** | `app.css:499` | — | `.card--disabled` defined, referenced nowhere. Removed. |
| **D2** | Media bin empty state | Says where a drop works | Promised "Drop photos and videos **anywhere**" — false twice over: the timeline track and the film panel are the only drop targets, and audio is supported too. |
| **D3** | Audio lane mute button | Reachable, and does not block the lane | Below ~18 px the mute button covered the entire lane body, so the lane could not be selected — and since delete needs a selection, **could not be deleted at all**. Now hidden at narrow widths, the same rule the resize handles already use. |
| **D4** | `.fredrin/memory/concepts/state-matrix.md` | Matches the app | Seven rows documented behaviour that no longer (or never) existed. Updated. |

---

## 2. Defects found and NOT fixed

Deliberately out of this PR's scope. Recorded here in full so nothing is lost; the first two
are worth their own tickets.

**R1 — Drag-and-drop is probably dead in the packaged app. ⚠ Most serious finding.**
`src-tauri/tauri.conf.json:21` sets `dragDropEnabled: true`, under which Tauri v2 intercepts
OS drops and the webview never sees them; nothing in `src/` listens for `onDragDropEvent`. The
test suite passes because it fires synthetic React events. Note this is **not** the one-line
config flip it looks like: setting it `false` restores the webview events, but Tauri v2 does
not populate `File.path`, so every dropped file would import *pathless* — and export refuses
pathless assets. The real fix is to handle `onDragDropEvent` and take real paths. Severity is
platform-dependent (documented as required for HTML5 DnD on Windows; may still work on
macOS/Linux). **Needs a packaged build to verify — recommend its own ticket.**

**R2 — The timeline measures the wrong box.** `ratioFromEvent` (`Timeline.tsx:186`) measures
`.track`, which has 12 px side padding and stretches to `min-width:100%`, while clips live in
`.track__clips`. A file dropped well to the right of the last clip computes a ratio near 0.5
and inserts *between* clips; playhead scrubbing is off by up to seconds at low zoom. Layout
geometry rather than a button, and jsdom reports zero-size rects, so a regression test would
have to stub `getBoundingClientRect` wholesale. **Recommend its own ticket with visual
verification.** *(Resolved for scrubbing in SOL-WZQ6XY: every seek now maps px→ms off the
clips' own box. Drop placement still measures `.track` — still open.)*

**R3 — Three of four position-anchored decorations sit 12 px off** (the insert marker, the
audio-lanes playhead, the ruler ticks) because they resolve `left` against a padded containing
block. The two playheads are visibly 12 px apart. Same root cause as R2. *(Resolved for the
ruler ticks and the lanes playhead in SOL-WZQ6XY, which made the ruler a seek surface and had
to align it; the insert marker — a drop decoration — still sits 12 px off.)*

**R4 — No `setPointerCapture` anywhere.** Drags listen on `window`, which survives leaving the
track but not a `pointerup` delivered outside the window. The drag then never commits and the
next stray pointer event commits it at an arbitrary offset.

**R5 — Snap does not apply to edge trims**, only to moves, though its tooltip promises
"drags … nudge onto a nearby edge" without qualification.

**R6 — An asset in the bin can never reach the timeline.** No drag-out, no double-click; every
path onto the track goes through the file picker or a drop. Deleting a clip is therefore a
one-way door whose only recovery re-imports the file as a *second* asset. *(Resolved in
SOL-XB7SC5: a bin tile is a pointer drag source and the track commits the drop, with Enter
and double-click on a focused tile as the keyboard path. Deliberately **not** HTML5
drag-and-drop — see R1 — so the affordance does not depend on what the packaged webview does
with a drag.)*

**R7 — `ffmpegAvailable` is fetched into the store and never read.** There is no pre-flight
refusal; a missing ffmpeg is only discovered as a failed export.

**R8 — `setFilmSegmentPrompt` and `placeFilmOnTimeline` have no UI caller.** Both are
unit-tested, so removing them is an API judgement call rather than a QA fix. Consequence: a
film leg that failed *because of* its prompt can only be retried with the identical prompt.

**R9 — `asset.missing` is read in four places and written nowhere.** The whole documented
"Media offline" state is unreachable through the UI, and its documented "Relink" exit does not
exist. The offline branches in the timeline, inspector and cut chip are dead code today.

**R10 — No modal has a focus trap or focus restoration.** Tab walks out of a dialog into the
app behind the scrim. Autofocus was added here (B5); trapping is a separate a11y ticket.

**R11 — Toasts never auto-expire** and stack unbounded over the bottom-right of the timeline.

**R12 — A destructive action has no confirmation anywhere**, by consistent design — including
"Start over", which discards a successfully rendered (and paid-for) film leg.

**R13 — Duplicate accessible names**: "Dismiss" ×3, "Close" ×2, "Cancel" ×2 across components.
Not a user-facing defect, but it makes `getByRole` ambiguous and will trip the next test author.

**R14 — Row 3 of the state matrix describes a "ghost clip at the insertion point"** that does
not exist in the code; only the insert marker does.

---

## 3. Coverage

Before this sweep, four whole surfaces had **zero** test coverage — and that is exactly where
the defects were:

| Surface | Before | After |
|---|---|---|
| `Transport` (⏮ ▶ ⏭, timecodes) | no test touched it | 4 tests · 2 defects found |
| `App.tsx` keyboard shortcuts | no test touched it | 7 tests · 5 defects found |
| `ExportDialog` | never rendered in any assertion | 3 tests · 2 defects found |
| `Toasts` | never clicked | 1 test |
| Timeline toolbar `⌖` `✂` zoom | never clicked | 6 tests · 3 defects found |

**Suite:** 182 tests green (139 pre-existing, 43 new). Every sweep test also fails on a
`console.error` or `console.warn`, which is what makes the ticket's "no console errors"
criterion falsifiable rather than a matter of opinion.

```
pnpm test       182 passed (5 files)
pnpm lint       exit 0
pnpm typecheck  exit 0
```

## 4. Method and its limits

The sweep mounts the real `App` under jsdom and drives it with Testing Library, stubbing only
the two edges jsdom cannot provide: the Tauri bridge (`lib/backend`) and canvas/media decoding
(`lib/frames`). Everything between — the store, the timeline maths, the inspector, the cut
logic — is the real thing.

What that cannot reach, and why R1–R3 are reported rather than fixed: jsdom performs no
layout, so `getBoundingClientRect` returns zeros and pixel-accurate hit-testing cannot be
asserted; and no headless harness can prove what a packaged Tauri webview does with an OS
drop. Those need a human running `pnpm tauri dev`.
