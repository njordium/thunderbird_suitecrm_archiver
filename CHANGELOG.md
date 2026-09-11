# Changelog

## 0.4.4 (2026-09-11)

- **A module the CRM refuses is now turned off instead of failing on every message.** Filing
  a message warned "Could not search Prospects" over and over, using SuiteCRM's internal name
  for a module the settings call Targets, which read like a complaint about a module you do
  not have. When a search fails the add-on now checks that module once, and if the CRM
  refuses a plain read too, it stops searching it, unticks it in Preferences and marks it
  there with the reason, including the HTTP status. A module that answers a plain read is left
  alone, since that failure was about one request. A 500 or a dead connection takes three
  failures in a row before the module goes, every module failing at once is read as the CRM
  being unreachable rather than as five broken modules, and the last remaining module is
  never turned off. *Find more modules* re-tests anything
  marked and clears the mark when access comes back, so a revoked role shows up as something
  you can see and fix rather than a warning that never stops.
- **The interface speaks thirteen languages.** US and UK English, Danish, Swedish, Norwegian
  Bokmål, Finnish, German, Spanish, Dutch, French, Italian, Polish and Brazilian Portuguese.
  Thunderbird's own language is followed by default, and Behaviour has a selector for anyone
  whose mail client and CRM disagree. This first pass covers the buttons, statuses, menu
  entries and notifications. The settings page stays in English, all of it, including the
  language row itself: one paragraph in Swedish among English ones reads like a mistake
  rather than a feature.
- **The right-click menu and the keyboard shortcut now file where the window would.** They
  went straight to the sender's history, so the same message landed in two different places
  depending on how you filed it. Both now try the Case named in the subject, then the Case the
  thread belongs to, then the remembered record, and the notification says which of the three
  answered.
- **A reply is filed where the rest of its thread went, whatever kind of record that is.**
  Matching by mail thread is no longer limited to Cases: if an earlier message in the
  conversation was filed against an Account, a Contact or an Opportunity, a reply is offered
  there too.
- **Signature parsing, from real mail that parsed badly.** Four fixes, each from a message
  that got it wrong: "Med venlig hilsen" and "Med vennlig hilsen" were not recognised as
  sign-offs at all, which is most Danish and Norwegian mail, so nothing after them was read;
  a company registration number in a legal footer ("Org.nr/Corp. Id. No: 556369-6631") was
  filed as a work phone number, which is worse than an empty field; a `tel:` link wrapped
  around a number hid it; and a Gmail attribution line that wraps before "wrote:" left two
  lines of somebody else's mail inside the signature. Titles like "Associate" and
  "Executive" are recognised now too.
- **A reply is matched to its Case by the mail thread, not only by the subject.** SuiteCRM
  stamps the case number into the subject of mail it sends, and that was the only route, so
  the match was lost the moment the subject changed: an administrator edits the macro, a mail
  system rewrites the line, or the customer trims it. The add-on now also follows the
  `References` chain, where SuiteCRM's own outbound case mail is already stored against the
  Case, and says which route found the match. Up to five ancestors are checked, nearest
  first, so a long thread cannot turn one lookup into thirty requests.
- **Filing sent mail no longer ignores your module choice.** The automatic sent-mail path
  searched the four built-in modules whatever Preferences said, so it both queried modules
  you had turned off and kept asking the CRM for one it had already refused.
- **Every module name shown to you is the one the settings use.** "Prospects" was reaching
  the interface raw in warnings; it is SuiteCRM's internal name for Targets.
- **The sent-mail setting says what it does.** "File sent mail automatically" read as a noun
  phrase before it read as an instruction. It is now "Add sent mail to SuiteCRM
  automatically", and the explanation drops a double negative.
- **The interface says "file" where it used to say "archive".** Thunderbird has its own
  Archive button, which moves mail to a local folder, so a window offering to "Archive" a
  message was describing something it does not do. "Archive" now appears only where SuiteCRM
  is named in the same breath, which is where it cannot be mistaken.
- *Find more modules* is now *Re-scan modules*, since it re-tests refused modules as well as
  looking for new ones.
- Em dashes are gone from the interface, the documentation and the listing text.
- Checksums are written by the build rather than by hand, so `dist/SHA256SUMS` cannot lag a
  release.
