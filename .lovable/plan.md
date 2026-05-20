Add the Zerrow rocket-A logo to the login page header so it matches the landing page and the authenticated app shell.

## Change

Edit `src/routes/login.tsx`:

- Import the existing logo asset already used elsewhere: `import zerrowLogo from "@/assets/zerrow-logo.png";`
- In the centered header block (currently just the "Zerrow" wordmark + tagline), render the logo image above (or inline with) the wordmark, sized similarly to the sidebar treatment (~h-12) and centered.

## Out of scope

- No new asset generation — reuses the current `src/assets/zerrow-logo.png`.
- No layout or styling changes to the login card itself.
- No changes to the Google sign-in button or auth logic.
