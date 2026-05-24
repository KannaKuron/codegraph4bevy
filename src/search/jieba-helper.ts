/**
 * Jieba Chinese word segmentation helper.
 *
 * Lazy-loaded: `@node-rs/jieba` is only loaded on the first call.
 * If the native module cannot be loaded (unsupported platform, etc.),
 * the helper silently returns null and callers fall back to existing behavior.
 */

interface JiebaInstance {
  cut(text: string): string[];
}

let jiebaInstance: JiebaInstance | null | undefined;
let jiebaInitAttempted = false;

function getJieba(): JiebaInstance | null {
  if (jiebaInitAttempted) return jiebaInstance ?? null;
  jiebaInitAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Jieba } = require('@node-rs/jieba');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { dict } = require('@node-rs/jieba/dict');
    jiebaInstance = Jieba.withDict(dict) as JiebaInstance;
    return jiebaInstance;
  } catch {
    jiebaInstance = null;
    return null;
  }
}

/**
 * Segment Chinese text into words using jieba.
 * Returns null when jieba is unavailable, allowing callers to fall back.
 */
export function segmentChinese(text: string): string[] | null {
  const jieba = getJieba();
  if (!jieba) return null;
  try {
    return jieba.cut(text);
  } catch {
    return null;
  }
}
