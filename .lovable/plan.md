## Goal

Replace the current empty-inbox icon (Lucide `Inbox`) with the uploaded cobweb-inbox SVG in the email list's empty state.

## Steps

1. Copy `user-uploads://cobweb-inbox.svg` → `src/assets/cobweb-inbox.svg`.
2. In `src/routes/_authenticated/index.tsx` (~L309–314):
   - Import the SVG: `import cobwebInbox from "@/assets/cobweb-inbox.svg";`
   - Replace `<Inbox className="h-8 w-8 opacity-40" />` with `<img src={cobwebInbox} alt="" className="h-32 w-auto opacity-90" />`.
   - Keep the existing "Nothing here yet." text below.
   - If `Inbox` from lucide-react is no longer used elsewhere in the file, drop it from the import.

## Out of scope

- Other empty states (search results, folders page, settings). Only the inbox/folder email-list empty state.
- No styling changes to surrounding layout.
