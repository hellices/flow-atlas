// Points git at the hooks committed under .githooks, so every clone runs the same checks. Run by `prepare`; outside a
// git working tree (an installed package) it does nothing.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".git") && existsSync(".githooks")) {
  try {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  } catch {
    // git is not installed: there are no hooks to run either.
  }
}
