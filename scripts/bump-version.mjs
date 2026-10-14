// Sets the app version everywhere it's written down:
//   npm run bump 0.3.0
//   npm run bump -- --check    (CI: fails if the files disagree)
// Merging a version bump into main makes CI publish a GitHub release, which
// the app's Update button offers to everyone on an older version.
import { readFileSync, writeFileSync } from "node:fs";

if (process.argv[2] === "--check") {
  const found = {
    "package.json": JSON.parse(readFileSync("package.json", "utf8")).version,
    "package-lock.json": JSON.parse(readFileSync("package-lock.json", "utf8")).packages[""].version,
    "src-tauri/tauri.conf.json": JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version,
    "src-tauri/Cargo.toml": readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version = "(.*)"$/m)?.[1],
    "src-tauri/Cargo.lock": readFileSync("src-tauri/Cargo.lock", "utf8").match(/name = "tonefield"\nversion = "(.*)"/)?.[1],
    "packaging/arch/PKGBUILD": readFileSync("packaging/arch/PKGBUILD", "utf8").match(/^pkgver=(.*)$/m)?.[1],
  };
  const versions = new Set(Object.values(found));
  if (versions.size !== 1) {
    console.error("The version isn't the same everywhere; run npm run bump <version>.", found);
    process.exit(1);
  }
  console.log(`Version ${[...versions][0]} everywhere`);
  process.exit(0);
}

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: npm run bump <major.minor.patch>");
  process.exit(1);
}

const edit = (path, change) => {
  const before = readFileSync(path, "utf8");
  const after = change(before);
  if (!after.includes(version)) throw new Error(`No version found in ${path}`);
  writeFileSync(path, after);
};

// The first "version" in each JSON file is the app's own (in package-lock.json
// the root's, then the root package entry's), edited in place to keep the layout
const jsonVersion = (s, count) => {
  let left = count;
  return s.replace(/"version": "[^"]*"/g, (m) => (left-- > 0 ? `"version": "${version}"` : m));
};
edit("package.json", (s) => jsonVersion(s, 1));
edit("package-lock.json", (s) => jsonVersion(s, 2));
edit("src-tauri/tauri.conf.json", (s) => jsonVersion(s, 1));
edit("src-tauri/Cargo.toml", (s) => s.replace(/^version = ".*"$/m, `version = "${version}"`));
edit("src-tauri/Cargo.lock", (s) => s.replace(/(name = "tonefield"\nversion = )".*"/, `$1"${version}"`));
// A new version starts its package release count again at 1
edit("packaging/arch/PKGBUILD", (s) => s.replace(/^pkgver=.*$/m, `pkgver=${version}`).replace(/^pkgrel=.*$/m, "pkgrel=1"));
console.log(`Version set to ${version}`);
