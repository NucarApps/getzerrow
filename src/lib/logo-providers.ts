// Display labels for the logo providers, parallel to `providersFor()` in
// src/lib/logo-fetch.server.ts (the single definition of the provider list).
//
// Kept in this separate client-safe module because the picker UI imports the
// labels and must not pull in the server-only fetcher. A test in
// logo-fetch.server.test.ts asserts the two lists stay the same length; the
// ORDER is a data contract — company_logo_choices.provider stores the index.
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
