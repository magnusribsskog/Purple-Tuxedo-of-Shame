// ==UserScript==
// @name         Purple Tuxedo of Shame - 4.3.0
// @namespace    http://tampermonkey.net/
// @version      4.3.0
// @description  Nukes low-effort comments, rewards heroes on Reddit
// @author       Magnus Ribsskog
// @match        https://www.reddit.com/*
// @require      https://raw.githubusercontent.com/magnusribsskog/Purple-Tuxedo-of-Shame/main/grammar-fixer.js
// @grant        none
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
 * Text correction is handled by grammar-fixer.js (GrammarFixer, PlaceholderProtector).
 * Slop scoring lives here.
 *
 * Changelog
 * ---------
 * v4.3.0
 *   - Extracted GrammarFixer and PlaceholderProtector into grammar-fixer.js.
 *     GrammarService now delegates all text correction to GrammarFixer.fix().
 *     GrammarService retains language detection, slop scoring, and badge display.
 *   - Removed settings panel (Ctrl+Shift+P). To change settings, edit DEFAULT_CONFIG.
 *   - Removed GM_getValue/GM_setValue config persistence — edit DEFAULT_CONFIG directly.
 *
 * v4.2.3
 *   - ProcessComment now gates on isTopLevel before any extraction or scoring.
 *     Replies are marked processed and returned immediately, preventing the
 *     IntersectionObserver from re-queuing them on every scroll event.
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
 *
 * v4.2.4
 *   - Fixed short comments surviving length filter. Strategies 1 and 2 in
 *     extractCommentText() were rejecting legitimate short texts (< 20 chars)
 *     and falling through to strategy 3, which leaked child comment text into
 *     the extraction and inflated apparent length past MIN_LENGTH. Threshold
 *     changed to > 0: if the element is found and non-empty, that is the text.
 */

