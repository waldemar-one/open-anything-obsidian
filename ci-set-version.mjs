import { readFileSync, writeFileSync } from "fs";

// Used only in CI (see .github/workflows/release.yml). Whatever tag triggered
// the workflow becomes the manifest version, automatically, every time.
// This exists because manual syncing (remembering to bump manifest.json
// before tagging) kept slipping. Now it can't.
const tag = process.argv[2];
if (!tag) {
	console.error("Usage: node scripts/ci-set-version.mjs <tag>");
	process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const minAppVersion = manifest.minAppVersion;
manifest.version = tag;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[tag] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

console.log(`manifest.json version set to ${tag} (minAppVersion ${minAppVersion})`);
