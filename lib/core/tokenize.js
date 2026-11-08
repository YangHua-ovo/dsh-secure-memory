/**
 * Deterministic local tokenizer used by BM25, hashed vectors, and topic tags.
 * It is intentionally dependency-free and never calls a model or network.
 */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
const LATIN = /[A-Za-z0-9_][A-Za-z0-9_.+#/-]*/g;

const EN_STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had',
  'was', 'were', 'are', 'is', 'be', 'been', 'being', 'will', 'would', 'could',
  'should', 'can', 'may', 'might', 'must', 'not', 'but', 'you', 'your', 'we',
  'our', 'they', 'their', 'it', 'its', 'as', 'at', 'by', 'in', 'on', 'of',
  'to', 'or', 'if', 'then', 'so', 'than', 'too', 'very', 'just', 'about',
  'into', 'over', 'after', 'before', 'all', 'any', 'some', 'more', 'most',
  'other', 'such', 'only', 'also', 'there', 'here', 'what', 'which', 'who',
  'when', 'where', 'why', 'how', 'do', 'does', 'did', 'done', 'get', 'got',
  'make', 'made', 'use', 'used', 'using', 'one', 'two', 'new', 'now',
]);

const ZH_STOP = new Set([
  '的', '了', '和', '是', '在', '我', '你', '他', '她', '它', '我们', '你们',
  '他们', '这个', '那个', '这些', '那些', '一个', '一些', '可以', '需要', '因为',
  '所以', '但是', '如果', '然后', '还是', '就是', '没有', '不是', '已经', '进行',
  '通过', '对于', '以及', '或者', '而且', '并且', '的话', '一下', '这样', '那样',
  '什么', '怎么', '如何', '为什么', '现在', '之前', '之后', '这里', '那里',
]);

const ZH_STOP_CHARS = new Set('的了和是在我你他她它我们你们他们这那有些个可以需要因为所以但是如果然后还是就没有不是已经进行通过对于以及或者而且并且的话一下这样那样什么怎么如何为什么现在之前之后这里那里'.split(''));

/** Whether a string contains CJK characters. */
export function hasCjk(value) {
  return CJK.test(String(value ?? ''));
}

/** Return a coarse language label. */
export function languageOf(value) {
  const text = String(value ?? '');
  const cjk = Array.from(text).filter((ch) => CJK.test(ch)).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cjk === 0 && latin === 0) return 'unknown';
  if (cjk > 0 && latin > 0) return 'mixed';
  return cjk > 0 ? 'zh' : 'en';
}

/** Normalize a token for matching. */
export function normalizeToken(token) {
  return String(token ?? '').toLowerCase().normalize('NFKC');
}

/**
 * Tokenize text into a deterministic bag of terms.
 *
 * Chinese has no spaces, so we emit overlapping CJK bigrams and trigrams.
 * Single CJK characters are emitted only when no bigram exists, to preserve
 * short queries such as a single character. Latin/number runs are emitted as
 * whole lower-cased tokens.
 */
export function tokenize(value) {
  const text = String(value ?? '').normalize('NFKC');
  const counts = new Map();
  const add = (token, weight = 1) => {
    if (!token) return;
    const normalized = normalizeToken(token);
    if (normalized.length === 0) return;
    counts.set(normalized, (counts.get(normalized) ?? 0) + weight);
  };

  for (const match of text.matchAll(LATIN)) {
    const token = match[0].replace(/^[._-]+|[._-]+$/g, '');
    if (token.length < 2 || token.length > 48) continue;
    if (EN_STOP.has(token.toLowerCase())) continue;
    add(token);
  }

  // CJK runs: bigrams plus trigrams. This catches phrases like 多智能体/协作架构.
  const cjkRuns = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/gu) ?? [];
  for (const run of cjkRuns) {
    const chars = Array.from(run);
    if (chars.length === 1) {
      if (!ZH_STOP_CHARS.has(chars[0])) add(chars[0]);
      continue;
    }
    for (let i = 0; i < chars.length; i += 1) {
      if (i + 1 < chars.length) {
        const bi = chars[i] + chars[i + 1];
        if (!ZH_STOP.has(bi) && !(ZH_STOP_CHARS.has(chars[i]) && ZH_STOP_CHARS.has(chars[i + 1]))) add(bi);
      }
      if (i + 2 < chars.length) {
        const tri = chars[i] + chars[i + 1] + chars[i + 2];
        if (!ZH_STOP.has(tri)) add(tri, 0.7);
      }
    }
  }
  return counts;
}

/** Number of indexed terms in a token map. */
export function tokenCount(tokenMap) {
  let total = 0;
  for (const count of tokenMap.values()) total += count;
  return total;
}

/** Extract human-facing topic tags (not a semantic entity extractor). */
export function extractTags(text, category, limit = 8) {
  const counts = tokenize(text);
  const scored = [];
  for (const [token, count] of counts) {
    const chars = Array.from(token).length;
    if (chars < 2 && !/^[a-z0-9]{2,}$/i.test(token)) continue;
    if (/^\d+$/.test(token)) continue;
    const cjk = hasCjk(token);
    const base = cjk ? (chars === 2 ? 1.0 : 0.8) : 1.0;
    scored.push({ token, score: count * base * (1 + Math.min(chars, 8) / 20) });
  }
  scored.sort((a, b) => b.score - a.score || a.token.localeCompare(b.token));
  const tags = [];
  for (const item of scored) {
    if (tags.some((tag) => tag.includes(item.token) || item.token.includes(tag))) continue;
    tags.push(item.token);
    if (tags.length >= limit) break;
  }
  if (category && tags.length < limit) tags.push(`category:${category}`);
  return tags;
}

const STOPWORDS = { en: EN_STOP, zh: ZH_STOP };
export { STOPWORDS };
