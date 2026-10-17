export const RECEIPT_EXTRACTION_PROMPT = `You are a receipt parser. Extract structured data from this receipt image.

Return a JSON object with exactly this structure:
{
  "merchantName": "store name or null",
  "merchantAddress": "street, postal code and city printed on the receipt, or null",
  "date": "YYYY-MM-DD or null",
  "items": [
    { "name": "item description", "quantity": 1, "unitPrice": 499, "totalPrice": 499 }
  ],
  "subtotal": 1299,
  "tax": 104,
  "tip": 0,
  "total": 1403,
  "currency": "USD",
  "alternateTotals": [
    { "currency": "EUR", "total": 1287 }
  ]
}

CRITICAL RULES:
- All monetary values MUST be integers in cents (e.g., $12.99 = 1299)
- Every line item on the receipt must appear in the items array
- quantity * unitPrice should equal totalPrice for each item
- subtotal should equal the sum of all item totalPrices
- total should equal subtotal + tax + tip
- Many receipts (e.g. in Austria and Germany) print VAT-inclusive (gross) prices and a VAT summary
  ("inkl. MwSt.", "USt", "Brutto/Netto") for information only. If the item totalPrices already add up
  to the printed total, the tax is included: set tax to 0 and subtotal to that total.
- If the receipt prints its final total in one or more additional currencies,
  add each printed final total to alternateTotals. Do not infer or calculate
  alternate totals: only include a value that is explicitly printed.
- The primary total and currency are the receipt's local/original amount.
- If you cannot read a value clearly, make your best estimate
- Do not include any text outside the JSON object
- Return ONLY valid JSON, no markdown code fences`;

/** English language names of the app locales, used to tell the model which language to write item names in. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  sv: 'Swedish',
  fr: 'French',
  de: 'German',
  'pt-BR': 'Brazilian Portuguese',
  ja: 'Japanese',
  'zh-CN': 'Simplified Chinese',
  ko: 'Korean',
};

/** Name of the language for an app locale ("de" -> "German"); undefined for an unknown locale. */
export function languageNameForLocale(locale: string | null | undefined): string | undefined {
  if (!locale) return undefined;
  return LANGUAGE_NAMES[locale] ?? LANGUAGE_NAMES[locale.split('-')[0] ?? ''];
}

/**
 * The full extraction prompt: the base prompt, plus the translation rule when the user reads another language than
 * the receipt (e.g. an Arabic receipt for a German user), plus a user correction if there is one.
 */
export function buildReceiptPrompt({
  correctionHint,
  language,
}: { correctionHint?: string | undefined; language?: string | undefined } = {}): string {
  let prompt = RECEIPT_EXTRACTION_PROMPT;
  if (language) {
    prompt +=
      `\n\nLANGUAGE:\n- Write every item "name" in ${language}. If the receipt is printed in another language or script ` +
      `(for example Arabic), translate each item description into ${language} so the user can read it. Keep the meaning ` +
      `and the size or variant (e.g. "0.5 l", "large"), and keep brand and dish names that have no translation.\n` +
      `- Keep "merchantName" and "merchantAddress" exactly as printed (do not translate them).\n` +
      `- Numbers, dates and currency are not affected by this; read Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) as normal numbers.`;
  }
  if (correctionHint) {
    prompt += `\n\nThe user has provided a correction. Apply it to improve accuracy:\n<user_correction>${correctionHint
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')}</user_correction>`;
  }
  return prompt;
}
