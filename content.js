// ==UserScript==
// @name         Purple Tuxedo of Shame
// @namespace    Violentmonkey Scripts
// @match        https://www.reddit.com/*
// @grant        none
// @version      0.2.0
// @description  🤵‍♂️ Label low-effort posts with configurable error rate, optionally fixes grammar
// ==/UserScript==

/**
 * PURPLE TUXEDO OF SHAME - Core System
 *
 * Architecture:
 * - NukerEngine: Handles thread collapse, override detection, visual shame
 * - GrammarService: Optional addon for text fixing + irritation scoring
 * - They communicate via a simple hook, not tight coupling
 */

/**
 * To Do
 * Add detection logic for scientific notation, so we can refrain from scoring and "fixing" these
 * Make it so the "slop label is hooverable and displays the unfixed text"
 * Expand the GrammarService to handle punctuation abuse. Excessive exlamation and question marks, running dots other than 3, improper interrobang
 * Figure out why the Hero Badge is no longer ever applied. (It looks right, and it isn't throwing errors)
 * Consider implementing a cutoff for visually fixing posts based on a upvote treshold. (If something has a very high score, we might be better off not touching it. Unclear.)
 *
 * */

// ==================== CONFIG ====================

const CONFIG = {
    // Nuker settings
    MIN_LENGTH: 300,
    CHILD_MIN_LENGTH: 300,
    CHILD_MIN_WORDS: 35,
    SHOW_PLACEHOLDER: false,      // Set to true to see how many threads are nuked outside the log. This can be useful when tuning settings
    REMOVE_DELAY: 100,            // Don't touch this one without being very careful. There is a LOT of wrangling of the Reddit layout going on, and some of it might "seem" unneeded, but very much is

    // Grammar settings (optional feature)
    ENABLE_GRAMMAR_FIXES: true,  // When true, all the regex in the GrammarService will be applied to all text outside of quotation blocks (This probably breaks scientific notation)
    ENABLE_SCORE_DISPLAY: true,  // A label is applied to a top level comment if there is a child comment that is successfully strong that the thread should not be supressed
    ENABLE_NUKE_BY_SCORE: false, // This allows the detected error rate alone to be sufficient to suppress a top level comment. It's not good enough at this time
    SCORE_NUKE_THRESHOLD: 8,     // Higher is more forgiving. Input range 1-100.
    ALL_LOWER_FLAT_PENALTY: 4,   // This is a flat score applied after the ratio is calculated. Flat scoring makes sense for poor style choices and is additive to the ratio
    ALL_LOWER_MIN_LEN: 60,       // Posts that are shorter than this value do not get penalized for all lower case

    // Visual
    SHAME_EMOJI: "🤵‍♂️",
    SHAME_LABEL: "Purple Tuxedo of Shame"
};

// ==================== GRAMMAR SERVICE ====================
// Pure functions, no DOM side effects until applied