- **Every lint warning is gone, and the build now fails on the first new one.** Three were
  real: two windows saving a preference at once could lose one of the two patches; pressing
  *Change* twice quickly let the slower first lookup overwrite the second, so the window
  showed one address with another's results; and switching between Lead and Contact while a
  signature parsed could fill the new form from the old one.
- A `commit-msg` and a `pre-commit` hook in `tools/hooks`, so a bad commit message or a
  failing test stops the commit rather than the build.
- Test coverage for all of the above: 395 unit tests, and five new end-to-end steps that
  create a Case on a live SuiteCRM, store the notification it would have sent, reply to it
  twice, and file both replies back onto the Case, once by subject and once by reference
  chain with no number in the subject at all. All 61 end-to-end steps pass against a live
  instance.

## 0.4.3 (2026-09-10)

- **You can now delete what the add-on remembers about you.** Two things were kept in your
  profile with no way to clear them short of uninstalling: which CRM record mail from each
  address was last filed against, which is what the right-click menu and `Alt+Shift+A` file
  against, and the subject of the last 30 emails you filed, for the *Recent* list. Behaviour
  now has *Clear what is remembered*, which says how many of each are there before you press
  it and takes nothing else, you stay signed in and your settings stay put. The privacy
  policy had claimed no subject was ever kept locally, which was simply wrong, and now
  describes both, along with the settings export writing the client secret to a file.
- **About has a Developer Support button**, next to *What's new* and *Developer website*. It
  opens the issue tracker. The address was in the README and on the store listing, neither of
  which is in front of you at the moment something breaks.
- **Two files no longer ship inside the add-on.** The icon's SVG drawing and a generated HTML
  copy of these release notes sat in `src/`, which is packaged wholesale, so both travelled in
  the .xpi without anything ever loading them. ATN's reviewers turned down 0.2.2 over exactly
  that: unused files make a review harder, can reveal details of the machine the package was
  built on, and pad the download. The drawing now lives in `img/`, the settings page keeps
  reading the JSON it always read, and the build fails if anything unreferenced appears in
  `src/` again.

## 0.4.2 (2026-09-10)

- **Fixed the context menu doing nothing.** It read the selected messages with a helper that
  returns one message rather than a list, so the click handler saw no messages and stopped,
  two of the three menu entries hid themselves, the keyboard shortcut failed, and the
  in-message CRM strip stopped appearing. All four are the same mistake, introduced in 0.4.0.

## 0.4.1 (2026-09-10)

- **The context menu now works when the toolbar button has not been placed.** It opened the
  window by asking the toolbar button to show its popup, which quietly declines when the
  button is not on the toolbar, so the menu item appeared to do nothing at all. It now falls
  back to a real window, with the right-clicked message named explicitly.
- **Filing without a window says what happened.** Both the context menu's "File against"
  entry and the keyboard shortcut archived silently, so success and failure looked identical.
  They now report the record filed under, or the reason nothing was.

## 0.4.0 (2026-09-10)

- **Right-click a message, or several, to file them.** The window opens whether or not the
  toolbar button has been placed, and filing without a window now says what happened, or
  what went wrong, instead of leaving you to guess. Three entries: open the archiving
  window, file against the record that sender's mail went to last time, or create a record.
  The middle one names the actual record and hides itself when there is nothing remembered,
  rather than offering something that would do nothing.
- **Keyboard shortcuts.** `Alt+Shift+S` opens the archiving window; `Alt+Shift+A` files
  against the remembered record with no window at all. Both re-bindable in Thunderbird's own
  add-on shortcut settings. The second opens the window instead of guessing when there is
  nothing remembered.
- **Choose which modules are searched**, and find more. Fewer modules means faster lookups,
  and a customised SuiteCRM can add its own. What is offered depends on **your own access**:
  SuiteCRM reports the modules you may list and view, so you are never offered one you would
  be refused, and a colleague with a different role sees a different list. Modules without an
  email address field are left out too, since they could never be searched by one, and the
  CRM's own labels are used so a custom module reads properly.
- **Share the connection settings.** One OAuth2 client serves a whole organisation, so an
  administrator can export the CRM address, client id and secret to a file for colleagues.
  Each person still signs in with their own username and password. The file contains no
  token and no username, and importing fills the form rather than connecting, so nothing can
  silently repoint the add-on at another server.
