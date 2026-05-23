## Goal
On mobile inbox, keep the top app bar, inbox header/search, and bottom pagination/options fixed in place while only the email list scrolls.

## Plan
1. **Constrain the authenticated layout height chain**
   - Update the authenticated main content wrapper so the routed page has a real bounded height and cannot expand the whole document.
   - Add the missing `overflow-hidden`/height constraint to the `Outlet` wrapper if needed.

2. **Make the inbox mobile panel fill its available height**
   - Change the inbox root/list wrappers from relying only on `h-full` to a more robust bounded flex/grid setup.
   - Keep the list header and search outside the scrollable area.

3. **Keep pagination pinned below the list**
   - Ensure the email list scroll area is the only `overflow-y-auto` element in the list column.
   - Keep the footer/pagination as a non-scrolling sibling.

4. **Apply the same containment to the reader pane**
   - Keep the reader toolbar fixed and only let the message body scroll.

5. **Validate on mobile and desktop**
   - Check `/inbox` at the current mobile viewport (`402x716`) and confirm the page itself no longer scrolls.
   - Confirm desktop inbox still behaves normally.