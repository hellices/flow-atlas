#!/usr/bin/env node
// Git clean filter for pnpm-lock.yaml: drops the tarball URL a registry mirror writes beside each package's integrity,
// so the committed lockfile resolves against whatever registry the reader configures. Integrity is kept, so installs
// still verify every package. Enable it in a clone with:
//   git config filter.public-registry.clean "node scripts/public-registry.mjs"
//   git config filter.public-registry.smudge cat
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  // Only registry-shaped tarballs (.../-/<name>-<version>.tgz); a git or URL dependency keeps its tarball.
  process.stdout.write(input.replace(/, tarball: https?:\/\/[^\s,}]+\/-\/[^\s,}/]+\.tgz(?=\})/g, ""));
});