- A website guessed from an email domain now includes **www**, which is where a company of
  that shape serves its site. Not added when the mail host already has a subdomain, where it
  would invent an address nobody serves.

## 0.3.0 (2026-09-10)

- **A reply to case mail is now filed against the Case.** SuiteCRM stamps the case number
  into the subject of email it sends about a Case, so the reply comes back carrying it.
  When the subject contains one, that Case is offered first and pre-selected, ahead of
  anything inferred from the sender. It works even when the sender matches no CRM record,
  which is the situation an address lookup handles worst.
- The subject macro is configurable in settings for instances where an administrator changed
  `inbound_email_case_subject_macro`. It must contain `%1`, and a macro without it is not
  saved, since it could never identify a case.
- Matching can be switched off entirely.
- **The subject the CRM stores can be edited** before archiving. Click it in the archiving
  window, and *Strip Re:* removes stacked reply and forward prefixes in one go, in any of
  the languages the add-on already handles. The message in Thunderbird is never modified,
  and an edited subject applies to that one email rather than to a whole thread.

## 0.2.3 (2026-09-10)

- Switching **Record a detailed log** off now discards what it recorded, rather than
  leaving it in your profile until *Clear log* was pressed. Passwords, secrets and tokens
  were never recorded in the first place, but the log did hold email addresses and CRM
  URLs, and the switch implied it was gone.

## 0.2.2 (2026-09-10)

- Wording clarifications. No functional change.

## 0.2.1 (2026-09-10)

- Documentation and packaging updates, including screenshots. No functional change.

## 0.2.0 (2026-09-10)

First release.

### Signing in
- Uses the SuiteCRM **V8 REST API** with OAuth2, not the legacy `v4_1` endpoint.
- Your CRM password is used once to obtain a token and is **never stored**. Only a
  refresh token is kept, and it is replaced each time it is used.
- Access tokens last an hour and renew silently. The sign-in window is a month and
  resets on every use, so ordinary use means never signing in again, and a
  Thunderbird upgrade does not sign you out.
- The CRM address is detected automatically, whether the API sits at `/Api` or
  `/legacy/Api`.

### Archiving
- Clicking the toolbar button searches **Leads, Contacts, Accounts and Targets at the
  same time** for the sender's address. No module to choose, no search to type.
- A single match is pre-selected, so archiving is one further click.
- On a message **you sent**, the first **To:** recipient is the default target rather than
  the sender, who is you, and of no use to the CRM.
- *Change* lists the other people on the message, **To: first and Cc: after**, since To: is
  who the message was addressed to. Each is labelled with how many CRM records they already
  have. Only people on the target's domain are grouped as colleagues; other domains sit
  behind a toggle, and your own addresses are never offered.
- Cc: recipients can be left out of that list entirely; To: recipients are always offered.
- Contacts and Accounts expand in place, so the email can be filed against a linked
  Opportunity, Quote, Case or Project instead.
- **Create record…** turns the email into a Case, Opportunity, Meeting or follow-up Task
  linked to the selected record, filing the email against it at the same time. Only the
  kinds SuiteCRM will actually link are offered, a Case needs an Account behind it, so it
  is not offered for a Target or an unconverted Lead, and the picker says why rather than
  quietly leaving them out.
- An email already archived is re-filed against the new record rather than duplicated.
- **The record carries the message's own date**, so an older message lands at the date it
  was written rather than the day you archived it, and the CRM's activity timeline stays in
  order. This can be switched off in settings, or per message from the archiving window.
- Attachments are stored as Notes. Inline images embedded in the body are skipped by
  default.
- **Archive the whole conversation** in one go. The thread is rebuilt from the message's
  own `References` chain, and messages that merely share a subject are excluded.
- **Archive several messages you picked by hand**, when more than one is selected in the
  message list.

### Creating records
- When the sender is unknown, create a **Lead**, or a **Contact** under an Account.
- The form is filled in from the signature block, the message headers, and an attached
  vCard when there is one. Everything is worked out on your own machine; no message
  content is sent anywhere except your CRM.
- Anything the parser is not sure about is highlighted for you to confirm, so a guess
  is never saved silently.
- A website guessed from the sender's email domain is filled in and marked as a guess for
  you to confirm. The add-on never contacts it, no third-party site is ever fetched, and
  the only site permission it asks for is your own CRM.
