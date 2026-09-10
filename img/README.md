# Screenshots

Referenced from the project README. Kept here rather than pasted into GitHub's issue
CDN so they survive independently of any one comment or release.

## Conventions

- **PNG**, actual size, no upscaling. The popup is 500 px wide, so a retina capture is
  around 1000 px — that is the right width, and GitHub scales it down cleanly.
- **No real data.** No customer name, address, subject line or CRM hostname. Use the
  synthetic records `tools/seed-crm.mjs` creates, or an obviously fictional example.
  Where a real profile is unavoidable — the mail-account list, for instance — blur the
  identifying text rather than cropping it away, so the shape of the screen is still clear.
- **Crop to the panel**, not the whole Thunderbird window. The subject of each image is
  the add-on's own UI.
- **Light theme** for consistency, unless the point of the shot is dark-mode support.

## Expected files

| File | What it shows |
| --- | --- |
| `archive-window.png` | The archiving popup: sender resolved, matches grouped by module |
| `create-lead.png` | The create form for a Lead, with guessed fields marked |
| `create-contact.png` | The create form for a Contact under an Account |
| `settings-connection.png` | Preferences → Connection, with the secret generator |
| `settings-behaviour.png` | Preferences → Behaviour, showing what is configurable |
| `settings-accounts.png` | Preferences → Mail accounts, per-account scoping |

Update the README's Screenshots section when adding or renaming any of these.
