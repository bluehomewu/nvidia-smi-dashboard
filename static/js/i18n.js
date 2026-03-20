// ===== i18n Engine (Android-style strings.xml) =====

const _strings = {};
let _locale = "en";

// Language to folder mapping
const LOCALE_MAP = {
  "zh-TW": "values-zh-rTW",
  "zh-Hant": "values-zh-rTW",
  "zh-Hant-TW": "values-zh-rTW",
  "zh-Hant-HK": "values-zh-rTW",
};

function _resolveFolder(lang) {
  // Exact match
  if (LOCALE_MAP[lang]) return LOCALE_MAP[lang];
  // Try base language (e.g. "zh-TW" from "zh-Hant-TW")
  const base = lang.split("-").slice(0, 2).join("-");
  if (LOCALE_MAP[base]) return LOCALE_MAP[base];
  // Try language only (e.g. "zh")
  const langOnly = lang.split("-")[0];
  if (LOCALE_MAP[langOnly]) return LOCALE_MAP[langOnly];
  // Default
  return "values";
}

function _detectLocale() {
  // Cookie override (but not "auto")
  const m = document.cookie.match(/(?:^|; )lang=([^;]*)/);
  if (m) {
    const val = decodeURIComponent(m[1]);
    if (val && val !== "auto") return val;
  }
  // Browser language
  return navigator.language || navigator.userLanguage || "en";
}

function getLangSetting() {
  const m = document.cookie.match(/(?:^|; )lang=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "auto";
}

function _parseStringsXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const entries = doc.querySelectorAll("string");
  const map = {};
  entries.forEach(function (el) {
    map[el.getAttribute("name")] = el.textContent;
  });
  return map;
}

async function initI18n() {
  const detected = _detectLocale();
  _locale = detected;
  const folder = _resolveFolder(detected);

  // Load locale-specific strings
  let loaded = false;
  if (folder !== "values") {
    try {
      const resp = await fetch("/res/" + folder + "/strings.xml");
      if (resp.ok) {
        const xml = await resp.text();
        Object.assign(_strings, _parseStringsXml(xml));
        loaded = true;
      }
    } catch (e) {
      // fall through to default
    }
  }

  // Always load default as fallback (loaded first, then overwritten by locale)
  try {
    const resp = await fetch("/res/values/strings.xml");
    if (resp.ok) {
      const xml = await resp.text();
      const defaults = _parseStringsXml(xml);
      // Merge: locale strings take priority over defaults
      if (loaded) {
        // Fill in any missing keys from defaults
        Object.keys(defaults).forEach(function (k) {
          if (!_strings[k]) _strings[k] = defaults[k];
        });
      } else {
        Object.assign(_strings, defaults);
      }
    }
  } catch (e) {
    // no fallback available
  }

  // Update html lang attribute
  const htmlLang = folder === "values" ? "en" : detected;
  document.documentElement.setAttribute("lang", htmlLang);

  // Apply to static DOM elements
  applyI18nToDOM();

  // Update document title
  if (_strings["app_title"]) {
    document.title = _strings["app_title"];
  }
}

/**
 * Get localized string by key, with optional argument substitution.
 * Supports Android-style %s, %d, %1$s, %2$s positional placeholders.
 */
function S(key) {
  var template = _strings[key] || key;
  var args = Array.prototype.slice.call(arguments, 1);
  if (args.length === 0) return template;

  // Replace positional: %1$s, %2$s, etc.
  template = template.replace(/%(\d+)\$[sd]/g, function (_, n) {
    var idx = parseInt(n, 10) - 1;
    return idx < args.length ? args[idx] : "";
  });

  // Replace sequential: %s, %d
  var i = 0;
  template = template.replace(/%[sd]/g, function () {
    return i < args.length ? args[i++] : "";
  });

  return template;
}

/**
 * Get the BCP47 locale string for use with toLocaleTimeString etc.
 */
function getI18nLocale() {
  return _locale;
}

/**
 * Apply i18n strings to DOM elements with data-i18n attributes.
 */
function applyI18nToDOM() {
  document.querySelectorAll("[data-i18n]").forEach(function (el) {
    var key = el.getAttribute("data-i18n");
    if (_strings[key]) el.textContent = _strings[key];
  });
  document.querySelectorAll("[data-i18n-title]").forEach(function (el) {
    var key = el.getAttribute("data-i18n-title");
    if (_strings[key]) el.setAttribute("title", _strings[key]);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {
    var key = el.getAttribute("data-i18n-placeholder");
    if (_strings[key]) el.setAttribute("placeholder", _strings[key]);
  });
}

/**
 * Switch language, save to cookie, and re-initialize.
 */
async function switchLanguage(lang) {
  var d = new Date();
  d.setTime(d.getTime() + 365 * 86400000);
  document.cookie = "lang=" + lang + ";expires=" + d.toUTCString() + ";path=/;SameSite=Lax";
  // Clear current strings
  Object.keys(_strings).forEach(function (k) { delete _strings[k]; });
  await initI18n();
}
