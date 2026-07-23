# Anchor Mapping Fixture (issue #28)

> [!note] Instructions
> For each probe, select EXACTLY the text described in the trailing
> bracket and add a comment whose text is the probe id (A1, A2, …).
> Do not edit anything except probe A6.

A1. Some words before **two bolded words** and after. [select: "before two bolded words and"]

A2. Again *italic stretch* here. [select: "italic stre" — stop mid-word]

A3. Please run `gdocs push` to sync. [select: "run gdocs push to"]

A4. See [the spec document](https://example.com/spec) for details. [select: "the spec document for"]

A5. This has ~~struck out words~~ in it. [select: "has struck out words in"]

A6. RETYPE THIS SENTENCE by hand in Docs so autocorrect fires: It doesn't "just work" -- yet. [after retyping, select the whole retyped sentence]

A7. First short paragraph for a spanning selection.

Second short paragraph completing it. [select: from "spanning" above through "completing" here — one comment]

- list item one
- item with **style** inside it [A8 — select: "with style inside"]
- third item continues the run [A10 — select: from "style inside" in the item above through "third item" — one comment spanning two bullets]

1. ordered opener
2. the second numbered entry [A11 — select: "second numbered"]

- [ ] an open task
- [x] a completed task with words [A12 — select: "completed task with"]

> [!warning] Callout probe
> The callout body has one sentence here.
> And a second body sentence follows. [A13 — select: from "one sentence" through "second body" — one comment]

> A plain blockquote line for anchoring purposes. [A14 — select: "blockquote line for"]

## A15 Heading Probe Text

[A15 — select the heading text above: "Heading Probe"]

| Left | Right |
| --- | --- |
| plain cell | cell with **bold** text |

A9 — comment the styled table cell. [select inside the cell: "with bold text"]