const GrammarService = {
    fixes: {
        "dont":     { fix: "don't",     score: 6 },
        "im":       { fix: "I'm",       score: 6 },
        "shes":     { fix: "she's",     score: 4 },
        "hes":      { fix: "he's",      score: 5 },
        "cant":     { fix: "can't",     score: 4 },
        "wont":     { fix: "won't",     score: 4 },
        "arent":    { fix: "aren't",    score: 4 },
        "isnt":     { fix: "isn't",     score: 5 },
        "didnt":    { fix: "didn't",    score: 5 },
        "couldnt":  { fix: "couldn't",  score: 4 },
        "shouldnt": { fix: "shouldn't", score: 4 },
        "wouldnt":  { fix: "wouldn't",  score: 4 },
        "theyre":   { fix: "they're",   score: 6 },
        "youre":    { fix: "you're",    score: 6 },
        "havent":   { fix: "haven't",   score: 5 },
        "idk":      { fix: "I don't know", score: 2 },
        "idc":      { fix: "I don't care", score: 4 },
        "tbh":      { fix: "to be honest", score: 1 },
        "imo":      { fix: "in my opinion", score: 3 },
        "ikr":      { fix: "I know right", score: 5 },
        "rn":       { fix: "right now",    score: 5 },
    },

    process(text, comment) {
        if (!CONFIG.ENABLE_GRAMMAR_FIXES && !CONFIG.ENABLE_SCORE_DISPLAY) {
            return { fixedText: text, changeCount: 0, score: 0 };
        }

        let fixedText = text;
        let changeCount = 0;
        let grammarPoints = 0;

        // ----- 1. QUOTE SHIELD: Strip quoted text before scoring -----
        // We don't want to hold errors in quotes against the user for quoting something that is poorly written.
        const textForScoring = text
            .replace(/^>.*$/gm, '') // Remove Reddit blockquotes
            .replace(/"[^"]*"|“[^”]*”/g, ''); // Remove text in quotes

        const lowerForScoring = textForScoring.toLowerCase();

        // ----- 2. Dictionary Checks (Scoring against Shielded Text) -----
        for (const [bad, { fix, score: base }] of Object.entries(this.fixes)) {
            const regex = new RegExp(`\\b${bad}\\b`, 'gi');
            const matches = (lowerForScoring.match(new RegExp(`\\b${bad}\\b`, 'g')) || []).length;

       //     if (matches > 0) {
       //         grammarPoints += matches * base;
       //         // This code block would fix shielded text, but that should probably not be done as the errors might be the point
      //          if (CONFIG.ENABLE_GRAMMAR_FIXES) {
      //              fixedText = fixedText.replace(regex, fix);
       //         }
        //        changeCount += matches;
        //    }
        }

        // ----- 3. Sentence‑starts (Scoring against Shielded Text) -----
        const startRegex = /(?:^|[.!?]\s+)([a-z])/g;
        const startMatches = [...textForScoring.matchAll(startRegex)];
        if (startMatches.length > 0) {
            grammarPoints += startMatches.length * 4;
            if (CONFIG.ENABLE_GRAMMAR_FIXES) {
                fixedText = fixedText.replace(startRegex, (match) => match.toUpperCase());
            }
            changeCount += startMatches.length;
        }

        // ----- 4. Grammar Density Math -----
        // Dividing the irritation score of fixable problems by words to get a tentative irritation score. (Lexically, this can cause a LOT of issues. Math/physics posts are currently labled incredibly inaccuratly)
        const wordCount = textForScoring.split(/\s+/).filter(w => w.length > 0).length || 1;
        const grammarDensity = (grammarPoints / wordCount) * 100; // This gives the irritation rate as "approximatly percentage of words with issues". Not really, since irritation rate is scored on severity

        // ----- 5. Flat style penalties -----
        let stylePenalty = 0;
        if (text === text.toLowerCase() && text.length > CONFIG.ALL_LOWER_MIN_LEN) {
            stylePenalty = CONFIG.ALL_LOWER_FLAT_PENALTY;
        }

        const finalScore = grammarDensity + stylePenalty;

        // ----- 6. Fix Cleanups -----
        if (CONFIG.ENABLE_GRAMMAR_FIXES) {
            fixedText = fixedText.replace(/([?!.,]){2,}/g, '$1');
            if (fixedText.trim()) {
                fixedText = fixedText.charAt(0).toUpperCase() + fixedText.slice(1);
            }
        }

        // ----- 7. Visual Application -----
        if (CONFIG.ENABLE_SCORE_DISPLAY && finalScore > 0) {
            this.attachScoreBadge(comment, finalScore);
        }

     //   if (CONFIG.ENABLE_NUKE_BY_SCORE && finalScore >= CONFIG.SCORE_NUKE_THRESHOLD) {
     //       NukerEngine.nuke(comment, `Slop Density: ${finalScore.toFixed(1)}`);
     //   }

        return { fixedText, changeCount, score: finalScore };
    },

    attachScoreBadge(comment, score) {
        if (comment.querySelector('.grammar-score')) return;

        const badge = document.createElement('span');
        badge.className = 'grammar-score';
        badge.textContent = `SLOP: ${score.toFixed(1)}`;
        badge.style.cssText = `
            display: inline-block !important;
            background: #ffaa00 !important;
            color: black !important;
            font-size: 10px !important;
            font-weight: 900 !important;
            padding: 1px 5px !important;
            border-radius: 3px !important;
            margin-right: 10px !important;
            border: 1px solid black !important;
            vertical-align: middle !important;
            font-family: sans-serif !important;
        `;

        // Attempt to find the comment header to place the badge next to the username
        const header = comment.querySelector('div[id^="comment-header"]') || comment;
        header.insertAdjacentElement('afterbegin', badge);
    }
};