- The signature is located by its sign-off ("Regards," and the like) rather than by
  guessing at the last few lines, so a greeting or the message body is never mistaken for
  contact details.
- Inline image placeholders, certification lines and tracking links no longer produce
  invented phone numbers, companies or postal addresses. A number needs a label, an
  international prefix or human grouping before it is treated as a phone number.
- **Your own signature is never harvested from a reply.** If the signature block names
  only addresses on other domains, it belongs to someone else and is discarded.
- Swedish, Norwegian and Danish signatures are handled: compound job titles
  (*Kontorschef*), one-line addresses (*Mätarvägen 3B, 196 37 Kungsängen*), *Direkt* and
  *Växel* as separate numbers, and *Från:* / *Fra:* / *Skickat:* / *Ämne:* as quote markers.
- Names keep *Mc*, *Mac*, *O'*, *van* and *de* with the surname.
- Existing Accounts on the sender's domain are offered, so a Contact can be linked to
  the right company instead of creating a duplicate Account.
- Someone merely copied on the message never inherits the sender's job title, phone
  numbers or address, only company details, which the whole domain shares.

### Safeguards
- An email whose `Message-ID` matches one already archived is only re-filed when the sender
  matches too. A `Message-ID` is chosen by whoever sent the message and is not
  authenticated, so a match on its own is not proof the two are the same email.
- The add-on asks for permission to reach your CRM's address specifically, not every site,
  and refuses to sign in without it.
- An unencrypted `http://` CRM address is called out in the settings, because the password
  grant sends your password in the request body.

### Settings
- Choose which mail accounts the archiving button works in, with **Untick all** and
  **Tick all** for mailboxes carrying many accounts. Leaving them all ticked also covers
  accounts added later. This scopes what the add-on acts on; Thunderbird grants add-on
  permissions per profile, so it is not a permission boundary.
- The SuiteCRM setup guide sits below the connection form and can be hidden once done.
- Optionally refuse to sign in over an unencrypted connection, so the CRM password can never
  cross the network in the clear.

### Fixed
- Sign-in failed with a bare network error against any CRM served over plain `http://`.
  Manifest V3 add-ons default to a policy that silently rewrites `http://` requests to
  `https://`; the add-on now declares its own policy without that directive. This is why the
  Manifest V2 add-on it replaces could reach the same address and this one could not.
- Sign-in also failed against any CRM on a non-default port, because Thunderbird does not
  accept a port in a permission pattern. The add-on now asks for the host without one.

### Speed
- The window opens immediately and fills in as answers arrive, with a visible searching
  state, instead of waiting for the CRM and a mailbox-wide scan first.
- Conversation discovery is scoped to the message's own account rather than searching
  every account in the profile.

### Troubleshooting
- A **Test connection** button reports which layer is failing, host permission not granted,
  granted but blocked, or the CRM genuinely unreachable, rather than a bare network error.
- **Record a detailed log**, off by default, captures what the add-on does and every request
  it makes, then exports it as a text file to save or copy.
- The report is written to be safe to share. Passwords, client secrets and access tokens are
  never recorded, so they cannot leak; message subjects and bodies are never captured; email
  addresses and the CRM host are masked unless you choose to include them.

### Reliability
- Creating a Contact from a signature containing a website no longer fails. Attributes are
  checked against the module's own field list before being sent, since modules differ.
- An archived email keeps its sender and recipients. These fields are writable but absent
  from SuiteCRM's own field metadata, so they need explicit handling.
- Re-filing an already-archived email now confirms the sender matches before reusing the
  record, using the field SuiteCRM actually returns.

### Appearance
- Proper toolbar icons at every size Thunderbird asks for, so the button is visible in
  Customise Toolbar rather than blank.
- A main-toolbar button in addition to the one in the message header.

### Requirements
- Thunderbird 140 ESR or newer. Verified on 140 ESR through 155.
- Your CRM password is used once and never stored; only a rotating refresh token is kept.
  The add-on declares that it handles your **personal communications** and **personally
  identifying information**, because email content and contact details leave your machine
  for your CRM. Nothing is sent anywhere else.
- SuiteCRM 7 or 8 with the V8 API enabled and an OAuth2 **Password** client.
