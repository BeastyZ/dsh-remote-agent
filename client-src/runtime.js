// React runtime shared by the workbench modules.
// The DSH client module loader supplies React to the package factory; every
// component in this bundle reads it from here instead of importing a second copy.
export let React = null;
export let h = null;

export function setReact(value) {
  React = value;
  h = value.createElement;
}

// ---------------------------------------------------------------------------
// Locale helpers (the Active locale comes from ctx.locale).
// ---------------------------------------------------------------------------
let activeLocale = 'en';
const dictionaries = { en: {}, zh: {} };

export function setLocale(id) {
  activeLocale = String(id || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function currentLocale() {
  return activeLocale;
}

export function defineDict(lang, dict) {
  Object.assign(dictionaries[lang] || (dictionaries[lang] = {}), dict);
}

export function t(key, vars) {
  const table = dictionaries[activeLocale] || dictionaries.en;
  let text = table[key] ?? dictionaries.en[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split('{' + name + '}').join(String(value));
    }
  }
  return text;
}
