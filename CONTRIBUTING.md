# Contributing to diivoo2mqtt

Thanks for taking the time to contribute. This project exists because people
reverse-engineered a closed protocol and shared what they found, and pretty
much every release so far has been shaped by community reports and pull
requests.

## Send pull requests against `develop`

**Please target `develop`, not `main`.** GitHub defaults to `main`, so this is
easy to miss — if you already opened a PR against `main`, no problem, we can
retarget it for you.

| Branch | What it is |
|--------|------------|
| `main` | Tested stable releases only. Home Assistant users install from here. |
| `develop` | Integration branch for the next release. **Your PR goes here.** |
| `nightly` | `develop` plus its own add-on metadata, used for testing on real hardware. |

Small `fix/*` and `feature/*` branches are cut from `develop`.

## Local setup

Node.js 22 is what CI uses.

```sh
# Backend (the add-on itself)
cd diivoo2mqtt/backend
npm ci
npm test

# Frontend (the Ingress web UI)
cd diivoo2mqtt/frontend
npm ci
npm run build
```

Both must pass before a PR can be merged; CI runs exactly these two commands.

## Things that will hold up a merge

These are the project-specific traps. None of them are obvious from reading
the code, so please skim this section even if you have contributed elsewhere.

### Don't break existing Home Assistant entities

Users have automations, dashboards and months of history attached to their
entities. A change is breaking if it alters any of:

- an entity's `unique_id`
- the discovery topic (`<prefix>/<domain>/<object_id>/config`)
- the entity domain (moving something from `switch.` to `valve.` gives every
  user a brand new entity ID and orphans the old one)

Renaming what a user *sees* is fine. Changing what identifies an entity is
not, unless it is a deliberate, announced breaking change with a migration
path.

### Keep all 36 locales in sync

Entity names shown in Home Assistant come from
`diivoo2mqtt/backend/locales/*.json` and adapt to the user's HA language. If
you add an entity, add its key to **every** locale file — English-only strings
in a user-visible name are a regression for most of the user base. Never
hardcode a display string in `mqttBridge.js`.

### Respect the radio protocol limits

- A radio frame is **32 bytes total**, including the 12-byte header. Payloads
  that overflow are rejected at runtime.
- Durations are transmitted as **unsigned 16-bit seconds** — clamp to 65535.
- Anything sent to a valve goes through the per-gateway `RadioJobQueue`. Don't
  bypass it; valves wake for well under a millisecond at a time and
  overlapping transmissions lose packets.

### Think about persistence and migration

`devices.json` and `gateways.json` survive add-on updates and are the only
thing standing between a user and re-pairing all their hardware. If you change
their shape, keep reading the old shape working and add a test for it.

### Housekeeping

- No credentials, tokens, local config files, logs or build output.
- No generated planning documents or third-party copyright headers in new
  source or test files. Code you contribute has to be yours to give.

## Testing on real hardware

A lot of this project cannot be verified by unit tests alone — radio timing,
pairing, OTA and gateway recovery only really show up on physical hardware. If
your change touches any of those, say in the PR what you tested and on which
valve models.

If you cannot test it, say that too. That is genuinely useful information, and
changes get validated through the `nightly` add-on before they reach `main`
anyway.

## Commits

Conventional-commit prefixes, written in English:

```
feat: add per-channel display names
fix: serialize device configuration refreshes
chore: prepare 0.1.60 release
```

One logical change per commit where you can manage it — it makes bisecting a
radio timing regression enormously easier.

## How review works here

Pull requests get **merged and then refined**, rather than closed and
reimplemented. If your PR is sound in substance but needs adjustments, the
usual path is that it gets merged into `develop` and the follow-up work lands
as separate commits on top, referencing your PR. Your commits stay in the
history under your name.

If something genuinely cannot be merged as-is, you will get a reason and,
where there is one, a concrete alternative — not silence.

Contributors are credited by name in `diivoo2mqtt/CHANGELOG.md` for the
release their work ships in.

## Reporting bugs and protocol findings

Protocol observations are as welcome as code. `debug_tools/` contains a serial
tap for the original DIIVOO gateway that lets you watch the official app talk
to the valves — packet captures from unknown valve models are especially
valuable.

For bug reports, the add-on log plus your valve model and gateway firmware
version (visible in the web UI) is usually enough to get started.

## License

This project is licensed under the **GNU Affero General Public License v3.0**.
By contributing you agree that your contribution is licensed under the same
terms.
