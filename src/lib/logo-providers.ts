// Labels for the providers tried by /api/public/logo, in the same order.
// Keep this in sync with `providersFor()` in src/routes/api/public/logo.ts.
export const LOGO_PROVIDER_LABELS: readonly string[] = [
  "Logo.dev",
  "Clearbit",
  "DuckDuckGo",
  "Apple touch icon",
  "Apple touch icon (precomposed)",
  "Favicon",
  "Google",
];

export const LOGO_PROVIDER_COUNT = LOGO_PROVIDER_LABELS.length;
