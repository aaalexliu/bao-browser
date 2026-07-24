# Bao Browser — Secrets & 2FA Integration Research

> Parent docs: [[product-design-v1]] (waitForUser primitive, T1 masking), [[m4-parameterization-loops-design]] (`{{variable}}` slots, the "sensitive slot"), [[backend-webapp-design]] (secrets are already safe, sharing hazards).
> Status: research / decision memo. No code. Answers "how do other apps expose 2FA/secrets at runtime, and should Bao build a native-host bridge to them?"

## TL;DR

- Bao's runtime is **attended** (user triggers a workflow, side panel is open). That single fact reframes the whole problem: Bao never needs *unattended* secret replay, which is exactly the mode that forces a standing credential liability.
- Today's answer — `waitForUser` pause for login/2FA/CAPTCHA — is the correct **mass-market default** and should stay the default.
- Every password manager's runtime surface (CLI, local REST, SDK, native-messaging) still requires the vault to be **unlocked by a user credential**. None bypasses unlock; that's the design, not a gap.
- An MV3 extension **cannot spawn a process**, so any integration needs a **Chrome native-messaging host** as the bridge. The host's OS manifest pins Bao's extension ID in `allowed_origins` — install friction is unavoidable, even for KeePassXC.
- The real decision is a **trust axis, not an API**: interactive/biometric unlock (human in the loop, no standing secret) vs service-account/API-key (unattended, but a long-lived vault credential now lives in Bao's world).
- **Recommendation:** build the bridge only as a later **power-user tier**, and only over **interactive-unlock** surfaces. Because Bao runs attended, a biometric-unlock TOTP fetch and a `waitForUser` pause sit on the *same* trust footing — the bridge buys one saved keystroke, not a new capability. That marginal gain is the bar the bridge has to clear.

---

## 1. Where 2FA/secrets actually bite

From [[recording-gaps-and-app-universe]] and [[use-cases-and-snapshot-fallback]]: login, 2FA, CAPTCHA, and file upload all degrade to a clean `waitForUser` pause today. T1 masking ([[backend-webapp-design]] §"Secrets are already safe") means a `sensitive` step never stored a value in the first place — grep the serialized workflow and there is no secret string anywhere.

So the question is narrow: **for a workflow the user re-runs often, is pausing to hand-enter a TOTP enough friction to justify pulling the code from their password manager automatically?** M4's "sensitive slot" (`docs/m4-parameterization-loops-design.md:65` — "field is focused but not filled; the user supplies the secret") is the natural seam where a manager-backed resolver would plug in.

## 2. The landscape (verified July 2026)

Every surface below requires an unlocked vault. Retrieval calls shown include the live TOTP path.

| Manager | Runtime surface | TOTP retrieval | Unlock / auth model | Notes |
|---|---|---|---|---|
| **1Password** | `op` CLI | `op item get <item> --otp` (live TOTP); `op read op://…`; `op run -- cmd` | **Biometric** via desktop-app integration (interactive), or `OP_SERVICE_ACCOUNT_TOKEN` (unattended) | The workhorse. Biometric = Touch ID per unlock; service account = standing secret |
| **1Password** | JS/Go/Python/.NET/Rust **SDK** | `secrets.resolve("op://vault/item/one-time password?attribute=otp")` (`?attribute=otp` or `?attribute=totp`) | **Service account token only** — SDK does *not* support desktop/biometric unlock | Best fit if Bao ships a native host (no binary dependency), *but* forces the standing-secret model |
| **1Password** | Connect (self-hosted REST, Docker) | `GET /v1/vaults/{id}/items/{id}` → TOTP field in payload | Connect token + credentials file | Infra-oriented; overkill for a desktop end user |
| **1Password** | Desktop↔extension native messaging | — | — | Proprietary, not a public API. Unusable |
| **Bitwarden** | `bw` CLI | `bw get totp <item>` (live TOTP) | `bw login` (email+2FA, or `--apikey`) → `bw unlock` returns a `BW_SESSION` key passed to every call | API key avoids interactive login, but **master password still needed to unlock** |
| **Bitwarden** | `bw serve` (local REST, `:8087`, binds localhost) | `GET /object/totp/<id>`; also `/object/password/<id>`, `/list/object/items`, `/unlock`, `/lock` | Same session/unlock as CLI | **Cleanest surface for Bao** — a localhost endpoint a native host (or extension with host perms) can call |
| **Bitwarden** | Secrets Manager SDK | machine accounts + `client.secrets` | Access token | ⚠️ **Wrong product** — dev/env secrets, not the personal login vault where your TOTP lives |
| **KeePassXC** | **Browser native messaging** (`keepassxc-proxy`) | `get-totp` action (KeePassXC 2.6.1+); `get-logins` | Per-client **association key** stored in the DB; user approves once; DB must be unlocked | The one manager with a *documented* extension-facing protocol — but see §4 for why it's still not friction-free |
| **Proton Pass** | `pass` CLI (shipped 2026) | login items carry TOTP; CLI retrieves secrets | Interactive: prompts password / TOTP / extra password | Aimed at CI/scripts; interactive unlock |
| **Dashlane / Enpass** | — | No documented consumer TOTP-retrieval surface found | — | Skip |

**Key structural fact:** 1Password has **no localhost REST API** for third parties (CLI, SDK, or Connect only). Bitwarden's `bw serve` is the one clean localhost REST. KeePassXC is the one native-messaging protocol.

## 3. The MV3 wall: why a native host is mandatory

An MV3 service worker cannot `exec` a process. The only sanctioned bridge is **Chrome native messaging**:

- Extension declares the `nativeMessaging` permission and calls `chrome.runtime.connectNative(hostName)` / `sendNativeMessage`. Available in the service worker and extension pages, **not in content scripts**.
- Chrome launches a **native host process** described by an OS-level **host manifest** (a JSON file in a platform-specific location). The manifest's `allowed_origins` array must list **Bao's exact extension ID** (`chrome-extension://<id>/`). Chrome passes the caller origin as the host's first arg so the host can verify it.

Consequences:
1. **There is an install step no matter what.** The user (or an installer) must place a native-host manifest on disk pinned to Bao's extension ID. This is the friction floor for *any* manager integration.
2. Bao's native host is where a manager credential (service-account token / `BW_SESSION` / KeePassXC association key) would live. That host, not the extension, is the trust boundary.

## 4. Per-manager bridge shapes

- **1Password** → native host embeds the **JS SDK** with a service-account token (no binary dependency), or shells `op … --otp` against the desktop app for biometric unlock. SDK path = standing secret; CLI path = interactive.
- **Bitwarden** → native host proxies to **`bw serve`** on localhost, or shells `bw get totp` with a cached `BW_SESSION`. Either way an unlock/session is required per boot.
- **KeePassXC** → *tempting* because the extension could speak the protocol directly (TweetNaCl `box`, `change-public-keys` → `associate`/`test-associate` → `get-logins`/`get-totp`). **But**: (a) the `keepassxc-proxy` host manifest's `allowed_origins` lists only KeePassXC-Browser's extension IDs, so Bao can't attach to it without the user editing that manifest or Bao shipping its own proxy; and (b) association is a **per-client key pair the user must approve once and that lives in the DB**. So KeePassXC removes the "build your own vault-access logic" work but **not** the native-host install nor the user-approval step.

## 5. The decision that actually matters (trust, not API)

Two credential models, and they are not close in posture:

- **Interactive / biometric unlock** (1Password desktop-app integration, `bw unlock` per session, KeePassXC association + unlocked DB): the human stays in the loop; **no standing secret** sits in Bao's world. Better posture. Not truly unattended — which is fine, because **Bao isn't unattended.**
- **Service account / API key** (1Password service-account token, Bitwarden API key): enables unattended replay, but now a **long-lived credential with standing vault access** lives wherever Bao's native host keeps it. For a non-technical-user product, that is a genuine **secret-at-rest liability** and a much bigger blast radius than the workflow it automates.

### The reframe that decides it

Bao's runtime is **attended** — the user triggered the run and the side panel is open. So the honest comparison for a TOTP step is:

> **`waitForUser`:** user glances at their authenticator and types 6 digits.
> **Biometric bridge:** user does one Touch ID prompt and Bao fetches the code.

Same trust footing (human in the loop, no standing secret). The bridge buys **one saved keystroke**, at the cost of a native-host install and a hard dependency on the user's specific password manager. It is a convenience delta, not a capability unlock.

A **service-account bridge** *would* be a capability unlock (fully hands-off runs), but it is the one model whose security posture is wrong for a mass-market local-first product — and it contradicts the "the LLM is not the runtime / fail cleanly" thesis by planting a standing vault credential in the automation layer.

## 6. Recommendation for Bao

1. **Keep `waitForUser` as the default** for login/2FA/CAPTCHA across the mass-market build. It is already built, has zero standing-secret surface, and is on equal footing with a biometric bridge given the attended runtime.
2. **Gate any manager bridge behind a power-user tier**, surfaced at the M4 "sensitive slot" as an optional resolver, with the trust tradeoff made explicit in-product.
3. **Prefer interactive-unlock surfaces**, in this order of cleanliness:
   - **Bitwarden `bw serve`** (native host proxies localhost REST; per-session unlock) — cleanest REST surface.
   - **1Password desktop-app biometric** via `op … --otp` shelled from the native host — best posture (Touch ID, no stored token).
   - **KeePassXC** native-messaging (own proxy + association) — good posture but most integration surface.
4. **Avoid storing service-account tokens in the consumer build.** If ever offered (true CI-style unattended runs), keep the token in the **OS keychain via the native host, never in extension storage**, and force an explicit, scary-honest opt-in.
5. **The native host is the trust boundary, not the extension.** Any credential lives there; the extension only ever sees a freshly-minted, short-lived TOTP passed back over the native-messaging port.

## 7. If/when we build it — open specs

Deferred until the power tier is scheduled. To resolve then:

- **Message protocol** over the native-messaging port: `resolve-totp(item-ref)` → `{ code, ttl }`; `unlock()` / `lock()`; capability/health handshake. Keep it manager-agnostic so 1Password/Bitwarden/KeePassXC are backends behind one Bao-side interface.
- **Token/session storage** in the host: OS keychain (Keychain / Credential Manager / libsecret). Never plaintext, never extension `storage`.
- **Unlock lifecycle:** when does the session expire, and does re-unlock reuse the attended `waitForUser` UX?
- **Threat model:** localhost REST (`bw serve`) is reachable by any local process — bind + auth story. Native-host manifest tampering. Extension-ID spoofing (mitigated by `allowed_origins`).
- **Distribution:** how the native-host manifest gets installed for a non-technical user (installer vs. guided manual step), per-OS.

---

## Sources

- 1Password SDKs — [load secrets / `?attribute=otp`](https://www.1password.dev/sdks/load-secrets/), [SDK concepts](https://developer.1password.com/docs/sdks/concepts/), [manage items](https://developer.1password.com/docs/sdks/manage-items/), [service accounts](https://www.mackorone.com/2023/12/06/1password-service-accounts.html), [OTP field support issue](https://github.com/1Password/onepassword-sdk-python/issues/59)
- Bitwarden — [CLI docs](https://bitwarden.com/help/cli/), [Vault Management API / `bw serve`](https://bitwarden.com/blog/bringing-restful-api-to-the-bitwarden-cli/), [bind to localhost issue #518](https://github.com/bitwarden/cli/issues/518), [Password Manager APIs](https://bitwarden.com/help/bitwarden-apis/)
- KeePassXC — [browser protocol spec](https://github.com/keepassxreboot/keepassxc-browser/blob/develop/keepassxc-protocol.md), [docs/FAQ](https://keepassxc.org/docs/)
- Chrome native messaging — [Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
- Proton Pass — [Introducing CLI for Proton Pass](https://proton.me/blog/proton-pass-cli)