(function () {
    'use strict';

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    //
    // These are the values you actually want to tune. Everything below this
    // block is machinery. You can change any value here and reload the page.

    const CONFIG = {

        // --- Scoring weights -------------------------------------------------
        // These four must add up to 1.0. They control how much each type of
        // badness contributes to the final slop score.
        WEIGHT_GRAMMAR:     0.6,   // Missing apostrophes, lowercase "i", etc.
        WEIGHT_SLANG:       0.3,   // "ur", "rn", "idk", "wanna", etc.
        WEIGHT_STYLE:       0.1,   // No sentence capitalisation, all-lowercase walls of text.
        WEIGHT_PUNCTUATION: 0.0,   // No terminal punctuation, excessive emoji density.

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


    // =========================================================================
    // UTILITIES
    // =========================================================================

    function getElementText(el) {
        return el?.innerText || el?.textContent || '';
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
    // a non-empty result from a known element. Strategy 3 is only reached when
    // no known element can be found at all.
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
        if (comment.shadowRoot) {
            const shadow = comment.shadowRoot;
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
                if (txt.length > 0) return txt;
            }
        }

        // --- Strategy 2: Light DOM ---
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
                if (txt.length > 0) return txt;
            }
        }

        // --- Strategy 3: Text node walker ---
        const uiChromePattern = /^(reply|share|more replies|save|report|follow|•|\d+)$/i;

        let text = '';
        const walker = document.createTreeWalker(comment, NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) {
            const node   = walker.currentNode;
            const parent = node.parentElement;

            if (parent && parent.closest('shreddit-comment') !== comment) continue;
            if (parent && parent.closest('blockquote, pre, code, a[href^="http"], [class*="code"]')) continue;

            const val = node.textContent.trim();
            if (!val || uiChromePattern.test(val)) continue;

            text += val + ' ';
        }
        return text.trim();
    }


    // =========================================================================
    // GRAMMAR SERVICE
    // =========================================================================
    //
    // Responsible for two things:
    //   1. Deciding whether a comment is English (skip scoring on other languages).
    //   2. Analysing text and returning a slop score.
    //
    // Text correction (fixing "dont" → "don't", etc.) is handled by GrammarFixer
    // in grammar-fixer.js. GrammarService.analyze() uses GrammarFixer.dictionary
    // and GrammarFixer's compiled regexes as its source of truth for what counts
    // as a grammar or slang error.

    const GrammarService = {

        isEnglishThread: null,
        lastUrl: null,

        detectLanguage(text, skipShielding = false) {
            if (window.location.href !== this.lastUrl) {
                this.isEnglishThread = null;
                this.lastUrl = window.location.href;
            }
            if (this.isEnglishThread !== null) return this.isEnglishThread;

            let textToAnalyze = text;
            if (!skipShielding) {
                const { text: protectedText } = PlaceholderProtector.replaceProtected(text);
                textToAnalyze = protectedText;
            }

            const commonEnglish = /\b(the|and|that|this|with|from|you|are|have|for|not|with|but)\b/gi;
            const matches       = textToAnalyze.match(commonEnglish) || [];
            const uniqueMatches = new Set(matches.map(m => m.toLowerCase()));

            if (textToAnalyze.length > 150) {
                this.isEnglishThread = uniqueMatches.size >= 3;
            }
            return this.isEnglishThread ?? true;
        },

        analyze(rawText) {
            const clean     = rawText.replace(/\s+/g, ' ').trim();
            const words     = clean.split(/\s+/).filter(w => w.length > 0);
            const wordCount = words.length || 1;

            if (clean.length < 50 || !this.detectLanguage(rawText, true)) {
                return { grammarPoints: 0, slangPoints: 0, stylePoints: 0, punctuationPoints: 0, wordCount };
            }

            const { text: protectedText } = PlaceholderProtector.replaceProtected(clean);

            let grammarPoints = 0, slangPoints = 0, stylePoints = 0, punctuationPoints = 0;

            let match;
            GrammarFixer.dictRegex.lastIndex = 0;
            while ((match = GrammarFixer.dictRegex.exec(protectedText)) !== null) {
                const word  = match[1].toLowerCase();
                const entry = GrammarFixer.dictionary[word];
                if (entry) {
                    if (entry.category === 'grammar') grammarPoints += entry.score;
                    else if (entry.category === 'slang') slangPoints += entry.score;
                }
            }

            GrammarFixer.sentenceStartRegex.lastIndex = 0;
            while ((match = GrammarFixer.sentenceStartRegex.exec(protectedText)) !== null) {
                const before  = protectedText.substring(0, match.index);
                let prevWord  = before.split(/\s+/).pop()?.replace(/[.,!?;:"'()[\]]+$/, '').toLowerCase() || '';
                if (!GrammarFixer.abbreviations.has(prevWord)) {
                    stylePoints += 4;
                }
            }

            if (clean === clean.toLowerCase() && clean.length > CONFIG.ALL_LOWER_MIN_LEN) {
                stylePoints += CONFIG.ALL_LOWER_PENALTY * (wordCount / 100);
            }

            if (!/[.!?]$/.test(clean)) {
                punctuationPoints += 8;
            }

            const emojiCount   = (clean.match(/\p{Emoji_Presentation}/gu) || []).length;
            const emojiDensity = (emojiCount / wordCount) * 100;
            if (emojiDensity > CONFIG.EMOJI_DENSITY_THRESHOLD) {
                punctuationPoints += CONFIG.EMOJI_PENALTY;
            }

            return { grammarPoints, slangPoints, stylePoints, punctuationPoints, wordCount };
        },

        computeScore(analysis) {
            const { grammarPoints, slangPoints, stylePoints, punctuationPoints, wordCount } = analysis;

            const grammarDensity     = (grammarPoints     / wordCount) * 100;
            const slangDensity       = (slangPoints       / wordCount) * 100;
            const styleDensity       = (stylePoints       / wordCount) * 100;
            const punctuationDensity = (punctuationPoints / wordCount) * 100 * 0.5;

            return grammarDensity     * CONFIG.WEIGHT_GRAMMAR     +
                   slangDensity       * CONFIG.WEIGHT_SLANG       +
                   styleDensity       * CONFIG.WEIGHT_STYLE       +
                   punctuationDensity * CONFIG.WEIGHT_PUNCTUATION;
        },

        attachScoreBadge(comment, score) {
            if (!CONFIG.ENABLE_SCORE_DISPLAY) return;
            if (comment.querySelector('.grammar-score')) return;
            if (this.isEnglishThread === false) return;

            const hue   = Math.max(0, Math.min(120 - score * 6, 120));
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

    const NukerEngine = {

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

        getCommentScore(comment) {
            if (!CONFIG.USE_UPVOTE_IMMUNITY) return null;

            const selectors = [
                'faceplate-number[number]',
                '[data-testid="comment-score"]',
                '.score',
                'faceplate-number',
                '[aria-label*="upvotes"]',
                '[aria-label*="points"]',
            ];

            for (const sel of selectors) {
                const el = comment.querySelector(sel);
                if (!el) continue;

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

        applyShameBadge(comment) {
            if (comment.querySelector('.shame-badge')) return;
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

        applyHeroBadge(comment) {
            if (comment.querySelector('.hero-badge')) return;
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
            comment.classList.add('hero-reply');
        },

        isStrongReply(replyElement) {
            const text  = extractCommentText(replyElement).replace(/\s+/g, ' ').trim();
            const words = text.split(/\s+/).filter(w => w.length > 0);

            if (text.length < CONFIG.CHILD_MIN_LENGTH) return false;
            if (words.length < CONFIG.CHILD_MIN_WORDS)  return false;

            if (text === text.toUpperCase() && text.length > 10) return false;

            const nonText = (text.match(/[^\p{L}\p{N}\s]/gu) || []).length;
            if (text.length > 0 && (nonText / text.length) > 0.6) return false;

            const sentenceCount = (text.match(/[.!?]/g) || []).length;
            if (text.length > 200 && sentenceCount < 2) return false;

            return true;
        },

        getDirectChildren(comment) {
            return Array.from(comment.children).filter(
                el => el.tagName?.toLowerCase() === 'shreddit-comment'
            );
        },

        // Walks all text nodes inside a comment and applies GrammarFixer.fix() to each.
        // Skips protected elements (code, links, images, score displays).
        applyFixesToTextNodes(root) {
            if (!CONFIG.ENABLE_GRAMMAR_FIXES) return;

            const protectedSelectors = ['blockquote', 'code', 'pre', 'a', 'img', 'faceplate-number'];

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
                const original = node.nodeValue?.trim();
                if (!original || original.length < 3) continue;
                if (GrammarService.detectLanguage(original, true) === false) continue;

                const fixed = GrammarFixer.fix(original);
                if (fixed !== original) node.nodeValue = fixed;
            }
        },

        processComment(comment) {
            if (comment.hasAttribute('data-processed')) return;

            const isTopLevel = !comment.parentElement?.closest('shreddit-comment');
            if (!isTopLevel) {
                comment.setAttribute('data-processed', 'true');
                return;
            }

            const rawText   = extractCommentText(comment);
            const cleanText = rawText.replace(/\s+/g, ' ').trim();

            // Reddit collapses the DOM for very short comments — extraction returns empty.
            // The collapsed state is itself the signal: treat as too short, but still
            // check for a hero reply before nuking.
            if (!cleanText || cleanText.length < 3) {
                const children    = this.getDirectChildren(comment);
                const strongReply = children.find(c => this.isStrongReply(c));
                if (strongReply) {
                    this.applyShameBadge(comment);
                    this.applyHeroBadge(strongReply);
                } else {
                    this.hideComment(comment, 'Collapsed');
                }
                comment.setAttribute('data-processed', 'true');
                return;
            }

            if (this.hasUpvoteImmunity(comment)) {
                comment.setAttribute('data-processed', 'true');
                return;
            }

            const analysis = GrammarService.analyze(rawText);
            const score    = GrammarService.computeScore(analysis);

            const isTooShort  = cleanText.length < CONFIG.MIN_LENGTH;
            const isTooSloppy = CONFIG.ENABLE_NUKE_BY_SCORE && score >= CONFIG.SCORE_NUKE_THRESHOLD;

            if (CONFIG.ENABLE_GRAMMAR_FIXES) {
                this.applyFixesToTextNodes(comment);
            }

            GrammarService.attachScoreBadge(comment, score);

            if (isTooShort || isTooSloppy) {
                const children    = this.getDirectChildren(comment);
                const strongReply = children.find(c => this.isStrongReply(c));

                if (strongReply) {
                    this.applyShameBadge(comment);
                    this.applyHeroBadge(strongReply);
                } else {
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

    class CommentProcessor {
        constructor() {
            this.observer = new MutationObserver(this.handleMutations.bind(this));

            this.intersectionObserver = new IntersectionObserver(
                entries => {
                    entries.forEach(entry => {
                        if (entry.isIntersecting) {
                            NukerEngine.processComment(entry.target);
                            this.intersectionObserver.unobserve(entry.target);
                        }
                    });
                },
                { rootMargin: '200px' }
            );
        }

        start() {
            const target = document.querySelector('shreddit-app') || document.body;
            this.observer.observe(target, { childList: true, subtree: true });

            document.querySelectorAll('shreddit-comment:not([data-processed])').forEach(el => {
                this.intersectionObserver.observe(el);
            });

            console.log(`Purple Tuxedo of Shame v4.3.0 active`);
            console.log(` Nuke: <${CONFIG.MIN_LENGTH} chars | Save: ${CONFIG.CHILD_MIN_LENGTH} chars / ${CONFIG.CHILD_MIN_WORDS} words`);
            console.log(` Score threshold: ${CONFIG.SCORE_NUKE_THRESHOLD} | Upvote immunity: ${CONFIG.USE_UPVOTE_IMMUNITY ? `>=${CONFIG.UPVOTE_THRESHOLD}` : 'OFF'}`);
        }

        handleMutations(mutations) {
            for (const mut of mutations) {
                for (const node of mut.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;

                    if (node.matches?.('shreddit-comment')) {
                        this.intersectionObserver.observe(node);
                    } else {
                        node.querySelectorAll?.('shreddit-comment').forEach(
                            el => this.intersectionObserver.observe(el)
                        );
                    }
                }
            }
        }
    }


    // =========================================================================
    // CSS
    // =========================================================================

    const style = document.createElement('style');
    style.textContent = `
        .nuked-comment { display: none !important; }

        .nuker-placeholder {
            color: #aaa; font-size: 0.85em; font-style: italic; padding: 6px 12px;
            margin: 4px 0; background: rgba(80,80,80,0.15);
            border-left: 2px solid #666; border-radius: 4px;
        }

        .hero-reply {
            border-left: 3px solid #ffd700 !important;
            background: rgba(255,215,0,0.03) !important;
        }
    `;
    document.head.appendChild(style);


    // =========================================================================
    // LAUNCH
    // =========================================================================

    const processor = new CommentProcessor();
    processor.start();

})();