// ==================== NUKER ENGINE ====================
const NukerEngine = {
    // Core nuke function - can be called from anywhere
    nuke(comment, reason = '') {
        console.log(`[Nuker] 🔥 Nuking: ${reason}`.trim());
        comment.classList.add('nuked-short-comment');

        if (CONFIG.SHOW_PLACEHOLDER) {
            const placeholder = document.createElement('div');
            placeholder.className = 'nuker-placeholder';
            placeholder.textContent = '💬 [Comment hidden by Purple Tuxedo]';
            comment.parentNode?.insertBefore(placeholder, comment);
        }

        setTimeout(() => {
            comment.parentNode?.removeChild(comment);
        }, CONFIG.REMOVE_DELAY);
    },

    // Apply shame tuxedo (direct style, no CSS class dependency)
    applyShame(comment, cleanText) {
        comment.setAttribute('data-shamed', 'true');

        // Direct style application - Shadow DOM proof
        const styles = {
            'background': 'linear-gradient(to right, rgba(128, 0, 128, 0.12), rgba(128, 0, 128, 0.03))',
            'border-left': '4px solid #9b4d96',
            'border-top': 'none',
            'border-right': 'none',
            'border-bottom': 'none',
            'box-shadow': 'inset 0 0 0 1px rgba(128, 0, 128, 0.2)',
            'position': 'relative',
            'border-radius': '0 4px 4px 0'
        };

        Object.entries(styles).forEach(([prop, val]) => {
            comment.style.setProperty(prop, val, 'important');
        });

        // Add badge if not already present
        if (!comment.querySelector('.shame-badge')) {
            const badge = document.createElement('span');
            badge.className = 'shame-badge';
            badge.innerHTML = `${CONFIG.SHAME_EMOJI} ${CONFIG.SHAME_LABEL}`;
            badge.style.cssText = `
                display: inline-block !important;
                background: purple !important;
                color: white !important;
                font-size: 0.7em !important;
                font-weight: bold !important;
                padding: 2px 8px !important;
                border-radius: 12px !important;
                margin-right: 8px !important;
                margin-bottom: 4px !important;
                letter-spacing: 0.5px !important;
                text-transform: uppercase !important;
                border: 1px solid rgba(255,255,255,0.3) !important;
                box-shadow: 0 1px 3px rgba(0,0,0,0.3) !important;
            `;
            comment.insertBefore(badge, comment.firstChild);
        }

        console.log(`[Nuker] 🟣 Shame applied to: "${cleanText.slice(0, 30)}..."`);
    },

    // Check if a reply is strong enough to save the thread
    isStrongReply(replyElement) {
        const container = replyElement.querySelector('[slot="text"], div[id$="-post-rtjson-content"]');
        if (!container) return false;

        const text = (container.innerText || container.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length < CONFIG.CHILD_MIN_LENGTH) return false;

        const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
        if (wordCount < CONFIG.CHILD_MIN_WORDS) return false;

        if (text === text.toUpperCase() && text.length > 10) return false;

        const nonText = (text.match(/[^\p{L}\p{N}\s]/gu) || []).length;
        if (text.length > 0 && (nonText / text.length) > 0.6) return false;

        return true;
    },

    // Find direct children of a comment (Reddit DOM resilient)
    getDirectChildren(comment) {
        // Try immediate children first
        const immediate = Array.from(comment.children).filter(el =>
            el.tagName?.toLowerCase() === 'shreddit-comment'
        );
        if (immediate.length > 0) return immediate;

        // Fallback: find descendants that have this comment as parent
        return Array.from(comment.querySelectorAll('shreddit-comment')).filter(el => {
            let parent = el.parentElement;
            while (parent) {
                if (parent === comment) return true;
                if (parent.tagName?.toLowerCase() === 'shreddit-comment' &&
                    parent.getAttribute('depth') === "0") break;
                parent = parent.parentElement;
            }
            return false;
        });
    }
};

