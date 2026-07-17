import assert from "node:assert/strict"
import test from "node:test"

const {
  furnaceRelease,
  furnaceReleases,
  unacknowledgedFurnaceRelease,
  validateReleaseManifest,
} = await import("../dist/release-notes.js")
const { packageVersion } = await import("../dist/version.js")

test("release manifest is complete, unique, and newest-first", () => {
  const releases = furnaceReleases()
  assert.deepEqual(validateReleaseManifest(), [])
  assert.equal(releases.length, 29)
  assert.equal(releases.at(-1)?.version, "0.1.0")
  assert.equal(releases.some((release) => release.version === "0.1.23" && release.status === "tagged"), true)
})

test("current package version always has local release notes", () => {
  const release = furnaceRelease(packageVersion)
  assert.ok(release)
  assert.equal(release.version, "0.2.5")
  assert.ok(release.summary.length > 0)
  assert.ok(release.changes.length > 0)
})

test("What’s New is selected only for an unacknowledged installed version", () => {
  assert.equal(unacknowledgedFurnaceRelease("0.2.5", [])?.version, "0.2.5")
  assert.equal(unacknowledgedFurnaceRelease("0.2.5", ["0.2.5"]), undefined)
  assert.equal(unacknowledgedFurnaceRelease("9.9.9", []), undefined)
})
