// Messages are split into fixed-size word chunks. Each chunk is revealed and
// receipted on its own, so the roster can show exactly which parts were read.
export const WORDS_PER_CHUNK = 4;

export function chunkWords(text: string, size = WORDS_PER_CHUNK): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(' '));
  return out;
}
