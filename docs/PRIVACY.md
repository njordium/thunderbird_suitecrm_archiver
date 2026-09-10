# Privacy

Last reviewed: 2026-09-10, against version 0.4.3.

This add-on has no server of its own. It talks to one place: the SuiteCRM instance whose
address you enter yourself. Njordium operates no service behind it, receives nothing from
it, and has no way to observe your use of it.

Every statement below is verifiable in the source, and where a file makes the point it is
named.

## Who holds the data

You do, or your employer does. The add-on moves data from your mail client into your own
CRM. If that CRM is run by your organisation, your organisation is the data controller and
its own policies apply. Njordium is not a processor in that relationship and never sees the
data.

## What leaves your computer, and where it goes

Only to your CRM, and only when you ask for it:

- **When you archive an email** — its subject, date, sender, recipients, body text, and the
  attachments you chose to include. The email becomes an `Emails` record; attachments become
  `Notes` or `Documents` depending on your setting.
- **When you create a Lead or Contact** — the name, job title, email address, phone numbers,
  company and website that were parsed locally, as you confirmed or corrected them.
- **When the add-on looks something up** — the email address being searched for, so the CRM
  can answer whether it knows that person. This happens when you open the archiving window,
  and, if you enable those features, while you read a message or address a new one. Also the
  case number, when a subject carries one and case matching is on, and any text you type into
  the add-on's own search box.
- **When the add-on works out which modules you may use** — nothing about you or your mail. It
  asks the CRM which modules your own account is allowed to list and view (`/meta/modules`,
  `src/lib/crm.js`), so you are never offered a module the CRM would refuse you.
- **When you sign in** — your CRM username and password, once, to obtain tokens.

`src/lib/crm.js`, `src/lib/auth.js` and `src/background/index.js` contain the only three
network calls in the add-on. All three go to the address you configured. There is no fourth.

## What is never sent anywhere

- **No telemetry, analytics, crash reporting or usage counting.** None exists in the code;
  there is nothing to switch off.
- **No third-party site is contacted, ever.** A website guessed from a sender's email domain
  is filled in for you to check — it is never fetched. The add-on holds one host permission,
  for your CRM, and asks for no other.
- **No remote code.** Nothing is downloaded and run. The add-on has no dependencies, and its
  content security policy allows scripts only from within the package itself.

## What is stored on your computer

Six entries in Thunderbird's extension storage, inside your Thunderbird profile
(`src/lib/store.js`, `src/lib/diagnostics.js`, `src/background/index.js`):

| Key | Contents |
| --- | --- |
| `connection` | Your CRM address and API path, your CRM username, the OAuth2 client id and the client secret |
| `tokens` | The refresh token and the current access token, with their expiry |
| `prefs` | Your settings, including which mail accounts the add-on may act in and which modules it searches |
| `lastTargets` | Where mail from an address was filed last time: the address, and the module, id and name of that record. Up to 400 addresses, oldest dropped first. This is what lets the right-click menu and `Alt+Shift+A` file against a remembered record. Clearable |
| `recentArchives` | The popup's *Recent* list: the subject of each of the last 30 emails you filed, with the record it went to and when. Clearable |
| `debugLog` | Only present while detailed logging is on — see below |

Extension storage is a plain file on disk. A WebExtension has no access to the operating
system's keychain, so this is not an encrypted vault, and anyone who can read your
Thunderbird profile can read these values. That is why the design keeps a revocable,
rotating refresh token rather than your password.

Caches of CRM lookups are held **in memory only** and disappear when Thunderbird closes.

## What is never stored

**Your CRM password.** It is used for a single request to obtain tokens and then discarded
(`src/lib/auth.js`). It is never written to storage, never logged, and never included in a
debug report.

**Message bodies and attachments.** Emails are read when you act on one and passed to the
CRM. No body and no attachment is ever written to disk, and no copy of a message is kept.

