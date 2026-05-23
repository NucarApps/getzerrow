## Plan

Fix the blurry person-row logos by making the contact row request and render the same high-resolution logo asset strategy as the clearer business toggle.

### Changes

1. Update `CompanyLogo` so the requested logo source size is based on the final rendered size plus a stronger retina multiplier, with a safe high-resolution floor.
2. Add explicit image-rendering behavior for normal logos so browsers preserve smooth scaling while avoiding accidental low-resolution source reuse.
3. Update the person contact row usage in `contacts.index.tsx` to request a larger backing image for the 40px circular avatar, without changing its visible size.
4. Keep the existing first-letter fallback behavior when no real logo is found.

### Validation

- Check the contacts page visually and compare person-row logos against the business toggle logos.
- Confirm companies without a real logo still fall back to the first letter.