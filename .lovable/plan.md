I’ll make the company bucket rows match the taller contact-row feel on mobile.

Plan:
1. Update `CompanyBucketHeader` mobile layout so each company row has a fixed larger minimum height/tap target, not just extra padding that can be visually compressed by the sticky header/list styling.
2. Increase the mobile logo/icon slot and action buttons slightly so the row reads as a true row, not a compact section label.
3. Keep desktop sizing compact with existing `sm:` overrides.
4. Replace the hardcoded fallback colors in this component with semantic tokens while touching it, so it stays aligned with the design system.
5. Verify the mobile contacts page visually after the change.