// ==UserScript==
// @name         Purple Tuxedo of Shame - 4.2.3
// @namespace    http://tampermonkey.net/
// @version      4.2.3
// @description  Hides low-effort Reddit comments and highlights substantive replies.
// @author       Magnus Ribsskog
// @match        https://www.reddit.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/*
 * Purple Tuxedo of Shame
 * ======================
 * Hides low-effort Reddit comments and highlights substantive replies.
 *
 * A comment is judged on two axes:
 *   - Length: must meet MIN_LENGTH characters.
 *   - Slop score: a weighted tally of grammar errors, slang, style issues,
 *     and punctuation problems. Higher = worse. If the score exceeds
 *     SCORE_NUKE_THRESHOLD, the comment is considered low-effort regardless
 *     of length.
 *
 * When a low-effort top-level comment has a substantive reply (a "hero"),
 * the parent gets a shame badge instead of being hidden, and the reply
 * gets a hero badge. This rewards people who bother to correct or expand
 * on lazy comments.
 *
 * Comments above UPVOTE_THRESHOLD upvotes are immune from all of the above,
 * on the assumption that community approval outweighs style concerns.
 *
 * The grammar fix feature optionally rewrites visible text nodes in-place
 * to correct apostrophes, capitalisation, and common slang — purely cosmetic,
 * does not affect voting or Reddit's data.
 *
 * Changelog
 * ---------
 * v4.2.3
 *    - Fixed Treewalker to correctly handle very short comments do to how Shreddit concatenates these.
 *      Three issues:
         1 Reddit using an empty-id wrapper element that groups a comment and all its replies into a single <shreddit-comment>
         2 The walker having no concept of "stop at the comment boundary"
         3 The inflated text length accidentally passing the very check that was supposed to catch it
 *
 * v4.2.2
 *   - Fixed regex lastIndex bug: shared global regexes now reset lastIndex = 0
 *     before each while/exec loop, preventing silent match misses on the second
 *     and subsequent calls to analyze().
 *   - Fixed upvote score parsing: suffix is now normalised to lowercase before
 *     endsWith checks, and parseFloat is used before multiplying k/m suffixes,
 *     so "1.2K" correctly yields 1200 instead of 1 (which was stripping immunity
 *     from popular comments).
 *   - Removed stale child cache: the WeakMap that stored direct child lists was
 *     never invalidated after first use. Replaced with a plain live lookup.
 *   - Removed stray empty Violentmonkey script stub from end of file.
 *
 * v4.2.1
 *   - Reordered selectors in extractCommentText() to prioritise modern Reddit
 *     elements (shreddit-text, .RichTextJSON-root, faceplate-formatted-text).
 *   - Added temporary debug logging for short extracted texts.
 */

