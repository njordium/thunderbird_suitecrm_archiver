# Server setup, SuiteCRM side

One-time work by a SuiteCRM administrator. Without it the V8 API cannot issue tokens.

Current status of the test instance at `http://crm.example.com:8484/` (probed 2026-09-09):

| Check | Result |
| --- | --- |
| Instance reachable | yes, Apache 2.4.52, SuiteCRM 8 (`SCRMSESSID` + `XSRF-TOKEN` cookies) |
| V8 API present | **yes, at both `/Api/access_token` and `/legacy/Api/access_token`** |
| OAuth2 RSA keys loading | **yes**, the endpoint got as far as looking up the client id |
| OAuth2 client created | yes, `Thunderbird`, Password Grant |
| Password grant | **works**, 3600s access token, refresh token issued |
| Refresh-token rotation | **confirmed**, each refresh mints a new one |
| `email1` join (Contacts/Leads/Accounts/Prospects) | **works, returns real records** |
| Create Contact / Email / Note-with-attachment | **works**, incl. relationships and delete |
| Full harness | **23 of 23 checks pass** (2026-09-09) |

Credentials are not recorded here. Supply them through the environment as shown below.

Verified live against this instance, not just read from the source.

---

## 1. Create the OAuth2 client

Admin → **OAuth2 Clients and Tokens** → **New Password Client**.

- **Name**: `Thunderbird Archiver`
- **Secret**: use the **generate** control in the add-on's settings, beside the secret field.
  **copy**, next to it, puts the value back on the clipboard later, SuiteCRM never will.
  It produces a 256-bit random value and copies it, ready to paste into SuiteCRM's
  *Change Secret* field. From a shell, `openssl rand -hex 32` is the same thing.

Copy the **id** and the **secret** as soon as you save. SuiteCRM hashes the secret on save and
will never show it again.

Use a *Password* client, not a Client Credentials one, only the password grant issues the
refresh token this add-on depends on.

### Recommendation: generate the secret, do not invent one

Use the **generate** control beside the secret field in the add-on's settings, or
`openssl rand -hex 32` if you prefer a shell. Either gives 256 random bits.

The reason is specific to how SuiteCRM stores it. From
`modules/OAuth2Clients/OAuth2Clients.php`:

```php
$this->secret = hash('sha256', (string) $_REQUEST['new_secret']);
```

One round of SHA-256, no salt, no iterations, not `password_hash`, not bcrypt. Two
consequences:

- **A memorable secret is recoverable.** SHA-256 is fast by design, so anyone holding a copy
  of the database can run a wordlist against it at enormous speed. `SuiteCRM2026!` would not
  survive the attempt.
- **No salt means precomputation works.** The same secret hashes to the same value on every
  SuiteCRM in the world, so a common choice may already be in a lookup table.

Neither matters against 256 random bits: there is nothing to guess and nothing to have
precomputed. This is why the add-on offers to generate one rather than leaving it to
judgement, the storage is weak, so the input has to be strong.

### Is the client secret a password?

Treat it as one. It is a credential that authenticates the *add-on* rather than you,
but the handling is the same: generate it randomly, do not reuse it, and rotate it if it
leaks. SuiteCRM stores only its SHA-256 hash, which is why the edit form says *"take a note
of the secret as it will not be available after you save"*, nobody can recover it, so
losing it means setting a new one.

One honest caveat about how much it protects. In OAuth2 terms a *confidential* client is one
that can genuinely keep a secret, server-side code, where users never see the credentials.
A desktop add-on cannot: the secret lives in the Thunderbird profile on disk, so anyone with
the profile has it. By the specification's own definition this is a **public client**.

Its real value is not secrecy from the user but separation and revocability: it identifies
this integration specifically, so an administrator can revoke Thunderbird's access from
Admin → OAuth2 Clients and Tokens without changing your CRM password or disturbing anything
else.

### What "Is Confidential" does in SuiteCRM

**Nothing, for authentication.** Verified in the source rather than inferred:

- `ClientRepository::validateClient()` compares `hash('sha256', $clientSecret)` against the
  stored secret with no reference to the flag.
- SuiteCRM pins `league/oauth2-server ^8.5`, and in 8.5 `AbstractGrant::validateClient()`
  calls the repository **unconditionally**, there is no `isConfidential()` check in that
  path at all.
- The flag is read into the client entity (`setIsConfidential`) and exposed through
  League's `ClientTrait`, but the only code that consults it is `AuthCodeGrant`, for
  deciding whether PKCE is mandatory, and SuiteCRM ships no `/authorize` endpoint, so that
  grant is unreachable.

So leaving it unticked does **not** create a client that can authenticate without a secret.
Set a secret either way; a probe with an empty one is rejected exactly like a wrong one.

### The secret is always required

`Api/V8/OAuth2/Repository/ClientRepository.php`:

```php
public function validateClient($clientIdentifier, $clientSecret, $grantType)
{
    if ($grantType === $client->allowed_grant_type || $grantType === 'refresh_token') {
        return hash('sha256', $clientSecret) === $client->secret;
    }
    return false;
}
```

Two things follow:

1. The secret is checked **unconditionally**. Leaving *Is Confidential* unticked does not make
   this a public client that can authenticate without one, an empty secret is rejected like
   any other wrong value.
2. `refresh_token` is accepted **whatever** the client's configured grant type is. So a
   Password client can refresh, which is what this add-on relies on.

