# Research notes — Thunderbird → SuiteCRM archiver

Date: 2026-09-09

## 1. SuiteCRM V8 API — auth capability check

Source read: `salesagility/SuiteCRM` @ `hotfix`.

`Api/V8/Config/services/middlewares.php` registers on the League OAuth2 server:

| Grant | Access-token TTL | Notes |
|---|---|---|
| `client_credentials` | 1 hour | machine identity, loses per-user attribution |
| `password` | 1 hour | returns a refresh token |
| `refresh_token` | 1 hour | **refresh-token TTL `P1M` (1 month)** |
| `authorization_code` | 1 hour (code TTL 10 min) | registered… but see below |

`Api/V8/Config/routes.php` exposes exactly **one** OAuth route:
```php
$app->post('/access_token', ...)->add(new AuthorizationServerMiddleware(...));
```
There is **no `/authorize` route** — no consent screen, no way to *obtain* an auth code.
So `authorization_code` is only half-wired: the token endpoint would exchange a code, but
nothing can issue one. Upstream issue
[#7854](https://github.com/salesagility/SuiteCRM/issues/7854) ("Implementation of
authorization code grant type flow missing") is still **open**, filed 2019-09-12.

### Consequence for this project
A pure browser OAuth2 redirect flow (`identity.launchWebAuthFlow`) is **not possible against
stock SuiteCRM**. The best available design is:

1. Ask for CRM URL + username + password **once**, `grant_type=password`.
2. Persist **only** the `refresh_token` (never the password).
3. Rotate: every refresh returns a new access token *and* a new refresh token; refresh TTL is
   1 month and resets on each use. Normal weekly use ⇒ the user never signs in again,
   and a Thunderbird upgrade does not invalidate anything (`storage.local` survives upgrades;
   a session-based integration fails on its dead server session id, not on its storage).
4. Optional later: ship a small SuiteCRM entryPoint implementing `/authorize` to unlock
   true auth-code + PKCE. Requires write access to the CRM server.

### Client validation (verified in source + probed live)
`Api/V8/OAuth2/Repository/ClientRepository.php::validateClient()` compares
`hash('sha256', $clientSecret)` against the stored secret **unconditionally** — the
`is_confidential` flag does not exempt a client from presenting one. The same method accepts
`refresh_token` regardless of the client's `allowed_grant_type`, which is why a Password
client can refresh.

### Server-side prerequisites (admin, one time)
- Generate `Api/V8/OAuth2/private.key` + `public.key` (RSA 2048), `chmod 600`, owned by web user.
- Set `oauth2_encryption_key` in `config.php` (otherwise it falls back to the literal
  `'SCRM-DEFK'` and logs a fatal — see middlewares.php).
- Admin → OAuth2 Clients and Tokens → new **Password Client**; record id/secret at creation
  (secret is hashed on save).
- SuiteCRM 8.x often serves the legacy API under `/legacy/Api/...`; 7.x uses `/Api/...`.
  The client must probe both.

### V8 endpoints we need
```
POST   /Api/access_token
GET    /Api/V8/current-user
GET    /Api/V8/meta/modules
GET    /Api/V8/meta/fields/{module}
GET    /Api/V8/module/{module}            (filter[...] / page[size] / fields[...])
GET    /Api/V8/module/{module}/{id}
POST   /Api/V8/module                     (create)
PATCH  /Api/V8/module                     (update)
GET    /Api/V8/module/{module}/{id}/relationships/{link}
POST   /Api/V8/module/{module}/{id}/relationships
```
**Resolved against a live SuiteCRM 8 instance, 2026-09-09.**

`filter` is a *structured* parameter, normalised server-side by
`Api/V8/JsonApi/Repository/Filter.php::parseWhere()`:

```
?filter[operator]=or&filter[<field>][<op>]=<value>
ops: eq, neq, gt, gte, lt, lte, like      joined by: and | or
```

Values pass through `DBManager::quoted()`, so unlike the v4_1 `query` string the reference
add-on used, this is **not** injectable. The field must exist in `field_defs`.

Confirmed behaviours:

- `filter[email1][eq]=<addr>` resolves an address to records in Contacts, Leads, Accounts and
  Prospects, via the `email_addresses` + `email_addr_bean_rel` join that
  `ModuleService::getRecords()` substitutes in. Verified returning real records.
- `filter[email2][...]` **fails with HTTP 400 "Database failure"**. The detection branch
  checks for `email2`, but the rewrite only ever replaces `.email1`, so the invalid column
  reaches SQL. Never filter on email2.
- An unknown field in `fields[Module]` is a **hard HTTP 400**
  (`"The following field in Account module is not found: first_name"`), not a silent
  omission. Since the resolver fans out with `allSettled`, a stale field list would make a
  module look empty and a known contact look absent — so `crm.js` retries once without the
  `fields` parameter, and the verify harness checks every list.

## 2. Thunderbird platform

- MV3 supported since **128 ESR**, which is now end of life. Current ESR is **140**,
  stable 155, next ESR 153.
  Target: `manifest_version: 3`, `strict_min_version: 140.0` — the floor is the current
  ESR, which also makes `data_collection_permissions` declarable (it needs 140+).
- Thunderbird MV3 background is an **event page** (`background.scripts` + `type: "module"`),
  not a service worker.
- APIs needed, all present: `messageDisplayAction`, `messages.getFull` (TB66),
  `messages.getRaw` (TB72), `messages.listAttachments` (TB88),
  `messages.getAttachmentFile` (TB88), `messages.query` (TB69) — all under `messagesRead`.
- `identity.launchWebAuthFlow` / `getRedirectURL` exist, but are unusable here (see §2).
- Do **all** CRM fetches from the background event page with `host_permissions`; privileged
  extension contexts are exempt from CORS enforcement, so the `.htaccess`
  `Access-Control-Allow-Origin` change often recommended for this should be unnecessary.
  VERIFY against a live instance before promising this.


## 3. Thunderbird host permissions (learned the hard way, 2026-09-09)

- In MV3 host permissions are **optional and off by default**. A fresh install can reach
  nothing until the user grants access, so any first-run network failure should be checked
  against `permissions.contains()` before anything else is suspected.
- **Match patterns cannot contain a port** ([bug 1362809](https://bugzil.la/1362809)).
  `new URL(x).origin + "/*"` yields `http://host:8484/*`, which Thunderbird rejects; both
  `permissions.request()` and `permissions.contains()` **throw** on an invalid pattern
  rather than returning `false`. Build patterns as `${protocol}//${hostname}/*`.
- `permissions.request()` needs a live user activation, and the activation does **not**
  survive an `await` — including a `runtime.sendMessage` round trip to the background page.
  Call it as the first `await` inside the page's own click handler.
- Requesting a permission already held resolves `true` without prompting, so there is no
  need to call `permissions.contains()` first — and doing so costs the activation.
- **The Manifest V3 default CSP breaks plain-http hosts.** MDN: the MV2 default is
  `script-src 'self'; object-src 'self';` while the **MV3** default is
  `script-src 'self'; upgrade-insecure-requests;`. That directive rewrites every `http://`
  request to `https://`. Against a CRM with no TLS listener the connection fails instantly,
  surfacing as `NetworkError` in single-digit milliseconds with host permissions fully
  granted and the server sending `Access-Control-Allow-Origin: *` — so it looks like a
  network, CORS or server fault while being none of them.

  This is precisely why a Manifest V2 add-on reaches the same URL on the same machine
  and this one did not. Fix: declare `content_security_policy.extension_pages` explicitly
  and omit `upgrade-insecure-requests`. `tools/validate-manifest.py` fails the build if it
  is missing or reintroduced.

  Ruled out along the way, each disproved by evidence rather than assumption: HTTPS-Only
  mode (`dom.security.https_only_mode` was `false`), host permissions (`permissions.getAll()`
  showed the origin granted), and CORS (the server answers the preflight 200 with
  `Access-Control-Allow-Origin: *`).


## 4. The Add-ons Manager Details tab (what the manifest can and cannot set)

Verified against `toolkit/mozapps/extensions/` in mozilla-central, 2026-09-09.

`XPIInstall.sys.mjs` builds the add-on's metadata from the manifest:

```js
let creator = rawManifest.author;
let homepageURL = rawManifest.homepage_url;
if (rawManifest.developer) {
  if (rawManifest.developer.name) creator = rawManifest.developer.name;
  if (rawManifest.developer.url)  homepageURL = rawManifest.developer.url;
}
return { creator: extension.localize(creator, aLocale), homepageURL: ..., developers: null };
```

`creator` is a **string**, so `XPIDatabase.sys.mjs` wraps it as `new AddonAuthor(result)` with
no URL. `aboutaddons.js` then does `link.hidden = !addon.creator.url`, so:

- **The Author line cannot be a hyperlink in a self-hosted add-on.** There is no manifest key
  for it. `developer.url` sets the *Homepage* line, not the author.
- The Author link seen on add-ons from addons.thunderbird.net comes from
  `this.creator = repositoryAddon.creator` — ATN listing data, pointing at the ATN author
  profile. It exists only for add-ons installed from ATN, and publishing there is the only
  way to obtain it.

What a self-hosted manifest *can* control on the Details tab: the description, the author
name as text, the Homepage link, the version, and the icon. Rich text and the long
description shown for ATN add-ons also come from the listing, not the manifest.


## 5. SuiteCRM V8 field quirks (found by end-to-end testing, 2026-09-09)

Discovered by `tools/e2e.mjs` running the add-on's real modules against a live instance.
None of these are documented; each silently corrupts data rather than erroring.

### `/meta/fields/<module>` is not the set of writable fields

`Emails` accepts `from_addr`, `from_name`, `to_addrs`, `cc_addrs` and `bcc_addrs` on write,
but **none of them appear in `/meta/fields/Emails`** — they are bean properties backed by a
relationship, not columns. A filter that keeps only what the metadata reports therefore
discards the sender and every recipient of an archived email, with no error at all.
`WRITE_ONLY_FIELDS` in `src/lib/modules.js` lists them so they are always kept.

### `from_addr` is write-only; `from_addr_name` is what reads back

Writing `from_addr: "Anna <anna@example.com>"` and reading the record back gives
`from_addr` **undefined** and `from_addr_name: "anna@example.com"` — the address alone,
display name stripped. Any code comparing a stored email's sender must read
`from_addr_name`. Reading `from_addr` yields `undefined` and, in a comparison written to
fail open, silently accepts everything.

### Modules differ in ways that break shared payloads

`Leads` has `website`; **`Contacts` does not**. Since the create payload is assembled from a
parsed email signature, a sender whose signature contains a URL made "Create Contact" fail
outright with `Property website in Contact module is invalid`. Attributes are now filtered
against the module's own field list before every write.

### Dates come back in a different format from the one written

Written as `YYYY-MM-DD HH:MM:SS`, returned as ISO 8601 with an offset
(`2026-09-09T10:30:00+00:00`). Compare by parsing to a timestamp, not by string equality.


## 6. Dating an archived email

SuiteCRM's activity timeline orders by **`date_entered`**, not `date_sent_received`, so an
email archived today appears under today's date however correct its send time is.

Verified against the live instance: the V8 API **honours an explicit `date_entered`**.
Writing `date_entered: "2026-06-30 20:28:00"` reads back as
`"2026-06-30T20:28:00+00:00"`, while `date_modified` still reflects the write. So a record
can carry the message's real date, which is what makes the timeline meaningful.

Thunderbird's `MessageHeader.date` is "the date and time when the message was sent,
according to the Date header". There is **no read timestamp** anywhere in the API — `read`
is a boolean, so "when it was read" cannot be offered as a choice.


## 7. `is_confidential` on a SuiteCRM OAuth2 client

Traced through the source, 2026-09-09, because the flag looks like it should gate the secret
check and does not.

- `Api/V8/OAuth2/Repository/ClientRepository.php::validateClient()` compares
  `hash('sha256', $clientSecret)` against the stored value with no reference to the flag.
- `composer.json` pins `league/oauth2-server ^8.5`. In 8.5.5,
  `Grant/AbstractGrant.php::validateClient()` calls the repository unconditionally:

  ```php
  [$clientId, $clientSecret] = $this->getClientCredentials($request);
  if ($this->clientRepository->validateClient($clientId, $clientSecret, $this->getIdentifier()) === false) {
      throw OAuthServerException::invalidClient($request);
  }
  ```

  Some other versions of League wrap that in `if ($client->isConfidential())`. This one does
  not, which is why an unticked box still demands a correct secret.
- The only uses of `isConfidential()` anywhere in League 8.5 are in `AuthCodeGrant`
  (lines 105 and 339), for deciding whether PKCE is required. SuiteCRM exposes no
  `/authorize` route, so that grant cannot be reached — see §2.

Conclusion: the flag is inert for every grant SuiteCRM can actually run. Matches the earlier
live probe, where both an empty and a wrong secret returned `invalid_client`.
