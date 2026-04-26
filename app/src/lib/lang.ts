// Language detection for NYC's most common non-English languages.

const SPANISH_RE =
  /\b(necesito|quiero|busco|desde|hasta|cerca|silla|ruedas|visión|camino|despacio|noche|fresco|refugio|baño|lugar|tengo|voy|carriola|estoy|puedo|dónde|cómo|qué|soy|usuario|para|por|esta)\b/i;

const HAITIAN_RE =
  /\b(mwen|nan|bezwen|ale|kote|machin|lari|pye|wè|cho|frèt|nuit|sele|repoze|twalet|bibliotèk|abri|rafraîchi)\b/i;

export type Lang = 'es' | 'zh' | 'ru' | 'bn' | 'ar' | 'ko' | 'hi' | 'ht' | 'fr' | 'pl';

export function detectLang(q: string): Lang | null {
  if (/[一-鿿㐀-䶿\u{20000}-\u{2a6df}]/u.test(q)) return 'zh';
  if (/[Ѐ-ӿ]/.test(q)) return 'ru';
  if (/[ঀ-৿]/.test(q)) return 'bn';
  if (/[؀-ۿ]/.test(q)) return 'ar';
  if (/[가-퟿ᄀ-ᇿ]/.test(q)) return 'ko';
  if (/[ऀ-ॿ]/.test(q)) return 'hi';
  if (SPANISH_RE.test(q)) return 'es';
  if (HAITIAN_RE.test(q)) return 'ht';
  return null;
}

const DIRECTIVES: Record<Lang, string> = {
  es: '[IMPORTANTE: Responde ÚNICAMENTE en español.]',
  zh: '[重要：请仅用中文回复。]',
  ru: '[ВАЖНО: Отвечайте ТОЛЬКО на русском языке.]',
  bn: '[গুরুত্বপূর্ণ: শুধুমাত্র বাংলায় উত্তর দিন।]',
  ar: '[مهم: أجب فقط باللغة العربية.]',
  ko: '[중요: 반드시 한국어로만 답하세요.]',
  hi: '[महत्वपूर्ण: केवल हिंदी में उत्तर दें।]',
  ht: '[ENPÒTAN: Reponn AN KREYÒL AYISYEN SÈLMAN.]',
  fr: '[IMPORTANT: Répondez UNIQUEMENT en français.]',
  pl: '[WAŻNE: Odpowiadaj WYŁĄCZNIE po polsku.]',
};

export function langDirective(q: string): string {
  const lang = detectLang(q);
  return lang ? `\n\n${DIRECTIVES[lang]}` : '';
}
