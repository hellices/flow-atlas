#!/usr/bin/env node
// Git clean filter for pnpm-lock.yaml: drops the tarball URL a registry mirror writes beside each package's integrity,
// so the committed lockfile resolves against whatever registry the reader configures. Integrity is kept, so installs
// still verify every package. Enable it in a clone with:
//   git config filter.public-registry.clean "node scripts/public-registry.mjs"
//   git config filter.public-registry.smudge cat
import { pathToFileURL } from "node:url";

const TARBALL = /, tarball: https?:\/\/[^\s,}]+\.tgz(?=\})/;

/** A packages-section key resolved from a registry: `name@1.2.3` or `@scope/name@1.2.3(peer@x)`, not a URL or git spec. */
function fromRegistry(key) {
  const at = key.indexOf("@", 1);
  return at > 0 && /^\d+\.\d+\.\d+/.test(key.slice(at + 1));
}

/** The lockfile with the tarball dropped from registry packages only; a URL, git or file dependency keeps its tarball. */
export function stripRegistryTarballs(text) {
  let section = "";
  let key = "";
  return text
    .split("\n")
    .map((line) => {
      const top = /^([^\s#][^:]*):/.exec(line);
      if (top) {
        section = top[1];
        key = "";
        return line;
      }
      const entry = /^ {2}(['"]?)(.+?)\1:\s*$/.exec(line);
      if (entry) {
        key = entry[2];
        return line;
      }
      return section === "packages" && fromRegistry(key) ? line.replace(TARBALL, "") : line;
    })
    .join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => process.stdout.write(stripRegistryTarballs(input)));
}