(function () {
    'use strict';

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    //
    // These are the values you actually want to tune. Everything below this
    // block is machinery. You can change any value here and reload the page.
    //
    // The settings panel (Ctrl+Shift+P) is a placeholder for a future extension
    // UI and does not currently persist changes correctly — edit here instead.

    const DEFAULT_CONFIG = {

        // --- Scoring weights -------------------------------------------------
        // These four must add up to 1.0. They control how much each type of
        // badness contributes to the final slop score.
        WEIGHT_GRAMMAR:     0.5,   // Missing apostrophes, lowercase "i", etc.
        WEIGHT_SLANG:       0.3,   // "ur", "rn", "idk", "wanna", etc.
        WEIGHT_STYLE:       0.1,   // No sentence capitalisation, all-lowercase walls of text.
        WEIGHT_PUNCTUATION: 0.1,   // No terminal punctuation, excessive emoji density.

        // --- Nuke thresholds -------------------------------------------------
        // A comment must fail at least one of these to be considered for hiding.
        MIN_LENGTH:           200,  // Minimum character count to survive on length alone.
        SCORE_NUKE_THRESHOLD: 15,   // Slop score at or above this = low-effort regardless of length.
        ENABLE_NUKE_BY_SCORE: true, // Set false to only nuke by length, ignoring the score.

        // --- Hero detection --------------------------------------------------
        // A reply must clear both of these to rescue its lazy parent from being
        // hidden (turning a nuke into a shame badge + hero badge instead).
        CHILD_MIN_LENGTH: 200,  // Minimum characters in a reply to be considered a hero.
        CHILD_MIN_WORDS:   35,  // Minimum word count in a reply to be considered a hero.

        // --- Upvote immunity -------------------------------------------------
        // Comments at or above this upvote count are never nuked or shamed,
        // regardless of their grammar or length.
        USE_UPVOTE_IMMUNITY: true,
        UPVOTE_THRESHOLD:    800,

        // --- Display ---------------------------------------------------------
        ENABLE_SCORE_DISPLAY: false, // Show a coloured "SLOP N" badge on every comment (useful for tuning).
        SHOW_PLACEHOLDERS:    false, // Replace hidden comments with a visible "[hidden]" marker.
        WEIGHT_EMOJI:         1.0,   // Reserved for future emoji scoring; not yet wired into computeScore().

        // --- Style penalties -------------------------------------------------
        // These feed into the style component of the slop score.
        ALL_LOWER_PENALTY:       2.0, // Points added per 100 words when entire comment is lowercase.
        ALL_LOWER_MIN_LEN:       150, // Only apply the all-lowercase penalty above this character count.
        EMOJI_DENSITY_THRESHOLD: 20,  // Emoji per 100 words above this triggers the emoji penalty.
        EMOJI_PENALTY:           3,   // Points added to punctuation score when emoji density is too high.

        // --- Grammar fixing --------------------------------------------------
        ENABLE_GRAMMAR_FIXES: true, // Rewrite visible text nodes in-place to fix apostrophes, caps, slang.

        // --- Visual badges ---------------------------------------------------
        SHAME_EMOJI: "🤵‍♂️",
        SHAME_LABEL: " ",
        HERO_EMOJI:  "⭐",
        HERO_LABEL:  " ",
    };

    // Merge saved settings on top of defaults so new keys added to DEFAULT_CONFIG
    // are always present even if the user has an older saved config.
    let CONFIG = (() => {
        const saved = GM_getValue('purpleTuxedoConfig', null);
        return saved ? { ...DEFAULT_CONFIG, ...saved } : { ...DEFAULT_CONFIG };
    })();

    function saveConfig() {
        GM_setValue('purpleTuxedoConfig', CONFIG);
    }


    // =========================================================================
    // UTILITIES
    // =========================================================================

    // Safe text extractor that works on any element, including ones that might
    // not have innerText (e.g. SVG nodes).
    function getElementText(el) {
        return el?.innerText || el?.textContent || '';
    }

    // Escapes special regex characters in a string so it can be used safely
    // inside a RegExp constructor. Used when turning placeholder IDs back into
    // literal search patterns.
    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }


    // =========================================================================
    // COMMENT TEXT EXTRACTION
    // =========================================================================
    //
    // Reddit's "Shreddit" rewrite (2023-) uses Web Components, which means the
    // comment text is often hidden inside a Shadow DOM — a separate, encapsulated
    // DOM tree attached to a custom element. Normal querySelector() calls cannot
    // see inside shadow roots, so we need to check there explicitly first.
    //
    // The function tries three strategies in order, returning as soon as it finds
    // something that looks like real text (> 20 characters):
    //
    //   1. Shadow DOM: access comment.shadowRoot and look for known elements inside it.
    //   2. Light DOM: look for the same elements as direct children of the comment
    //      element, which is how older Reddit markup works.
    //   3. Nuclear fallback: manually walk every text node in the entire comment
    //      element and concatenate them, skipping nodes inside code blocks, links,
    //      and blockquotes to avoid picking up noise.

    function extractCommentText(comment) {
        if (!comment) return '';

        // --- Strategy 1: Shadow DOM ---
        // shadowRoot is null if the element has no shadow DOM, so this block only
        // runs on modern Shreddit custom elements like <shreddit-comment>.
        if (comment.shadowRoot) {
            const shadow = comment.shadowRoot;

            // Build a list of candidate elements from the shadow tree, filtering
            // out nulls (querySelector returns null when a selector does not match).
            const candidates = [
                shadow.querySelector('shreddit-text'),
                shadow.querySelector('.RichTextJSON-root'),
                shadow.querySelector('faceplate-formatted-text'),
                shadow.querySelector('[slot="text"]'),
                shadow.querySelector('div[data-slot="comment"]'),
                shadow.querySelector('div[id$="-post-rtjson-content"]'),
            ].filter(Boolean);

            for (const el of candidates) {
                const txt = getElementText(el).trim();
                if (txt.length > 20) return txt;
            }
        }

        // --- Strategy 2: Light DOM ---
        // Same selectors, but searched as descendants of the comment element
        // itself rather than inside a shadow root.
        const lightSelectors = [
            'shreddit-text',
            '.RichTextJSON-root',
            'faceplate-formatted-text',
            '[slot="text"]',
            'div[id$="-post-rtjson-content"]',
            'div.text-14',
            '.comment-body',
        ];

        for (const sel of lightSelectors) {
            const el = comment.querySelector(sel);
            if (el) {
                const txt = getElementText(el).trim();
                if (txt.length > 20) return txt;
            }
        }

        // --- Strategy 3: Text node walker ---
        // TreeWalker is a browser API that lets you iterate over every node in a
        // subtree without recursing manually. NodeFilter.SHOW_TEXT means we only
        // visit raw text nodes (not elements).
        //
        // Two important boundaries:
        //
        // a) Stop at child <shreddit-comment> elements. Without this, the walker
        //    crosses into reply comments and concatenates their text alongside the
        //    parent's, producing a falsely long string that passes the length check.
        //    Before this fix comments like "Cry" survived — its replies pushed the total
        //    well past MIN_LENGTH.
        //
        // b) Skip UI: username, timestamp, "Reply", "Share", "more replies"
        //    and similar interface strings that live as text nodes in the same wrapper
        //    and are not comment prose.
        const uiChromePattern = /^(reply|share|more replies|save|report|follow|•|\d+)$/i;

        let text = '';
        const walker = document.createTreeWalker(comment, NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) {
            const node   = walker.currentNode;
            const parent = node.parentElement;

            // Stop collecting if this text node is inside a child comment.
            if (parent && parent.closest('shreddit-comment') !== comment) continue;

            // Skip protected elements (code, links, blockquotes).
            if (parent && parent.closest('blockquote, pre, code, a[href^="http"], [class*="code"]')) continue;

            // Skip UI chrome strings.
            const val = node.textContent.trim();
            if (!val || uiChromePattern.test(val)) continue;

            text += val + ' ';
        }
        return text.trim();
    }


    // =========================================================================
    // PLACEHOLDER PROTECTOR
    // =========================================================================
    //
    // Before we score or fix a comment's text, we need to temporarily hide
    // things that should never be touched: quoted blocks, inline code, URLs,
    // markdown links, and LaTeX math. If we do not, the grammar fixer might
    // capitalise the first word of a code snippet, or count "rn" in a URL as
    // slang.
    //
    // The approach: replace each protected span with a unique token like
    // <<<URL_0>>>, run all scoring/fixing on the tokenised text, then swap the
    // tokens back to their originals at the end.

    const PlaceholderProtector = {

        // Returns the list of patterns that should be shielded.
        // Each entry has a regex that matches the span and a prefix for the token.
        getDefaultPatterns() {
            return [
                { regex: /^>.*$/gm,                 prefix: 'BLOCK'     }, // Markdown blockquotes (> text)
                { regex: /"[^"]*"|"[^"]*"/g,        prefix: 'QUOTE'     }, // "Curly" or "straight" quoted text
                { regex: /`[^`]*`/g,                prefix: 'CODE'      }, // Inline `code`
                { regex: /```[\s\S]*?```/g,         prefix: 'CODEBLOCK' }, // Fenced ```code blocks```
                { regex: /\[([^\]]+)\]\([^\)]+\)/g, prefix: 'LINK'      }, // [Markdown](links)
                { regex: /https?:\/\/[^\s]+/g,      prefix: 'URL'       }, // Raw URLs
                { regex: /\$\$?[^$]+\$\$?/g,       prefix: 'MATH'      }, // $LaTeX$ or $$display math$$
            ];
        },

        // Replaces all protected spans with tokens.
        // Returns the tokenised text AND a Map so we can restore them later.
        replaceProtected(text, patterns = this.getDefaultPatterns()) {
            const map = new Map();
            let counter = 0;
            let result = text;

            for (const { regex, prefix } of patterns) {
                result = result.replace(regex, (match) => {
                    const id = `<<<${prefix}_${counter++}>>>`;
                    map.set(id, match); // Remember the original so we can put it back.
                    return id;
                });
            }

            return { text: result, map };
        },

        // Swaps all tokens back to their original content.
        restore(text, map) {
            let result = text;
            for (const [id, original] of map) {
                result = result.replace(new RegExp(escapeRegex(id), 'g'), original);
            }
            return result;
        }
    };


    // =========================================================================
    // GRAMMAR SERVICE
    // =========================================================================
    //
    // Responsible for three things:
    //   1. Deciding whether a comment is English (skip scoring on other languages).
    //   2. Analysing text and returning raw point totals per error category.
    //   3. Optionally rewriting the visible text of a comment to fix errors.
    //
    // The slop score is NOT a simple count of errors. It is normalised by word
    // count so that a long comment with one error is not penalised as heavily as
    // a short comment with one error. See computeScore() for the final formula.

    const GrammarService = {

        // Cached language detection result for the current page. Reset when the
        // URL changes (i.e. when the user navigates to a different thread).
        isEnglishThread: null,
        lastUrl: null,

        // The dictionary maps a misspelled/slangy word (all lowercase, no
        // apostrophe) to its correct form, its category, and a severity score.
        // Higher score = more points added when this word is found.
        // Category is either "grammar" (weighted by WEIGHT_GRAMMAR) or
        // "slang" (weighted by WEIGHT_SLANG).
        dictionary: {
            // Grammar: missing apostrophes
            "arent":    { fix: "aren't",    category: "grammar", score: 4 },
            "cant":     { fix: "can't",     category: "grammar", score: 4 },
            "couldnt":  { fix: "couldn't",  category: "grammar", score: 2 },
            "didnt":    { fix: "didn't",    category: "grammar", score: 5 },
            "dont":     { fix: "don't",     category: "grammar", score: 6 },
            "havent":   { fix: "haven't",   category: "grammar", score: 2 },
            "hes":      { fix: "he's",      category: "grammar", score: 5 },
            "isnt":     { fix: "isn't",     category: "grammar", score: 5 },
            "shes":     { fix: "she's",     category: "grammar", score: 4 },
            "shouldnt": { fix: "shouldn't", category: "grammar", score: 2 },
            "theyre":   { fix: "they're",   category: "grammar", score: 5 },
            "wont":     { fix: "won't",     category: "grammar", score: 4 },
            "wouldnt":  { fix: "wouldn't",  category: "grammar", score: 2 },
            "youre":    { fix: "you're",    category: "grammar", score: 6 },
            "i":        { fix: "I",         category: "grammar", score: 4 }, // Lowercase "i" as a pronoun

            // Slang: abbreviations and informal words
            "cuz":   { fix: "because",       category: "slang", score: 4 },
            "idc":   { fix: "I don't care",  category: "slang", score: 2 },
            "idk":   { fix: "I don't know",  category: "slang", score: 1 },
            "ikr":   { fix: "I know, right", category: "slang", score: 4 },
            "imo":   { fix: "in my opinion", category: "slang", score: 1 },
            "kinda": { fix: "kind of",       category: "slang", score: 1 },
            "rn":    { fix: "right now",     category: "slang", score: 6 },
            "tbh":   { fix: "to be honest",  category: "slang", score: 1 },
            "ur":    { fix: "your",          category: "slang", score: 5 },
            "wanna": { fix: "want to",       category: "slang", score: 2 },
        },

        // Words that end with a dot without ending a sentence.
        // Used to avoid penalising "Dr. Smith said..." as a missing capital.
        abbreviations: new Set([
            'vs', 'etc', 'vol', 'al', 'mr', 'mrs', 'ms', 'dr', 'prof', 'capt',
            'gen', 'sen', 'rep', 'st', 'ave', 'blvd',
            'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
        ]),

        // These are compiled once at startup by initRegexes() and reused for
        // every comment. Compiling a regex is expensive; running it is cheap.
        // IMPORTANT: both use the 'g' flag, which makes them stateful — they
        // remember the position of the last match via .lastIndex. Always reset
        // .lastIndex = 0 before using them in a loop.
        dictRegex: null,
        sentenceStartRegex: null,

        // Build the two regexes from the dictionary keys.
        // Called once at the bottom of the file before anything else runs.
        initRegexes() {
            // Matches any dictionary word (with optional trailing punctuation).
            // 'gi' = global (find all matches) + case-insensitive.
            const keys = Object.keys(this.dictionary).join('|');
            this.dictRegex = new RegExp(`\\b(${keys})[.,!?;:"']?\\b`, 'gi');

            // Matches a lowercase letter that starts a sentence.
            // A sentence start is: beginning of string, or ./?/! followed by whitespace.
            this.sentenceStartRegex = /(^|[.!?]\s+)([a-z])/g;
        },

        // Returns true if the text looks like English, false if not, null if
        // the text is too short to tell.
        // Result is cached per URL — we only run detection once per thread.
        detectLanguage(text, skipShielding = false) {
            // Reset cache when the user navigates to a new URL.
            if (window.location.href !== this.lastUrl) {
                this.isEnglishThread = null;
                this.lastUrl = window.location.href;
            }
            if (this.isEnglishThread !== null) return this.isEnglishThread;

            // Optionally shield the text first to avoid matching "the" inside a URL.
            let textToAnalyze = text;
            if (!skipShielding) {
                const { text: protectedText } = PlaceholderProtector.replaceProtected(text);
                textToAnalyze = protectedText;
            }

            // Count how many distinct common English words appear.
            const commonEnglish = /\b(the|and|that|this|with|from|you|are|have|for|not|with|but)\b/gi;
            const matches       = textToAnalyze.match(commonEnglish) || [];
            const uniqueMatches = new Set(matches.map(m => m.toLowerCase()));

            // Only commit to a verdict if the text is long enough to be meaningful.
            if (textToAnalyze.length > 150) {
                this.isEnglishThread = uniqueMatches.size >= 3;
            }
            return this.isEnglishThread ?? true; // Default to English if unsure.
        },

        // Scans the text for errors and returns raw point totals per category.
        // Does NOT compute the final score — that is computeScore()'s job.
        analyze(rawText) {
            const clean     = rawText.replace(/\s+/g, ' ').trim();
            const words     = clean.split(/\s+/).filter(w => w.length > 0);
            const wordCount = words.length || 1; // Avoid division by zero in computeScore().

            // Skip very short comments and non-English text.
            if (clean.length < 50 || !this.detectLanguage(rawText, true)) {
                return { grammarPoints: 0, slangPoints: 0, stylePoints: 0, punctuationPoints: 0, wordCount };
            }

            // Shield protected spans before scanning.
            const { text: protectedText } = PlaceholderProtector.replaceProtected(clean);

            let grammarPoints = 0, slangPoints = 0, stylePoints = 0, punctuationPoints = 0;

            // --- Dictionary scan ---
            // Find every word that matches the dictionary and add its score to
            // the appropriate category bucket.
            // lastIndex must be reset because dictRegex is a shared stateful
            // object — without the reset, the second call to analyze() would
            // start scanning from wherever the first call left off, missing matches.
            let match;
            this.dictRegex.lastIndex = 0;
            while ((match = this.dictRegex.exec(protectedText)) !== null) {
                const word  = match[1].toLowerCase();
                const entry = this.dictionary[word];
                if (entry) {
                    if (entry.category === 'grammar') grammarPoints += entry.score;
                    else if (entry.category === 'slang') slangPoints += entry.score;
                }
            }

            // --- Sentence capitalisation ---
            // Find every lowercase letter that appears at the start of a sentence.
            // Before penalising, check that the preceding word is not an abbreviation
            // (e.g. "Dr." or "Jan.") since those end with a dot but do not end sentences.
            this.sentenceStartRegex.lastIndex = 0;
            while ((match = this.sentenceStartRegex.exec(protectedText)) !== null) {
                const before  = protectedText.substring(0, match.index);
                let prevWord  = before.split(/\s+/).pop()?.replace(/[.,!?;:"'()[\]]+$/, '').toLowerCase() || '';
                if (!this.abbreviations.has(prevWord)) {
                    stylePoints += 4;
                }
            }

            // --- All-lowercase wall of text ---
            // A comment that is entirely lowercase AND long enough to know better.
            if (clean === clean.toLowerCase() && clean.length > CONFIG.ALL_LOWER_MIN_LEN) {
                stylePoints += CONFIG.ALL_LOWER_PENALTY * (wordCount / 100);
            }

            // --- No terminal punctuation ---
            // A comment that does not end with . ! or ? loses points.
            if (!/[.!?]$/.test(clean)) {
                punctuationPoints += 8;
            }

            // --- Emoji density ---
            // A comment that is more emoji than words is low-effort.
            // \p{Emoji_Presentation} matches emoji that render as pictures (not (tm) etc.)
            const emojiCount   = (clean.match(/\p{Emoji_Presentation}/gu) || []).length;
            const emojiDensity = (emojiCount / wordCount) * 100;
            if (emojiDensity > CONFIG.EMOJI_DENSITY_THRESHOLD) {
                punctuationPoints += CONFIG.EMOJI_PENALTY;
            }

            return { grammarPoints, slangPoints, stylePoints, punctuationPoints, wordCount };
        },

        // Converts the raw point totals from analyze() into a single slop score.
        // Each category is first normalised to a density (points per 100 words)
        // so that a short comment with one error scores the same as a long comment
        // with the same error rate. The densities are then combined using the
        // weights from CONFIG.
        computeScore(analysis) {
            const { grammarPoints, slangPoints, stylePoints, punctuationPoints, wordCount } = analysis;

            const grammarDensity     = (grammarPoints     / wordCount) * 100;
            const slangDensity       = (slangPoints       / wordCount) * 100;
            const styleDensity       = (stylePoints       / wordCount) * 100;
            // Punctuation is halved before weighting — it is a blunt signal and
            // would otherwise dominate the score on short comments.
            const punctuationDensity = (punctuationPoints / wordCount) * 100 * 0.5;

            return grammarDensity     * CONFIG.WEIGHT_GRAMMAR     +
                   slangDensity       * CONFIG.WEIGHT_SLANG       +
                   styleDensity       * CONFIG.WEIGHT_STYLE       +
                   punctuationDensity * CONFIG.WEIGHT_PUNCTUATION;
        },

        // Rewrites a single text node in-place, correcting grammar and style.
        // A text node is the raw string of characters inside an element — the
        // "hello world" in <p>hello world</p>. We edit nodeValue directly rather
        // than innerHTML to avoid touching any HTML structure.
        applyFixesToTextNode(textNode) {
            if (!CONFIG.ENABLE_GRAMMAR_FIXES) return;
            const original = textNode.nodeValue?.trim();
            if (!original || original.length < 3) return;
            if (this.detectLanguage(original, true) === false) return;

            // Shield protected spans so we do not corrupt code or URLs.
            const { text: protectedText, map } = PlaceholderProtector.replaceProtected(
                original,
                PlaceholderProtector.getDefaultPatterns()
            );
            let fixed = protectedText;

            // Apply dictionary substitutions. Preserve the original capitalisation
            // of the first letter so "Dont" becomes "Don't" not "don't".
            this.dictRegex.lastIndex = 0;
            fixed = fixed.replace(this.dictRegex, (m) => {
                const entry = this.dictionary[m.toLowerCase()];
                if (!entry) return m;
                if (m[0] === m[0].toUpperCase()) {
                    return entry.fix.charAt(0).toUpperCase() + entry.fix.slice(1);
                }
                return entry.fix;
            });

            // Fix standalone lowercase "i" as a pronoun.
            // Only do this for longer ASCII text — short or non-ASCII strings
            // might legitimately use "i" as a variable name or non-English word.
            if (original.split(/\s+/).length > 8 && !/[^\x00-\x7F]/.test(original)) {
                fixed = fixed.replace(/\bi\b(?![0-9-])/g, 'I');
            }

            // Capitalise the first letter after a sentence-ending punctuation mark,
            // unless the word before it was an abbreviation.
            this.sentenceStartRegex.lastIndex = 0;
            fixed = fixed.replace(/(^|[.!?]\s+)([a-z])/g, (match, p1, p2, offset, full) => {
                const before = full.substring(0, offset);
                let prev     = before.split(/\s+/).pop()?.replace(/[.,!?;:"'()[\]]+$/, '').toLowerCase() || '';
                if (this.abbreviations.has(prev)) return match;
                return p1 + p2.toUpperCase();
            });

            // Restore shielded spans and write back to the DOM only if something changed.
            const final = PlaceholderProtector.restore(fixed, map);
            if (final !== original) {
                textNode.nodeValue = final;
            }
        },

        // Attaches a coloured "SLOP N" badge to a comment, visible only when
        // ENABLE_SCORE_DISPLAY is true. Useful when tuning thresholds.
        // Colour goes from green (score 0) to red (score 20+) via HSL hue rotation.
        attachScoreBadge(comment, score) {
            if (!CONFIG.ENABLE_SCORE_DISPLAY) return;
            if (comment.querySelector('.grammar-score')) return; // Already badged.
            if (this.isEnglishThread === false) return;

            const hue   = Math.max(0, Math.min(120 - score * 6, 120)); // 120 = green, 0 = red
            const color = `hsl(${hue}, 90%, 45%)`;
            const badge = document.createElement('span');
            badge.className   = 'grammar-score';
            badge.textContent = `SLOP ${Math.round(score)}`;
            badge.style.cssText = `
                display: inline-block !important; background: ${color} !important;
                color: white !important; font-size: 10px !important; font-weight: 900 !important;
                padding: 1px 6px !important; border-radius: 4px !important;
                margin-right: 8px !important; vertical-align: middle !important;
                font-family: sans-serif !important;
            `;

            const header = comment.querySelector('div[id^="comment-header"], shreddit-comment > div:first-child') || comment;
            header.insertAdjacentElement('afterbegin', badge);
        }
    };


    // =========================================================================
    // NUKER ENGINE
    // =========================================================================
    //
    // Makes the decisions and applies DOM changes. Uses GrammarService for
    // scores and extractCommentText() for the raw text.

    const NukerEngine = {

        // Hides a comment by adding a CSS class that sets display:none.
        // Optionally inserts a visible placeholder where the comment was.
        hideComment(comment, reason = '') {
            console.log(`[Nuker] Hiding: ${reason}`.trim());
            comment.classList.add('nuked-comment');
            if (CONFIG.SHOW_PLACEHOLDERS) {
                const ph = document.createElement('div');
                ph.className   = 'nuker-placeholder';
                ph.textContent = '[Comment hidden by Purple Tuxedo]';
                comment.parentNode?.insertBefore(ph, comment);
            }
        },

        // Reads the upvote count from a comment element.
        // Reddit uses several different elements for this across its markup
        // versions, so we try them in order of reliability.
        // Returns the score as a number, or null if it cannot be found.
        getCommentScore(comment) {
            if (!CONFIG.USE_UPVOTE_IMMUNITY) return null;

            const selectors = [
                'faceplate-number[number]',      // Modern Shreddit: score in a 'number' attribute
                '[data-testid="comment-score"]', // Older Reddit: score in a test-id element
                '.score',                        // Legacy Reddit
                'faceplate-number',              // Shreddit fallback without the attribute
                '[aria-label*="upvotes"]',       // Accessibility label containing "upvotes"
                '[aria-label*="points"]',        // Accessibility label containing "points"
            ];

            for (const sel of selectors) {
                const el = comment.querySelector(sel);
                if (!el) continue;

                // Try the 'number' attribute first (most reliable), then text content,
                // then the aria-label. Strip everything except digits, dots, and k/m suffixes.
                // Lowercase before suffix check: "1.2K" must become "1.2k" to match endsWith('k').
                // parseFloat before multiplying: "1.2k" gives 1200, not 1000 (which parseInt would give).
                let val = (
                    el.getAttribute('number') ||
                    el.textContent             ||
                    el.getAttribute('aria-label') ||
                    ''
                ).replace(/[^0-9kKmM.-]/g, '').trim().toLowerCase();

                if      (val.endsWith('k')) val = parseFloat(val) * 1000;
                else if (val.endsWith('m')) val = parseFloat(val) * 1000000;

                const num = parseInt(val, 10);
                if (!isNaN(num)) return num;
            }
            return null;
        },

        hasUpvoteImmunity(comment) {
            const score = this.getCommentScore(comment);
            return score !== null && score >= CONFIG.UPVOTE_THRESHOLD;
        },

        // Inserts a small purple badge at the top of a shame-worthy comment.
        applyShameBadge(comment) {
            if (comment.querySelector('.shame-badge')) return; // Already badged.
            const badge = document.createElement('span');
            badge.className = 'shame-badge';
            badge.innerHTML = `${CONFIG.SHAME_EMOJI} ${CONFIG.SHAME_LABEL}`;
            badge.style.cssText = `
                display: inline-block !important; background: #9b4d96 !important; color: white !important;
                font-size: 0.7em !important; font-weight: bold !important; padding: 2px 8px !important;
                border-radius: 12px !important; margin-right: 8px !important; margin-bottom: 4px !important;
                letter-spacing: 0.5px !important; text-transform: uppercase !important;
                border: 1px solid rgba(255,255,255,0.3) !important; box-shadow: 0 1px 3px rgba(0,0,0,0.3) !important;
            `;
            comment.insertBefore(badge, comment.firstChild);
        },

        // Inserts a gold star badge and a gold left border on a hero reply.
        applyHeroBadge(comment) {
            if (comment.querySelector('.hero-badge')) return; // Already badged.
            const badge = document.createElement('span');
            badge.className = 'hero-badge';
            badge.innerHTML = `${CONFIG.HERO_EMOJI}${CONFIG.HERO_LABEL}`;
            badge.style.cssText = `
                display: inline-block !important; background: #b8860b !important; color: white !important;
                font-size: 0.7em !important; font-weight: bold !important; padding: 2px 8px !important;
                border-radius: 12px !important; margin-right: 8px !important; margin-bottom: 4px !important;
                letter-spacing: 0.5px !important; text-transform: uppercase !important;
                border: 1px solid rgba(255,255,255,0.3) !important; box-shadow: 0 1px 3px rgba(0,0,0,0.3) !important;
            `;
            comment.insertBefore(badge, comment.firstChild);
            comment.classList.add('hero-reply'); // Triggers the gold left-border defined in CSS below.
        },

        // Decides whether a reply qualifies as a "hero" that can rescue its
        // lazy parent from being hidden.
        isStrongReply(replyElement) {
            const text  = extractCommentText(replyElement).replace(/\s+/g, ' ').trim();
            const words = text.split(/\s+/).filter(w => w.length > 0);

            if (text.length < CONFIG.CHILD_MIN_LENGTH) return false; // Too short.
            if (words.length < CONFIG.CHILD_MIN_WORDS)  return false; // Too few words.

            // All-caps comments (SHOUTING) are not heroes.
            if (text === text.toUpperCase() && text.length > 10) return false;

            // If more than 60% of the text is non-letter/non-digit characters,
            // it is probably a wall of emoji or symbols, not real prose.
            const nonText = (text.match(/[^\p{L}\p{N}\s]/gu) || []).length;
            if (text.length > 0 && (nonText / text.length) > 0.6) return false;

            // A long comment with fewer than two sentence-ending punctuation marks
            // is probably a run-on, not a thoughtful reply.
            const sentenceCount = (text.match(/[.!?]/g) || []).length;
            if (text.length > 200 && sentenceCount < 2) return false;

            return true;
        },

        // Returns the direct child <shreddit-comment> elements of a comment,
        // i.e. immediate replies only (not replies to replies).
        // This is a live lookup rather than a cached one, so it always reflects
        // the current state of the DOM, including replies that loaded after the parent.
        getDirectChildren(comment) {
            return Array.from(comment.children).filter(
                el => el.tagName?.toLowerCase() === 'shreddit-comment'
            );
        },

        // Walks all text nodes inside a comment element and applies grammar fixes
        // to each one. Skips text inside code blocks, links, images, and score
        // elements so we do not corrupt things that should not be touched.
        applyFixesToTextNodes(root) {
            if (!CONFIG.ENABLE_GRAMMAR_FIXES) return;

            const protectedSelectors = ['blockquote', 'code', 'pre', 'a', 'img', 'faceplate-number'];

            // TreeWalker with a filter function:
            //   FILTER_REJECT skips a node AND all its descendants.
            //   FILTER_ACCEPT includes the node for processing.
            // We reject any text node whose parent (or any ancestor) matches
            // one of the protected element selectors.
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode: node => {
                    let p = node.parentElement;
                    while (p) {
                        if (protectedSelectors.some(s => p.matches?.(s))) return NodeFilter.FILTER_REJECT;
                        p = p.parentElement;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            });

            let node;
            while (node = walker.nextNode()) {
                GrammarService.applyFixesToTextNode(node);
            }
        },

        // The main entry point. Called once per comment element.
        // Runs all checks and applies the appropriate outcome.
        processComment(comment) {
            // data-processed is a custom attribute we stamp onto elements we have
            // already handled, so we never process the same comment twice.
            if (comment.hasAttribute('data-processed')) return;

            const rawText   = extractCommentText(comment);
            const cleanText = rawText.replace(/\s+/g, ' ').trim();

            // Debug logging: helps diagnose extraction failures on threads where
            // comments appear shorter than expected. Remove when no longer needed.
            if (cleanText.length < CONFIG.MIN_LENGTH * 0.5) {
                console.log('[Debug] Short text extracted:', cleanText.substring(0, 100), 'from', window.location.href);
            }

            // Skip comments where extraction clearly failed — empty or just a
            // handful of characters that can't be meaningful text. This is distinct
            // from a short comment like "cry" (3 chars, legitimate, should be nuked):
            // that will pass this check and then fail the MIN_LENGTH check below.
            // The threshold of 3 here is intentionally minimal — just enough to
            // skip elements where Reddit rendered nothing we could find.
            if (!cleanText || cleanText.length < 3) {
                comment.setAttribute('data-processed', 'true');
                return;
            }

            // Skip comments that are popular enough to be immune.
            if (this.hasUpvoteImmunity(comment)) {
                comment.setAttribute('data-processed', 'true');
                return;
            }

            const analysis = GrammarService.analyze(rawText);
            const score    = GrammarService.computeScore(analysis);

            // A top-level comment has no <shreddit-comment> ancestor.
            // We only nuke or shame top-level comments — replies are judged
            // differently (they can be heroes, but are never nuked directly).
            const isTopLevel  = !comment.parentElement?.closest('shreddit-comment');
            const isTooShort  = cleanText.length < CONFIG.MIN_LENGTH;
            const isTooSloppy = CONFIG.ENABLE_NUKE_BY_SCORE && score >= CONFIG.SCORE_NUKE_THRESHOLD;

            // Apply grammar fixes regardless of whether the comment will be nuked.
            if (CONFIG.ENABLE_GRAMMAR_FIXES) {
                this.applyFixesToTextNodes(comment);
            }

            // Optionally show the numeric slop score (useful for threshold tuning).
            GrammarService.attachScoreBadge(comment, score);

            if (isTopLevel && (isTooShort || isTooSloppy)) {
                // Check if any direct reply qualifies as a hero.
                const children    = this.getDirectChildren(comment);
                const strongReply = children.find(c => this.isStrongReply(c));

                if (strongReply) {
                    // A hero exists: shame the parent, crown the reply.
                    this.applyShameBadge(comment);
                    this.applyHeroBadge(strongReply);
                } else {
                    // No hero: hide the comment entirely.
                    const reason = isTooSloppy
                        ? `Slop (${score.toFixed(1)})`
                        : `Short (${cleanText.length} chars)`;
                    this.hideComment(comment, reason);
                }
            }

            comment.setAttribute('data-processed', 'true');
        }
    };


    // =========================================================================
    // COMMENT PROCESSOR
    // =========================================================================
    //
    // Watches the page for new comments and triggers NukerEngine.processComment()
    // on each one as it appears. Uses two browser observer APIs:
    //
    // MutationObserver fires whenever child elements are added to or removed from
    // a watched node. Reddit adds comments dynamically as you scroll or expand
    // threads, so we need this to catch comments that appear after initial load.
    //
    // IntersectionObserver fires when an element enters or exits the viewport.
    // We wait until a comment is about to scroll into view (with a 200px lookahead)
    // before processing it, to avoid doing scoring work on hundreds of off-screen
    // comments at once.

    class CommentProcessor {
        constructor() {
            this.observer = new MutationObserver(this.handleMutations.bind(this));

            this.intersectionObserver = new IntersectionObserver(
                entries => {
                    entries.forEach(entry => {
                        if (entry.isIntersecting) {
                            NukerEngine.processComment(entry.target);
                            // Stop watching this element once processed —
                            // there is no need to reprocess it on every scroll event.
                            this.intersectionObserver.unobserve(entry.target);
                        }
                    });
                },
                { rootMargin: '200px' } // Begin processing 200px before the element enters view.
            );
        }

        start() {
            // Watch the Shreddit app root, or the whole body if it is not found.
            const target = document.querySelector('shreddit-app') || document.body;
            this.observer.observe(target, { childList: true, subtree: true });

            // Register any comments already on the page at load time.
            document.querySelectorAll('shreddit-comment:not([data-processed])').forEach(el => {
                this.intersectionObserver.observe(el);
            });

            console.log(`Purple Tuxedo of Shame v4.2.2 active`);
            console.log(` Nuke: <${CONFIG.MIN_LENGTH} chars | Save: ${CONFIG.CHILD_MIN_LENGTH} chars / ${CONFIG.CHILD_MIN_WORDS} words`);
            console.log(` Score threshold: ${CONFIG.SCORE_NUKE_THRESHOLD} | Upvote immunity: ${CONFIG.USE_UPVOTE_IMMUNITY ? `>=${CONFIG.UPVOTE_THRESHOLD}` : 'OFF'}`);
        }

        // Called by MutationObserver whenever the DOM changes under the watched root.
        // We look through every newly added node and register any new comment elements
        // with the IntersectionObserver so they will be processed when they become visible.
        handleMutations(mutations) {
            for (const mut of mutations) {
                for (const node of mut.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;

                    if (node.matches?.('shreddit-comment')) {
                        // The added node itself is a comment.
                        this.intersectionObserver.observe(node);
                    } else {
                        // The added node might contain comments as descendants.
                        node.querySelectorAll?.('shreddit-comment').forEach(
                            el => this.intersectionObserver.observe(el)
                        );
                    }
                }
            }
        }
    }


    // =========================================================================
    // SETTINGS PANEL
    // =========================================================================
    //
    // A floating UI accessible via Ctrl+Shift+P or the Tampermonkey menu.
    // Placeholder for a future extension settings page.
    // To change settings, edit DEFAULT_CONFIG at the top of this file instead.

    function createSettingsPanel() {
        const panel = document.createElement('div');
        panel.id = 'purple-tuxedo-settings';
        panel.style.cssText = `
            position: fixed; top: 60px; right: 20px; width: 320px;
            background: #222; color: #fff; border: 2px solid #9b4d96; border-radius: 8px;
            padding: 15px; z-index: 999999; font-family: sans-serif; font-size: 14px;
            display: none; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        `;
        panel.innerHTML = `
            <h3 style="margin-top:0; color:#9b4d96;">Purple Tuxedo Settings</h3>
            <label><input type="checkbox" id="pt-enable-grammar" ${CONFIG.ENABLE_GRAMMAR_FIXES ? 'checked' : ''}> Grammar fixes</label><br>
            <label><input type="checkbox" id="pt-enable-score" ${CONFIG.ENABLE_SCORE_DISPLAY ? 'checked' : ''}> Show slop score</label><br>
            <label><input type="checkbox" id="pt-nuke-by-score" ${CONFIG.ENABLE_NUKE_BY_SCORE ? 'checked' : ''}> Nuke by score</label><br>
            <label>Nuke threshold: <input type="number" id="pt-score-threshold" value="${CONFIG.SCORE_NUKE_THRESHOLD}" min="0" max="100" step="1"></label><br>
            <label>Min length: <input type="number" id="pt-min-length" value="${CONFIG.MIN_LENGTH}" min="0" step="10"></label><br>
            <label>Upvote immunity: <input type="checkbox" id="pt-upvote-immunity" ${CONFIG.USE_UPVOTE_IMMUNITY ? 'checked' : ''}></label><br>
            <label>Immunity threshold: <input type="number" id="pt-upvote-threshold" value="${CONFIG.UPVOTE_THRESHOLD}" min="0" step="10"></label><br>
            <label>Emoji penalty: <input type="number" id="pt-emoji-penalty" value="${CONFIG.EMOJI_PENALTY}" min="0" step="1"></label><br>
            <label>Emoji density %: <input type="number" id="pt-emoji-density" value="${CONFIG.EMOJI_DENSITY_THRESHOLD}" min="0" max="100" step="1"></label><br>
            <button id="pt-save-settings">Save</button>
            <button id="pt-close-settings">Close</button>
        `;
        document.body.appendChild(panel);

        document.getElementById('pt-save-settings').onclick = () => {
            CONFIG.ENABLE_GRAMMAR_FIXES    = document.getElementById('pt-enable-grammar').checked;
            CONFIG.ENABLE_SCORE_DISPLAY    = document.getElementById('pt-enable-score').checked;
            CONFIG.ENABLE_NUKE_BY_SCORE    = document.getElementById('pt-nuke-by-score').checked;
            CONFIG.SCORE_NUKE_THRESHOLD    = parseInt(document.getElementById('pt-score-threshold').value, 10) || 15;
            CONFIG.MIN_LENGTH              = parseInt(document.getElementById('pt-min-length').value, 10) || 200;
            CONFIG.USE_UPVOTE_IMMUNITY     = document.getElementById('pt-upvote-immunity').checked;
            CONFIG.UPVOTE_THRESHOLD        = parseInt(document.getElementById('pt-upvote-threshold').value, 10) || 800;
            CONFIG.EMOJI_PENALTY           = parseInt(document.getElementById('pt-emoji-penalty').value, 10) || 3;
            CONFIG.EMOJI_DENSITY_THRESHOLD = parseInt(document.getElementById('pt-emoji-density').value, 10) || 20;
            saveConfig();
            panel.style.display = 'none';
            location.reload();
        };

        document.getElementById('pt-close-settings').onclick = () => {
            panel.style.display = 'none';
        };

        return panel;
    }


    // =========================================================================
    // CSS
    // =========================================================================

    const style = document.createElement('style');
    style.textContent = `
        /* Hidden comments: removed from layout entirely. */
        .nuked-comment { display: none !important; }

        /* Shown in place of a hidden comment when SHOW_PLACEHOLDERS is true. */
        .nuker-placeholder {
            color: #aaa; font-size: 0.85em; font-style: italic; padding: 6px 12px;
            margin: 4px 0; background: rgba(80,80,80,0.15);
            border-left: 2px solid #666; border-radius: 4px;
        }

        /* Hero reply: gold left border and a very faint gold background tint. */
        .hero-reply {
            border-left: 3px solid #ffd700 !important;
            background: rgba(255,215,0,0.03) !important;
        }
    `;
    document.head.appendChild(style);


    // =========================================================================
    // LAUNCH
    // =========================================================================

    GrammarService.initRegexes(); // Must run before any comment is processed.

    const processor = new CommentProcessor();
    processor.start();

    // Keyboard shortcut: Ctrl+Shift+P opens/closes the settings panel.
    document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.shiftKey && e.key === 'P') {
            e.preventDefault();
            const panel = document.getElementById('purple-tuxedo-settings') || createSettingsPanel();
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        }
    });

    // Also expose the settings panel in the Tampermonkey extension menu.
    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('Purple Tuxedo Settings', () => {
            const panel = document.getElementById('purple-tuxedo-settings') || createSettingsPanel();
            panel.style.display = 'block';
        });
    }

})();