The secret is stored as a SHA-256 hash and cannot be read back. If it has been lost, open the
client and set a new one, SuiteCRM re-hashes on save.

### Telling the two failure modes apart

Probing the token endpoint distinguishes them cleanly:

| Response | Meaning |
| --- | --- |
| `unknown_error`, "OAuth2Clients module with id X is not found" (HTTP 500) | the client id is wrong |
| `invalid_client`, "Client authentication failed" (HTTP 401) | id is right, **secret is wrong** |
| `invalid_credentials` / `invalid_grant` | client is fine, the **user** credentials are wrong |

## 2. Confirm the keys and encryption key (probably already done)

The probe suggests both are fine, but for reference:

```bash
cd /path/to/suitecrm/public/legacy   # SuiteCRM 8; on 7.x it's the web root
ls -l Api/V8/OAuth2/private.key Api/V8/OAuth2/public.key
```

If missing:
```bash
openssl genrsa -out Api/V8/OAuth2/private.key 2048
openssl rsa -in Api/V8/OAuth2/private.key -pubout -out Api/V8/OAuth2/public.key
chmod 600 Api/V8/OAuth2/private.key Api/V8/OAuth2/public.key
chown www-data:www-data Api/V8/OAuth2/private.key Api/V8/OAuth2/public.key
```

And in `config.php`, confirm a non-default value:
```php
'oauth2_encryption_key' => '<a long random string>',
```
If this is unset SuiteCRM falls back to the literal `SCRM-DEFK` and writes a fatal to the log.
(Source: `Api/V8/Config/services/middlewares.php`.)

## 3. Verify, without putting credentials in a chat log

```bash
export CRM_URL=http://crm.example.com:8484
export CRM_CLIENT_ID=...
export CRM_CLIENT_SECRET=...
export CRM_USERNAME=...
read -rs CRM_PASSWORD && export CRM_PASSWORD   # typed, not echoed

node tools/verify-crm.mjs                 # read-only
node tools/verify-crm.mjs --write         # also creates + deletes a throwaway record
node tools/verify-crm.mjs --email someone@known-customer.com   # test a real lookup
```

The harness exercises every call the add-on makes: discovery, password grant, **refresh-token
rotation**, `current-user`, `meta/modules`, the `email1` join on each module, the
`message_id` de-duplication lookup, and, with `--write`, creating a Contact, an Email, and a
Note carrying a base64 attachment, then deleting all three.

## 4. If sign-in fails with "NetworkError"

The request never left Thunderbird. Press **Test connection** in the add-on's settings, it
distinguishes the causes rather than leaving you to guess:

| What the test says | Cause | Fix |
| --- | --- | --- |
| host permission NOT granted | Thunderbird blocked it before any request | Press **Grant access**, or enable website access on the add-on's Permissions tab |
| permission granted, still no connection, address is `http://` | HTTPS-Only mode, or mixed-content blocking | Check `dom.security.https_only_mode` in the Config Editor; otherwise serve the CRM over `https://` |
| permission granted, still no connection, address is `https://` | genuinely unreachable | check the host, port and firewall |

In Manifest V3 host permissions are **optional and off by default**, so a fresh install can
reach nothing until access is granted. That is the usual cause.

### A plain http:// CRM

**Diagnosed on Thunderbird 155, 2026-09-09.** Manifest V3 add-ons get a default content
security policy of `script-src 'self'; upgrade-insecure-requests;`. That last directive
rewrites every `http://` request to `https://`, so a CRM served over plain http becomes
unreachable, the request fails in a few milliseconds with a bare `NetworkError`, while host
permissions are granted and the server is answering CORS preflights correctly.

This add-on overrides the default policy and omits the directive, and
`tools/validate-manifest.py` fails the build if it is ever reintroduced.

It is also why the Manifest V2 add-on this replaces could reach the same URL from the same
machine: the MV2 default policy has no such directive.

Serving SuiteCRM over `https://` avoids the whole class of plaintext restriction, and stops
the CRM password crossing the network in clear text on every sign-in.

### A CRM on a non-default port

Firefox, and therefore Thunderbird, **does not accept a port in a match pattern**
([bug 1362809](https://bugzil.la/1362809)). A pattern such as `http://crm.example.com:8484/*` is
not merely unmatched, it is rejected, and `permissions.request()` and
`permissions.contains()` **throw** rather than returning `false`.

The add-on therefore asks for `scheme://host/*` with no port, which is the narrowest grant
the platform can express and covers that host on any port. If you see a permission error
naming a pattern that contains a port, that is the bug: it was fixed in 0.1.0 after the
first field test.

## 5. CORS, probably not needed

Advice to add `Access-Control-Allow-Origin` to `.htaccess` circulates for this kind of
integration. It is not needed here: every CRM request is issued from the extension's
background event page, and a privileged extension context holding a matching host
permission is exempt from CORS enforcement. A CORS message in this situation is usually a
catch-all error handler misreporting an ordinary 401 or 500, so treat it as a symptom to
diagnose rather than a header to add.

Still to be confirmed in Thunderbird itself. If it turns out to be needed:
```apache
<IfModule mod_headers.c>
  Header set Access-Control-Allow-Origin "moz-extension://<extension-uuid>"
</IfModule>
```

## 6. Note on transport security

The test instance is plain HTTP on a private address. The password grant sends the CRM
password in the request body, so on HTTP it crosses the network in cleartext. Fine for a LAN
test box; use HTTPS before this touches production or any real credential.
