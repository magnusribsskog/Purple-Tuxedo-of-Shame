ADR 0001: Ellipsis Allowance & Conditional Normalization

    Status: Proposed

    Date: 2026-03-19

    Context: High-frequency use of ellipses (...) creates significant visual noise and "mental baggage" for the reader. However, single instances are often valid stylistic choices. Total normalization (always converting ... to .) feels like over-editing and borders on censorship.

Decision

Implement a "Budget-Based" punctuation system. Instead of treating every ellipsis as a mistake, calculate an "allowance" based on the total word count of the comment.

    Grant an allowance: 1 ellipsis instance per 300 words (minimum 1).

    State-based trigger: If the count exceeds the allowance, the comment is flagged for a "Style Breach."

    Conditional Action: Only if a breach is flagged will the GrammarService normalize the ellipses and apply a slop penalty.

Technical Pseudo-code
JavaScript

// Add to CONFIG
ELLIPSIS_WORDS_PER_ALLOWANCE: 300,
ELLIPSIS_PENALTY_PER_BREACH: 2.0,

// logic for GrammarService.analyze(rawText)
const wordCount = analysis.wordCount;
const ellipsisMatches = clean.match(/\.{2,}/g) || []; // Matches .. or ... or ....
const actualCount = ellipsisMatches.length;

// Step 1: Calculate Budget
const allowed = Math.max(1, Math.floor(wordCount / CONFIG.ELLIPSIS_WORDS_PER_ALLOWANCE));

// Step 2: Check for Breach
const isBreach = actualCount > allowed;

if (isBreach) {
    // Only penalize the excess
    const excess = actualCount - allowed;
    stylePoints += excess * CONFIG.ELLIPSIS_PENALTY_PER_BREACH;
    
    // Attach flag to analysis object for the Fixer to see
    analysis.flags.normalizeEllipses = true;
}

// logic for GrammarService.applyFixesToTextNode(node, analysis)
if (analysis.flags.normalizeEllipses) {
    // Collapse any sequence of 2 or more dots into exactly three
    fixed = fixed.replace(/\.{2,}/g, '...');
}
