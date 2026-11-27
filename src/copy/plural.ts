// Plurals for the dictionary (#66). Each locale has its own plural rules:
// English has "one" and "other", other languages have more forms.

/** The forms of a word or phrase. "other" is required, as the fallback. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & {
  other: string;
};

/** A plural function for a locale: it picks the form for `n`. */
export function pluralFor(locale: string) {
  const rules = new Intl.PluralRules(locale);
  return (n: number, forms: PluralForms): string =>
    forms[rules.select(n)] ?? forms.other;
}
