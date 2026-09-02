# SolCut — pixel-level design audit

**Ticket:** SOL-Q53R64 · **Date:** 2026-09-02 · **Base:** `9e0fdf7` · **Method:** 41 seeded app
states rendered in Chromium (Playwright against `pnpm dev`) at 1440×900 and the 1080×660 minimum,
retina crops of every dense region, the user's own retina screenshot of the packaged macOS app,
and a literal census of `app.css`. Every finding below was fixed in this pass, and the fixes are
held by a DOM probe (26 checks, real exit code) plus a new `pnpm audit:css` gate.

**Direction, decided with the human:** flatten. Same palette and layout; one flat accent fill;
no title-bar gradient, no stage vignette, no canvas drop shadow, no gradient buttons or progress
fills. Elevation stays only where a layer floats over another (menu, dialogs, toasts, the film
panel, a clip mid-drag). Four always-visible elements were approved for removal because each
duplicated something else on screen: the preview timecode overlay (the transport is the
timecode), the toolbar keyboard legend (every key is in its button's tooltip), the
"1920 × 1080 · 30 fps" label (static), and the media count badge (the tiles are the count — and
the badge was what truncated the title to "MED…").

## What was wrong, and what changed

| # | Finding | Fix |
|---|---|---|
| 1 | **The project menu was invisible.** `.titlebar .doc` got `overflow: hidden` in the last UX pass and the menu is positioned inside it; New / Open / Save as… could not be reached with a mouse in the real app. jsdom does no layout, so no test saw it. | The document slot is a flex row that never clips; only a new `.doc__label` ellipsizes (probed with a 120-character name at 1080px). |
| 2 | Toast ✕ wore the action button's accent border: `.toast button` (0,1,1) out-specified `.toast__dismiss` (0,1,0). | `.toast .toast__dismiss`. |
| 3 | Preview "MEDIA OFFLINE" and the filename landed a third of the frame apart — a grid with three children (text, `<br>`, span), one row each. | One flex column; the two lines are 4px apart. |
| 4 | Bin head truncated to "MED…" once the count badge appeared (281px in a 280px column). | Badge removed. |
| 5 | Captions double-truncated ("audiocopp…1483.…"): an 18-char JS middle-ellipsis (128px) inside a 124px column with a CSS ellipsis. | One truncation: CSS end-ellipsis, full name in `title`. |
| 6 | Cut chips rode the top seam (`translate(-50%, -55%)`) and covered the first glyphs of the next clip's name at every zoom; the run/queued/failed chips covered more. The concept drew the chip centred in the band; the last pass raised it to free the trim handles and created this. | A 28px gutter above the clip band (`--h-cut-gutter`); every chip variant anchors `bottom: 100%` with a 2px foot into the seam. Timeline grows 14px. Probed at 12, 46 and 160 px/s: no chip over a name, no chip over a chip. |
| 7 | Card heads "Transition · a.png → b.png" wrapped to three lines above thumbnails that already identified the pair; the job id wrapped to two ragged lines; "Status RUNNING" repeated the head. | Heads are titles ("Transition", "Rendering transition", "Queued transition", "Generation failed"); the pair is From/To rows; the job id is one line with the whole id in `title`; progress is one row (bar + reading, mirroring the chip: in queue / % / seconds). |
| 8 | Duration box numerals sat 14px left of every other value because the unit "s" hung outside the box. | The unit is inside the box; the ring belongs to the box (`:focus-within`). |
| 9 | Settings body scrolled at 1440×900 (`max-height: 62vh`) and cut a hint mid-sentence. | Body height is what the window leaves after head, foot and margin; copy trimmed with every tested string kept. |
| 10 | ~4px between the prompt chips and the "Model" label; Options and Cancel shared one link style; "0 of 3 photos chosen" was error-red before anything happened; "…or import ." | `.card__body .field` top margin; a `.disclosure` style; neutral hint; no side padding on the inline link. |
| 11 | Redundancies: "Type audio", two export lines for one stage, the "ffmpeg was not found" heading repeating its message, the cut card's "No typing needed" repeating the placeholder, the transition card's second thumbnail, an error box inside an error card, "Mute track" in the accent primary style, "Animate all" (an action) lit like "Snap" (a toggle), a text ✦ beside an SVG icon set. | Each removed or demoted; `tool--on` is reserved for `aria-pressed`, the paid batch action gets `tool--accent` (accent text and border, no fill). |
| 12 | 39 distinct hex colours and 37 `rgba()` literals in `app.css` bypassed `tokens.css`; 71 spacing values sat off the 4px grid the token file declares; one 10.5px font-size; weights 650/700 beside 600. | Every colour is a token (new: `--on-accent`, `--accent-solid-hover`, `--err-solid(-hover)`, `--video-black`, the overlays, `--hatch`, `--scrim`); spacing is `--sp-*` only; weights are 500/600. `pnpm audit:css` fails the build on any literal. |

## Contrast, checked
White on `--accent-solid` 5.7:1, on its hover 6.7:1; white on `--err-solid` 5.2:1, hover 6.6:1.
`--accent` (#7c5cff) is 4.35:1 under white and is never used as a fill.

## Deliberately kept
- The gradient scrim under a clip's name and the insert marker's glow: both do a job (legibility over a thumbnail, a 3px line over a thumbnail).
- The AI GENERATED badge on the preview: it says what the frame is, which nothing else on the frame does.
- The `.solcut` name in the title bar with "SolCut —" before it: the window has no other title.

## Still open (worth their own tickets)
- Undo, a context menu, scroll-to-zoom, the film wizard's entry point — as in the 2026-09-01 note.
- Verify the packaged macOS build: the overlay title bar and the gutter were checked in Chromium, not WKWebView.
