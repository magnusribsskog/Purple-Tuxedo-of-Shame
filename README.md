# Purple Tuxedo of Shame

A userscript for Violentmonkey on Firefox that evaluates Reddit comments and suppresses weak top-level comments while preserving threads rescued by strong replies. Applies visible shame labels and optionally fixes grammar.

## What It Does

### Thread Suppression (NukerEngine)

Top-level comments are evaluated against configurable rules:
- Minimum character length
- Optional grammar density threshold
- Structural heuristics

**Behavior:**
- If a top-level comment fails and has no strong replies, the thread is removed
- If a top-level comment fails but has a strong reply, the thread survives and the top-level comment is visually marked instead

### Grammar Scoring (GrammarService)

Optional subsystem that:
- Detects common grammar shortcuts (im, dont, youre, etc.)
- Scores irritation density relative to word count
- Applies flat penalties for stylistic issues (e.g., long all-lowercase posts)
- Shields quoted text from scoring
- Optionally auto-fixes detected issues

Attaches a visible badge:
```
SLOP: 12.4
```

> Note: Scoring is heuristic and intentionally opinionated.

### Visual Shame System

When a comment is spared but deemed weak:
- A purple gradient highlight is applied
- A badge is inserted reading "Purple Tuxedo of Shame"
- Direct style injection is used to remain resilient against Reddit DOM changes and Shadow DOM behavior

## Configuration

All tuning lives in the `CONFIG` object at the top of the script.

### Core Nuking Settings

| Setting | Purpose |
|---------|---------|
| `MIN_LENGTH` | Minimum characters for top-level comments |
| `CHILD_MIN_LENGTH` | Minimum characters for a reply to qualify as strong |
| `CHILD_MIN_WORDS` | Word count requirement for strong replies |
| `SHOW_PLACEHOLDER` | Show placeholder instead of silent removal |
| `REMOVE_DELAY` | Delay before DOM removal |

### Grammar Options

| Setting | Purpose |
|---------|---------|
| `ENABLE_GRAMMAR_FIXES` | Apply regex-based corrections |
| `ENABLE_SCORE_DISPLAY` | Attach visible slop score badge |
| `ENABLE_NUKE_BY_SCORE` | Allow grammar score alone to trigger nuking |
| `SCORE_NUKE_THRESHOLD` | Slop threshold for nuking |
| `ALL_LOWER_FLAT_PENALTY` | Flat penalty for long all-lowercase posts |
| `ALL_LOWER_MIN_LEN` | Minimum length before lowercase penalty applies |

### Visual Settings

| Setting | Purpose |
|---------|---------|
| `SHAME_EMOJI` | Emoji displayed in badge |
| `SHAME_LABEL` | Badge text |

## Strong Reply Criteria

A reply must meet ALL of the following to qualify as strong:
- Minimum character length
- Minimum word count
- Not be ALL CAPS
- Not be mostly symbols
- Contain meaningful text

If a strong reply exists, the parent thread survives even if the top-level comment fails.

## Keyboard Controls

| Shortcut | Action |
|----------|--------|
| `Ctrl + Shift + X` | Toggle placeholder visibility for removed comments |

## Installation

1. Install Violentmonkey (Firefox recommended)
2. Create a new userscript
3. Paste the script contents
4. Ensure it matches: `https://www.reddit.com/*`

> Future releases will include Firefox and Chrome extension packages.

## Known Limitations

- Scientific notation and math-heavy posts are mis-scored
- Grammar density math is heuristic, not linguistically rigorous
- Reddit DOM changes may break detection
- Hero badge styling is defined but not reliably applied
- Regex fixes may interfere with technical writing

## Roadmap

- [ ] Scientific notation detection shield
- [ ] Hoverable slop label revealing original text
- [ ] Expanded punctuation abuse scoring
- [ ] Fix hero badge logic
- [ ] Optional upvote threshold exemption