Subjects are the one exception, and worth being plain about: the popup's *Recent* list keeps
the subject of the last 30 emails you filed, so you can see what you just did (`noteRecent`
in `src/background/index.js`). Along with `lastTargets`, that means your profile holds a
short local record of who you have filed mail from and what those emails were called. Both
are bounded, neither is sent anywhere, and both can be deleted at any time with *Clear what
is remembered* under Behaviour in the settings, which is also what the table below means by
clearable.

## Signature parsing happens on your machine

When the sender is not in the CRM, the add-on reads the signature block, the message headers
and any attached vCard to fill in the create form. All of that parsing runs locally in
`src/lib/signature.js` and `src/lib/vcard.js`. No message content is sent anywhere for
analysis — not to Njordium, not to any service. What reaches your CRM is only the fields you
confirm when you save.

## The CRM address book

If you enable *Offer CRM contacts when addressing mail*, typing a name in a To: field queries
your CRM for matching Contacts and Leads. Those results are used to populate the autocomplete
list and **no local copy is kept** — nothing goes stale, and nothing is written to disk. The
address you type is sent to your CRM in order to search for it. Turning the setting off stops
the queries entirely.

## Sharing the connection settings

One OAuth2 client can serve a whole organisation, so *Export* writes the CRM address, the
client id and the client secret to a JSON file, at a location you choose through
Thunderbird's own save dialog (`exportConnection` in `src/background/index.js`). It contains
**no token, no username and no password**, but the client secret is in it in the clear, so
the file deserves the same care as the secret itself. Nothing is uploaded; where you send it
afterwards is your choice.

Importing one fills the sign-in form and stops there. It does not store anything and does not
connect, so a file cannot silently repoint the add-on at another server — you see the address
that arrived and still have to press *Sign in* with your own username and password.

## Debug reports

Detailed logging is **off by default**. When you turn it on, the add-on records what it did
and what the CRM replied, so a failure can be explained. That log is kept in your profile
under `debugLog`, capped at 400 entries.

When you create a report, it is written to a file you choose, and:

- Passwords, client secrets, access tokens and refresh tokens are **never recorded in the
  first place** — the code that logs requests has no parameter for a request body
  (`recordRequest` in `src/lib/diagnostics.js`).
- Email addresses are masked unless you tick the box to include them.
- Your CRM's address and hostname are masked unless you tick the box to include them.
- Redaction runs after percent-decoding, so an address or secret hidden inside an encoded URL
  is still caught.

The report is a local file. Nothing is uploaded. Where you send it afterwards is your choice,
and the two tick-boxes exist so you can decide what a recipient should see.

Turning logging off discards whatever was recorded, and uninstalling the add-on removes the
whole store, log included. *Clear log* does the same at any time without changing the setting.

## The data-collection declaration

The manifest declares:

```json
"data_collection_permissions": { "required": ["personalCommunications", "personallyIdentifyingInfo"] }
```

This is deliberate and it is not about Njordium collecting anything. Email content and contact
details do leave your machine — for your own CRM — and that is what those two categories
describe. Declaring `none` would have been the convenient answer and a false one.

## Removing your data

- **From this add-on:** *Sign out* deletes the stored tokens, and *Sign out & forget settings*
  also deletes the CRM address, client id and secret. *Clear what is remembered*, under
  Behaviour, deletes `lastTargets` and `recentArchives` — the local record of which records
  you filed mail against and what those emails were called. It reports how many of each are
  there before you press it, and it takes nothing else: you stay signed in and your settings
  are untouched (`clearHistory` in `src/background/index.js`, covered by
  `tests/history.test.mjs`). *Clear log* does the same for the debug log. Uninstalling the
  add-on removes everything listed above. None of it touches what is already in your CRM.
- **From your CRM:** archived emails and created records are ordinary CRM records. Delete
  them there as you would any other.
- **Revoking access:** a SuiteCRM administrator can delete the add-on's tokens under
  Admin → OAuth2 Clients and Tokens. That locks Thunderbird out immediately without changing
  your password or affecting anything else.

## Questions

Open an issue at https://github.com/njordium/thunderbird_suitecrm_archiver.

If a statement here does not match what the code does, that is a bug and worth reporting as
one — the point of naming files above is so any of it can be checked.
