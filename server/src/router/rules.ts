import type { TaskType, Tier } from '../types.ts';

export interface Classification {
  taskType: TaskType;
  complexity: Tier;
  /** 0–1. Below CONFIDENT the router asks Haiku instead of trusting these rules. */
  confidence: number;
  signals: string[];
}

export const CONFIDENT = 0.65;

/** Lowercase and strip Vietnamese diacritics, so "sửa lỗi" and "sua loi" match the same rule. */
export function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
}

// Patterns run on normalize()d text. Ordered by precedence for ties: a refactor or a bug
// report usually also contains generic edit verbs, not the other way round.
const TYPE_PATTERNS: [TaskType, RegExp][] = [
  ['refactor', /\b(refactor\w*|tai cau truc|viet lai|thiet ke lai|don dep|clean ?up|migrat\w*|chuyen (sang|doi)|nang cap|rewrite|restructur\w*|tach (module|file|ham|component))\b/g],
  ['bugfix', /\b(loi|bug\w*|fix\w*|crash\w*|exception|error|khong (chay|hoat dong|duoc)|bi hong|fail\w*|broken|stack ?trace|traceback|regression)\b/g],
  ['edit', /\b(them|sua|tao|implement\w*|add|create|build|viet|cai dat|update|cap nhat|doi|xoa|remove|rename|ho tro|support|endpoint|component|man hinh|nut|viet test)\b/g],
  ['design', /\b(thiet ke|kien truc|so sanh|nen (dung|chon)|lua chon|danh gia|phan tich|de xuat|y tuong|ke hoach|chien luoc|uu nhuoc|trade.?offs?|compare|architecture|design|approach|should (we|i)|which is better|pros and cons)\b/g],
  ['explain', /\b(giai thich|tai sao|vi sao|la gi|nghia la|hoat dong (nhu the nao|ra sao)|nhu the nao|explain|why|what is|what does|how does|how do|huong dan)\b/g],
];

const HEAVY = /\b(toan bo|tat ca|ca he thong|kien truc|architecture|migrat\w*|rewrite|viet lai|thiet ke lai|bao mat|security|concurrency|race condition|deadlock|dong bo hoa|hieu nang|performance|memory leak|ro ri|phan tan|distributed|nhieu (file|module|service)|end.to.end|whole|entire|across)\b/g;
const LIGHT = /\b(typo|chinh ta|doi ten|rename|comment|chu thich|readme|mau sac|color|margin|padding|font|nho|don gian|simple|small|minor|mot dong|1 dong|quick)\b/g;
const FILE = /[\w-]+\.(tsx?|jsx?|mjs|py|go|rs|java|cs|md|json|css|scss|html|vue|svelte|rb|php|kt|swift|cpp|c|h|sql|ya?ml|toml)\b/g;

const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0;

export function classifyByRules(prompt: string): Classification {
  const text = normalize(prompt);
  const signals: string[] = [];

  const scores = TYPE_PATTERNS.map(([type, re]) => ({ type, score: count(text, re) }));
  const ranked = [...scores].sort((a, b) => b.score - a.score); // stable: ties keep precedence order
  const [top, second] = ranked;

  let taskType: TaskType;
  let confidence: number;
  if (top.score === 0) {
    taskType = /\?\s*$/.test(prompt.trim()) ? 'explain' : 'edit';
    confidence = 0.3;
    signals.push('không có từ khoá rõ ràng');
  } else {
    taskType = top.type;
    const margin = top.score - second.score;
    confidence = margin >= 2 ? 0.9 : margin === 1 ? 0.7 : 0.5;
    signals.push(scores.filter((s) => s.score > 0).map((s) => `${s.type}×${s.score}`).join(', '));
  }
  // Long prompts tend to mix several intents; keyword counts get less reliable.
  if (prompt.length > 600) confidence -= 0.15;

  const files = new Set(text.match(FILE) ?? []).size;
  let heavy = count(text, HEAVY);
  if (prompt.length > 1500) heavy += 2;
  else if (prompt.length > 700) heavy += 1;
  if (files >= 5) heavy += 2;
  else if (files >= 3) heavy += 1;
  // Brevity only hints "small" for edits and questions; a short bug report or design question can still be hard.
  const shortAndSimple = top.score > 0 && prompt.length < 100 && (taskType === 'edit' || taskType === 'explain');
  const light = count(text, LIGHT) + (shortAndSimple ? 1 : 0);

  let complexity: Tier = heavy >= 2 ? 'heavy' : heavy === 0 && light >= 1 ? 'light' : 'standard';
  if (taskType === 'refactor' && complexity === 'light') complexity = 'standard';
  signals.push(`độ phức tạp: nặng×${heavy}, nhẹ×${light}${files ? `, ${files} file` : ''}`);

  return { taskType, complexity, confidence: Math.max(0, Math.round(confidence * 100) / 100), signals };
}
