# Mellow for macOS

This is Mellow’s community release mirror. Download releases from
[mellow-bci/mellow-releases](https://github.com/mellow-bci/mellow-releases/releases).
Published releases also remain available in the original
[autonomy-cloud repository](https://github.com/autonomy-cloud/mellow-releases/releases).

GitHub Actions checks the original repository every 15 minutes (GitHub may delay
scheduled runs). It copies published release notes, beta/stable status, and all
assets, verifying each download and upload against the original SHA-256 digest.
It never rebuilds or re-signs an app, replaces existing assets, or removes releases.
Incomplete uploads remain drafts until verification succeeds. The original stable
“Latest” selection is preserved; newer beta builds appear as pre-releases.

The workflow uses only this repository’s scoped GitHub token. Apple credentials,
application source, and signing keys are not needed. Run it manually from
[Actions](https://github.com/mellow-bci/mellow-releases/actions/workflows/sync-upstream.yml)
to sync sooner or retry an interrupted transfer. Each run retains a verification
report for 30 days. Contract checks: `node --test scripts/tests/*.test.mjs`.

Existing public tags are immutable. The historical `1.0.6-beta.12` tag points to
an older documentation commit here; its exact original/community refs are recorded
in `scripts/legacy-community-tags.json`. Its release binaries must still match
the original SHA-256 digests. New tags copy the original refs exactly.

This repository hosts signed Mellow downloads and the app-update feed. Application source, debug symbols, account information, and signing keys are not published here.

## Downloads

Use the published release assets. Pre-releases are qualification builds and are not yet a recommendation for general installation.

Apps built before automatic updates were configured need one manual installation of an updater-enabled release. Later versions can be reviewed and installed through Mellow’s update prompt.

## Update feed

https://raw.githubusercontent.com/autonomy-cloud/mellow-releases/main/docs/appcast.xml

Updates are signed with Mellow’s dedicated Ed25519 key and macOS Developer ID. Versioned downloads are immutable; corrections receive a new version number.

The `docs/` feed is copied verbatim. Existing installed apps continue using the
original feed and signed download URLs; the mirror does not change update trust.
