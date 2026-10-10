# v1 deprecation notice (draft)

Status: **draft — not published.** This notice is written to be published at
the v2 cutover release, and the timeline below cannot start until the G6 gate
is signed. Nothing here changes what v1 does today.

## Summary

Lore v2 replaces the Node CLI and hook runtime with a Rust daemon while
keeping the same five clients and the same local-only, no-telemetry
guarantees. When v2 is released as the default, v1 enters a deprecation
window rather than being removed outright.

## Timeline

| Phase | State | What it means |
| --- | --- | --- |
| Now | v1 default, v2 opt-in | Nothing changes for v1 users. v2 is available for pilots. |
| Cutover release | v2 default for new installs | v1 keeps working; a migration guide is published alongside. |
| +1 major release | v1 maintenance only | v1 receives security fixes; no new features. |
| +2 major releases | v1 retired from installers | Existing v1 installs keep running until the user migrates. |

The window is measured in releases, not dates, because the G6 gate is gated
on the cohort soak completing.

## What you will need to do

1. Keep running v1 if you want to. v1 is not removed from your machine, its
   store is never touched by v2, and clients continue to work until you
   switch them.
2. When you are ready, follow [migration-guide.md](migration-guide.md):
   preview, apply, verify, then cut clients over.
3. After the soak window, remove the v1 integration files with the v1
   installer or `lore setup --remove --apply` (v2 removes only files it
   owns).

## Guarantees

- **No implicit migration.** v2 never reads or rewrites a v1 store on its own.
- **No data loss on migration.** The v1 source is opened read-only through a
  SQLite snapshot; exclusions are itemised with reasons in the preview.
- **Forward-only.** There is no supported v2 → v1 downgrade after v2 writes.
  The v1 store stays intact, so a rollback means returning clients to v1, not
  converting data back.
- **No telemetry.** v2 adds no network calls. The only optional outbound
  traffic is the provider surface you configure explicitly (embeddings,
  optional analysis), and it is off by default.
- **No forced deletion.** Retiring v1 from installers does not delete
  personal stores, configs or backups.

## What is removed at retirement

- new v1 installs and upgrades through the npm installer;
- v1 hook wiring for new installs;
- v1-era documentation (superseded by the v2 guides).

Existing v1 installs keep working, and the last v1 release stays tagged and
downloadable with restore instructions.

## Communication plan

1. Publish this notice and the migration guide with the cutover release notes.
2. Add a deprecation warning to the v1 installer (a notice, not a block).
3. Document the exact release in which v1 leaves the installers, one release
   ahead of time.
