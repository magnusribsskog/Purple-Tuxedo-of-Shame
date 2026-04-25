// Grammar Fixer
// Standalone text-correction library. No DOM, no framework, no external dependencies.
// Exposes two globals: PlaceholderProtector and GrammarFixer.
//
// Usage:
//   const fixed = GrammarFixer.fix("dont you know youre amazing");
//   // → "Don't you know you're amazing."

// =========================================================================
// PLACEHOLDER PROTECTOR
// =========================================================================
//
// Before correcting text, shields spans that must never be touched: quoted
// blocks, inline code, URLs, markdown links, and LaTeX math. Each protected
// span is replaced with a unique token like <<<URL_0>>>, corrections run on
// the tokenised text, then the tokens are swapped back.

const PlaceholderProtector = {

    getDefaultPatterns() {
        return [
            { regex: /^>.*$/gm,                 prefix: 'BLOCK'     },
            { regex: /"[^"]*"|"[^"]*"/g,        prefix: 'QUOTE'     },
            { regex: /`[^`]*`/g,                prefix: 'CODE'      },
            { regex: /```[\s\S]*?```/g,         prefix: 'CODEBLOCK' },
            { regex: /\[([^\]]+)\]\([^\)]+\)/g, prefix: 'LINK'      },
            { regex: /https?:\/\/[^\s]+/g,      prefix: 'URL'       },
            { regex: /\$\$?[^$]+\$\$?/g,       prefix: 'MATH'      },
        ];
    },

    replaceProtected(text, patterns = this.getDefaultPatterns()) {
        const map = new Map();
        let counter = 0;
        let result = text;
        for (const { regex, prefix } of patterns) {
            result = result.replace(regex, (match) => {
                const id = `<<<${prefix}_${counter++}>>>`;
                map.set(id, match);
                return id;
            });
        }
        return { text: result, map };
    },

    restore(text, map) {
        let result = text;
        for (const [id, original] of map) {
            result = result.replace(new RegExp(escapeRegex(id), 'g'), original);
        }
        return result;
    }
};

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// =========================================================================
// GRAMMAR FIXER
// =========================================================================

const GrammarFixer = {

    dictionary: {
        // Missing apostrophes
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
        "i":        { fix: "I",         category: "grammar", score: 4 },

        // Slang
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

    abbreviations: new Set([
        'vs', 'etc', 'vol', 'al', 'mr', 'mrs', 'ms', 'dr', 'prof', 'capt',
        'gen', 'sen', 'rep', 'st', 'ave', 'blvd',
        'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
    ]),

    dictRegex: null,
    sentenceStartRegex: null,

    init() {
        const keys = Object.keys(this.dictionary).join('|');
        this.dictRegex = new RegExp(`\\b(${keys})[.,!?;:"']?\\b`, 'gi');
        this.sentenceStartRegex = /(^|[.!?]\s+)([a-z])/g;
    },

    // Returns a corrected copy of text. Input and output are plain strings.
    fix(text) {
        if (!text || text.length < 3) return text;

        const { text: protectedText, map } = PlaceholderProtector.replaceProtected(text);
        let fixed = protectedText;

        // Dictionary substitutions — preserve original capitalisation of first letter.
        this.dictRegex.lastIndex = 0;
        fixed = fixed.replace(this.dictRegex, (m) => {
            const entry = this.dictionary[m.toLowerCase()];
            if (!entry) return m;
            if (m[0] === m[0].toUpperCase() && m[0] !== m[0].toLowerCase()) {
                return entry.fix.charAt(0).toUpperCase() + entry.fix.slice(1);
            }
            return entry.fix;
        });

        // Standalone lowercase "i" as pronoun — only for longer ASCII text.
        if (text.split(/\s+/).length > 8 && !/[^\x00-\x7F]/.test(text)) {
            fixed = fixed.replace(/\bi\b(?![0-9-])/g, 'I');
        }

        // Capitalise first letter after sentence-ending punctuation.
        this.sentenceStartRegex.lastIndex = 0;
        fixed = fixed.replace(/(^|[.!?]\s+)([a-z])/g, (match, p1, p2, offset, full) => {
            const before = full.substring(0, offset);
            const prev   = before.split(/\s+/).pop()?.replace(/[.,!?;:"'()[\]]+$/, '').toLowerCase() || '';
            if (this.abbreviations.has(prev)) return match;
            return p1 + p2.toUpperCase();
        });

        return PlaceholderProtector.restore(fixed, map);
    }
};

GrammarFixer.init();
