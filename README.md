# Purple Tuxedo of Shame

An extension for Chrome that hides low-effort Reddit comments and highlights
substantive replies. Written primarily as a personal quality-of-life tool.

> **Honest disclosure:** This project is a collaboration between me and Claude
> (Anthropic's AI assistant). The core logic and configuration are mine; large
> portions of the DOM handling, regex machinery, and scoring infrastructure were
> written or significantly refactored with AI assistance. The comments throughout
> the code reflect that — they are written to explain things clearly to a human
> reader, not to perform authorship.

---

## What it does

When you load a Reddit thread, the script evaluates every top-level comment
against two criteria, after first determining if the text is English:

**Length** — comments below `MIN_LENGTH` characters (default: 200) are
considered too short to be worth reading.

**Slop score** — a weighted measure of grammar errors, slang, style problems,
and punctuation laziness. Comments scoring at or above `SCORE_NUKE_THRESHOLD`
(default: 15) are considered low-effort regardless of length.

A comment that fails either check can have one of two things happen to it:

- If one of its direct replies is long and well-written enough to qualify as a
  **hero reply**, the parent comment gets a purple shame badge 🤵‍♂️ and the
  reply gets a gold star badge ⭐. The idea is to visually indicate comments who bother to
  respond substantively to lazy comments, because this sometimes implies that despite
  being very short, or riddled with grammar and spelling issues, top level comments
  might be worth reading. The substantive reply becomes a probable indicator
  that there is soemthing worth reading, because someone took the time to reply
  properly. 

- If no hero reply exists, the comment is **hidden entirely** (CSS
  `display:none`). It is not deleted, and Reddit's data is not touched — it just
  disappears from your view.

Comments with enough upvotes (default: 800) are **immune** from both outcomes,
on the assumption that strong community approval outweighs style concerns.

The script also optionally **rewrites visible text in-place** to fix missing
apostrophes, lowercase "i" used as a pronoun, common slang abbreviations, and
missing sentence capitalisation. This is purely cosmetic and only affects what
you see on your screen.

---

## How the slop score works

The score is calculated in two steps.

**Step 1 — collect raw points**

The comment text is scanned for four types of problems, each contributing
points to its own bucket:

| Bucket | What it catches |
|---|---|
| Grammar | Missing apostrophes: `dont`, `youre`, `hes`, etc. Lowercase `i` as a pronoun. |
| Slang | Informal abbreviations: `ur`, `rn`, `idk`, `wanna`, `cuz`, etc. |
| Style | Sentences that start with a lowercase letter. Entire comments written in lowercase. |
| Punctuation | No terminal `.`, `!`, or `?`. Excessive emoji relative to word count. |

Each word in the dictionary has a severity score (1–6). A word like `dont` (score 6)
contributes more than `couldnt` (score 2), reflecting how common and avoidable
each error is.

**Step 2 — normalise and weight**

Raw points are divided by word count and multiplied by 100 to get a
*density* — errors per 100 words. This means a 500-word comment with five
errors scores the same as a 100-word comment with one error.

The four densities are then combined using the weights from `DEFAULT_CONFIG`:

```
score = grammar_density   × WEIGHT_GRAMMAR     (0.5)
      + slang_density     × WEIGHT_SLANG       (0.3)
      + style_density     × WEIGHT_STYLE       (0.1)
      + punct_density×0.5 × WEIGHT_PUNCTUATION (0.1)
```

Punctuation density is halved before weighting because "no full stop" is a
blunt signal that would otherwise dominate the score on short comments.

To see the score on every comment while you are tuning thresholds, set
`ENABLE_SCORE_DISPLAY: true` in the config. A coloured SLOP badge will appear
on each comment (green = low score, red = high score).

---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Click **Create a new script** in the Tampermonkey dashboard.
3. Paste the contents of `purple-tuxedo-4.2.2.user.js` and save.
4. Navigate to any Reddit thread. The script activates automatically.

---

## Configuration

All tunable values are in the `DEFAULT_CONFIG` object near the top of the
script. Edit them directly and reload the page.

```js
const DEFAULT_CONFIG = {
    MIN_LENGTH:           200,   // Minimum character count for a comment to survive on length alone
    SCORE_NUKE_THRESHOLD: 15,    // Slop score at or above this triggers hiding/shaming
    ENABLE_NUKE_BY_SCORE: true,  // false = only nuke by length, ignore score entirely

    CHILD_MIN_LENGTH: 200,       // A reply must be at least this many characters to be a hero
    CHILD_MIN_WORDS:   35,       // A reply must also have at least this many words to be a hero

    USE_UPVOTE_IMMUNITY: true,
    UPVOTE_THRESHOLD:    800,    // Comments with this many upvotes or more are never touched

    ENABLE_SCORE_DISPLAY: false, // Show numeric SLOP score badge on every comment
    SHOW_PLACEHOLDERS:    false, // Replace hidden comments with a visible [hidden] marker
    ENABLE_GRAMMAR_FIXES: true,  // Rewrite visible text to fix apostrophes, caps, slang

    WEIGHT_GRAMMAR:     0.5,     // These four weights should add up to 1.0
    WEIGHT_SLANG:       0.3,
    WEIGHT_STYLE:       0.1,
    WEIGHT_PUNCTUATION: 0.1,
    ...
};
```

**Tips for tuning:**

- Set `ENABLE_SCORE_DISPLAY: true` temporarily to see how comments are scoring
  before committing to a threshold.
- If too many borderline comments are being hidden, raise `SCORE_NUKE_THRESHOLD`
  by a few points or raise `MIN_LENGTH`.
- On subreddits where English is a second language and slang is uncommon, you
  may want to reduce `WEIGHT_SLANG` and increase `WEIGHT_GRAMMAR` to compensate.
- `CHILD_MIN_WORDS` is the most sensitive hero detection knob — lowering it
  makes it easier for a reply to rescue its parent.

---

## How the DOM handling works

Reddit's 2023+ redesign ("Shreddit") uses a web technology called
**Web Components**. Comments on the page are represented as custom HTML
elements like `<shreddit-comment>`, and their text content is stored inside
a **Shadow DOM** — a separate, self-contained DOM tree that is attached to the
element but is invisible to most standard DOM queries.

The script handles this in `extractCommentText()` using three fallback strategies:

1. **Shadow DOM lookup** — accesses `comment.shadowRoot` directly and searches
   for known text-containing elements inside it. This is the normal path for
   modern Reddit.

2. **Light DOM lookup** — searches for the same elements as direct descendants
   of the comment element, which is how older Reddit markup works.

3. **Text node walker** — if both of the above fail, a `TreeWalker` manually
   iterates over every raw text node in the entire comment subtree and
   concatenates them, skipping anything inside code blocks, links, or
   blockquotes.

Comments are not processed the moment they appear in the DOM. Instead, they are
registered with an `IntersectionObserver`, which watches for them to enter the
visible area of the screen. This means the script only does work on comments you
are actually about to read, rather than processing the entire thread at once.

A `MutationObserver` watches the page for new comment elements being added
dynamically (which Reddit does as you scroll or expand threads), and registers
each new comment with the `IntersectionObserver` when it appears.

---

## Code structure

```
purple-tuxedo-4.2.2.user.js
│
├── DEFAULT_CONFIG          All tunable values. Edit here.
│
├── extractCommentText()    Gets the text of a comment element.
│                           Handles Shadow DOM, light DOM, and raw text nodes.
│
├── PlaceholderProtector    Temporarily replaces code, URLs, quotes, and math
│                           with tokens before scoring/fixing, then restores them.
│
├── GrammarService          Language detection, scoring, grammar fixes, score badge.
│   ├── detectLanguage()    Is this an English-language thread?
│   ├── analyze()           Scans text and returns raw error point totals.
│   ├── computeScore()      Normalises raw points into a single slop score.
│   ├── applyFixesToTextNode()  Rewrites a single text node to fix errors.
│   └── attachScoreBadge()  Adds a coloured SLOP N badge (debug mode).
│
├── NukerEngine             Applies outcomes to comment elements.
│   ├── processComment()    Main entry point. Orchestrates all decisions.
│   ├── getCommentScore()   Reads the upvote count from a comment element.
│   ├── hasUpvoteImmunity() Returns true if the comment is too popular to touch.
│   ├── isStrongReply()     Returns true if a reply qualifies as a hero.
│   ├── hideComment()       Adds the CSS class that hides a comment.
│   ├── applyShameBadge()   Adds the purple shame badge.
│   ├── applyHeroBadge()    Adds the gold hero badge.
│   └── applyFixesToTextNodes() Walks text nodes and calls GrammarService on each.
│
└── CommentProcessor        Watches the page for new/visible comments.
    ├── MutationObserver    Detects new comment elements added to the DOM.
    └── IntersectionObserver  Triggers processing when a comment nears the viewport.
```

---

## Known limitations

- **Language detection is per-thread, not per-comment.** The first sufficiently
  long comment on a page sets the language for all subsequent comments. On
  threads with mixed English and non-English comments, some non-English comments
  may be incorrectly scored. In practice this has not been a problem on the
  subreddits this was written for.

- **Top-level detection depends on Reddit's DOM structure.** If Reddit changes
  how `<shreddit-comment>` elements are nested, the `isTopLevel` check in
  `processComment()` may need updating. This is an accepted maintenance cost
  for a private tool.

- **The settings panel (Ctrl+Shift+P) is a placeholder.** It displays correctly
  but has a minor display bug on first open. Edit `DEFAULT_CONFIG` directly
  instead.

- **Grammar fixes are English-only.** The fix dictionary is English. The script
  skips fixing on threads it does not identify as English, but the dictionary
  would need language-specific versions to work properly on other languages.

---

## Possible future work

- Language packs for Norwegian, German, French, and Spanish (would require
  per-comment language detection rather than per-thread).
- Conversion to a proper browser extension with a working settings UI.
- Extracting `GrammarService` as a plugin interface so language packs can be
  loaded independently.

None of this is planned in the near term. The script works well as a
Tampermonkey userscript and the logic is still being tuned.

---

## Version history

| Version | Summary |
| 4.2.3 | Fixed Treewalker boundries |
| 4.2.2 | Fixed regex lastIndex bug, fixed k/M upvote parsing, removed stale child cache |
| 4.2.1 | Reordered Shadow DOM selectors, added debug logging for short extractions |