// ==================== MAIN PROCESSOR ====================
const processComment = (comment) => {
    if (comment.hasAttribute('data-processed')) return;

    const textContainer = comment.querySelector('[slot="text"], div[id$="-post-rtjson-content"]');
    if (!textContainer) return;

    const rawText = textContainer.innerText || textContainer.textContent || '';
    const cleanText = rawText.replace(/\s+/g, ' ').trim();
    if (!cleanText) return;

    // 1. Get the score (Pure logic, no nuking yet)
    const { fixedText, changeCount, score } = GrammarService.process(rawText, comment);

    // 2. Define the "Sins"
    const isTopLevel = comment.getAttribute('depth') === "0";
    const isTooShort = cleanText.length < CONFIG.MIN_LENGTH;
    const isTooSloppy = CONFIG.ENABLE_NUKE_BY_SCORE && score >= CONFIG.SCORE_NUKE_THRESHOLD;

    // 3. The Execution Logic
    if (isTopLevel && (isTooShort || isTooSloppy)) {
        const children = NukerEngine.getDirectChildren(comment);
        const strongReply = children.find(NukerEngine.isStrongReply);

        if (strongReply) {
            // Strong comment saves the thread - Apply tuxedo to top-level comment instead of supressing the entire thread
            if (CONFIG.ENABLE_GRAMMAR_FIXES && changeCount > 0) {
                textContainer.innerText = fixedText;
            }
            NukerEngine.applyShame(comment, cleanText);
            comment.setAttribute('data-processed', 'true');
        } else {
            // No hero? Nuke it once.
            const reason = isTooSloppy ? `Slop (${score.toFixed(1)}%)` : `Short (${cleanText.length} chars)`;
            NukerEngine.nuke(comment, reason);
            // Element is gone, no need to set data-processed
        }
    } else {
        // Comment survives! Apply fixes and mark as done
        if (CONFIG.ENABLE_GRAMMAR_FIXES && changeCount > 0) {
            textContainer.innerText = fixedText;
        }
        comment.setAttribute('data-processed', 'true');
    }
};

// ==================== INITIALIZATION ====================
const observer = new MutationObserver(() => {
    clearTimeout(observer.timeout);
    observer.timeout = setTimeout(() => {
        document.querySelectorAll('shreddit-comment:not([data-processed])').forEach(processComment);
    }, 250);
});

const start = () => {
    const target = document.querySelector('shreddit-app') || document.body;
    if (target) {
        observer.observe(target, { childList: true, subtree: true });

        // Initial scans
        setTimeout(() => {
            document.querySelectorAll('shreddit-comment').forEach(processComment);
        }, 500);
        setTimeout(() => {
            document.querySelectorAll('shreddit-comment').forEach(processComment);
        }, 2000);

        console.log(`🤵‍♂️ Purple Tuxedo of Shame v2.0 Active`);
        console.log(`   Nuke: <${CONFIG.MIN_LENGTH} chars | Save threshold: ${CONFIG.CHILD_MIN_LENGTH} chars / ${CONFIG.CHILD_MIN_WORDS} words`);
        if (CONFIG.ENABLE_GRAMMAR_FIXES) console.log(`   Grammar fixes: ON | Score display: ${CONFIG.ENABLE_SCORE_DISPLAY ? 'ON' : 'OFF'}`);
    } else {
        setTimeout(start, 500);
    }
};

// ==================== STYLES ====================

// Saved the thread badge no longer applied successfully. Unclear why
const style = document.createElement('style');
style.textContent = `
    .nuked-short-comment { display: none !important; }
    .nuker-placeholder {
        color: #aaa;
        font-size: 0.85em;
        font-style: italic;
        padding: 6px 12px;
        margin: 4px 0;
        background: rgba(80,80,80,0.15);
        border-left: 2px solid #666;
        border-radius: 4px;
    }
    .hero-reply {
        border-left: 3px solid #ffd700 !important;
        background: rgba(255,215,0,0.03) !important;
    }
    .hero-reply::before {
        content: "⭐ Saved the thread";
        display: inline-block;
        background: #b8860b;
        color: white;
        font-size: 0.7em;
        font-weight: bold;
        padding: 2px 8px;
        border-radius: 12px;
        margin-right: 8px;
        margin-bottom: 4px;
    }
`;
document.head.appendChild(style);

// ==================== LAUNCH ====================
start();

// Keyboard toggle for placeholders
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'X') {
        CONFIG.SHOW_PLACEHOLDER = !CONFIG.SHOW_PLACEHOLDER;
        console.log(`[Nuker] Placeholders ${CONFIG.SHOW_PLACEHOLDER ? 'on' : 'off'}`);
    }
});
