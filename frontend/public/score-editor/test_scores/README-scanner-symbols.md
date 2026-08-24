# Symbol-highlighting fixture

Three files that put the scanner merge editor's symbol-level marks on screen
without a scanner job, a scan, or a recognition engine:

| File | What it is |
|---|---|
| `scanner-symbols-left.musicxml` | Eight bars, four quarter notes each, two systems |
| `scanner-symbols-right.musicxml` | The same, with one note moved in bar 2 and two in bar 6 |
| `scanner-symbols-regions.json` | A regions payload naming those events, in the shape the scanner sends |

Every bar has exactly four events, so the renderer's count check — which
suppresses a mark when this drawing finds a different number of rhythmic
positions than the analysis counted — has an unambiguous answer.

Open it at:

```
/score-editor/index.html?compareMode=rows&leftLabel=Left%20reading&rightLabel=Right%20reading&compareLeft=%2Fscore-editor%2Ftest_scores%2Fscanner-symbols-left.musicxml&compareRight=%2Fscore-editor%2Ftest_scores%2Fscanner-symbols-right.musicxml&compareRegions=%2Fscore-editor%2Ftest_scores%2Fscanner-symbols-regions.json
```

## Serving it from this repo

No vendoring into OurTextScores is needed to look at the rows view:

```
npm run build:embed && npm run test:embed     # static server on :8080
```

`test-embed/server.js` serves `out/` at `/score-editor/*`, so the URL above works
as written against `http://localhost:8080`. `npm run dev` works too, and there
the paths lose the `/score-editor` prefix
(`compareLeft=%2Ftest_scores%2Fscanner-symbols-left.musicxml`) — but it wants
port 3000, which the OurTextScores frontend usually holds.

What this cannot exercise is anything that talks to the scanner: taking a bar,
its refusals, the merged score's revisions, and the scan crops all need that API
and its session. Those still mean building the embed into
`OurTextScores/frontend/public/score-editor/` and using the real page.

Expect: two system rows, three panes each. Row 1 marks the third note of bar 2;
row 2 marks the first and fourth notes of bar 6 — nine marks in all. The merged
pane carries the marks of whichever reading it was started from, because it *is*
that reading until a decision changes it.

Add `&compareBlock=0` to open one difference rather than the whole page. The two
engine panes then narrow to the contested bar with one bar of context either
side, while the merged pane keeps all four bars of the line — so the bars being
compared are drawn as large as the pane allows without losing the line the
merged score is being built into.

There is no `merged` block in the payload, so nothing can be saved. This
fixture is for looking at the marks, not for exercising the write path.
