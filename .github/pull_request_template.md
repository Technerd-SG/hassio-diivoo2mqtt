<!--
Please target `develop`, not `main`. GitHub preselects `main`, so it is easy
to miss. If you got it wrong, don't worry — we can retarget the PR for you.

See CONTRIBUTING.md for the branch model and the project-specific pitfalls.
-->

## What does this change?

<!-- A sentence or two. What problem does it solve? -->

Fixes #

## How was it tested?

<!--
Real hardware matters here — radio timing, pairing, OTA and gateway recovery
cannot be verified by unit tests. Tell us what you ran it against, or say
plainly that you could not test it. Both are useful.
-->

- Valve model(s):
- Gateway firmware version:

## Checklist

- [ ] PR targets `develop`
- [ ] `npm test` passes in `diivoo2mqtt/backend`
- [ ] `npm run build` passes in `diivoo2mqtt/frontend`
- [ ] No existing `unique_id`, discovery topic or entity domain was changed
      (these break users' automations and history — see CONTRIBUTING.md)
- [ ] New user-visible entity names have keys in **all** files under
      `diivoo2mqtt/backend/locales/`
- [ ] No credentials, logs, build output or third-party copyright headers

<!--
Anything left unchecked is fine as long as you mention why. A PR that is
substantially right gets merged and refined afterwards rather than rejected.
-->
