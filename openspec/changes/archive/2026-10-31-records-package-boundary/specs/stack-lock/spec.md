## ADDED Requirements

### Requirement: Relocated records retains canonical build version

The emitted records package public entry SHALL import successfully from outside the repository when its declared runtime dependencies are provided. Runtime module linking and capture SHALL NOT require the repository-root package.json outside that package. Captured harness.version SHALL equal the canonical harness root manifest version at build time, not a relocated package manifest or caller workspace version. The capture API and persisted StackLock shape SHALL remain unchanged.

#### Scenario: External package import and capture
- **WHEN** emitted records files and its package manifest are physically copied outside the checkout, core dependency is explicitly provided, and a fresh Node process imports the public entry from an external cwd
- **THEN** module linking succeeds without an ancestor repository manifest and capture produces a valid persisted StackLock with the canonical build-time harness version
- **AND** unrelated package/cwd version values do not change that captured version

#### Scenario: Clean and repeated builds capture the root version
- **WHEN** the normal records build runs without prior emitted output, or runs again after the canonical root version changes
- **THEN** the package-local version artifact is created or refreshed from that root before compilation, without introducing a manually maintained second version source or runtime fallback
