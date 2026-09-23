# Versioning

`pubspec.yaml` holds the single source of truth:

```yaml
version: MAJOR.MINOR.PATCH+BUILD      # currently 1.0.0+1
```

| Part | Becomes | Increase when |
|---|---|---|
| `MAJOR` | Android `versionName`, iOS `CFBundleShortVersionString` | Breaking change for users or data (rare) |
| `MINOR` | same | A phase or feature release (e.g. Phase 2 → `1.1.0`) |
| `PATCH` | same | Bug fixes only |
| `BUILD` | Android `versionCode`, iOS `CFBundleVersion` | **Every** upload to Play or App Store, including test builds |

Rules:

- `BUILD` only ever goes up, and is never reused, even if a build is rejected. Play and App Store reject
  duplicates.
- Keep one `BUILD` sequence for both stores.
- The dev flavor appends `-dev` to Android `versionName` automatically.
- Tag releases in git: `git tag v1.1.0+7`.

Examples: `1.0.0+1` → hotfix `1.0.1+2` → Phase 2 `1.1.0+3` → test rebuild `1.1.0+4`.

A build can be overridden without editing pubspec (for CI):
`flutter build appbundle --build-name=1.1.0 --build-number=42 ...`.
