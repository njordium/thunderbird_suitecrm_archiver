# Changelog

## 0.2.1 — 2026-09-10

- Documentation and packaging updates, including screenshots. No functional change.

## 0.2.0 — 2026-09-10

First release.

### Signing in
- Uses the SuiteCRM **V8 REST API** with OAuth2, not the legacy `v4_1` endpoint.
- Your CRM password is used once to obtain a token and is **never stored**. Only a
  refresh token is kept, and it is replaced each time it is used.
- Access tokens last an hour and renew silently. The sign-in window is a month and
  resets on every use, so ordinary use means never signing in again — and a
  Thunderbird upgrade does not sign you out.
- The CRM address is detected automatically, whether the API sits at `/Api` or
  `/legacy/Api`.

### Archiving
- Clicking the toolbar button searches **Leads, Contacts, Accounts and Targets at the
  same time** for the sender's address. No module to choose, no search to type.
- A single match is pre-selected, so archiving is one further click.
- On a message **you sent**, the first **To:** recipient is the default target rather than
  the sender — who is you, and of no use to the CRM.
- *Change* lists the other people on the message, **To: first and Cc: after**, since To: is
  who the message was addressed to. Each is labelled with how many CRM records they already
  have. Only people on the target's domain are grouped as colleagues; other domains sit
  behind a toggle, and your own addresses are never offered.
- Cc: recipients can be left out of that list entirely; To: recipients are always offered.
- Contacts and Accounts expand in place, so the email can be filed against a linked
  Opportunity, Quote, Case or Project instead.
- **Create record…** turns the email into a Case, Opportunity, Meeting or follow-up Task
  linked to the selected record, filing the email against it at the same time. Only the
  kinds SuiteCRM will actually link are offered — a Case needs an Account behind it, so it
  is not offered for a Target or an unconverted Lead, and the picker says why rather than
  quietly leaving them out.
- An email already archived is re-filed against the new record rather than duplicated.
- **The record carries the message's own date**, so an email from June sits under June in
  the CRM's activity timeline rather than under the day you archived it. This can be
  switched off in settings, or per message from the archiving window.
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
  you to confirm. The add-on never contacts it — no third-party site is ever fetched, and
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
  numbers or address — only company details, which the whole domain shares.

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
- A **Test connection** button reports which layer is failing — host permission not granted,
  granted but blocked, or the CRM genuinely unreachable — rather than a bare network error.
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
