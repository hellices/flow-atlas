// Points git at the hooks committed under .githooks, so every clone runs the same checks. Run by `prepare`; outside a
// git working tree (an installed package) it does nothing.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".git") && existsSync(".githooks")) {
  try {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  } catch (error) {
    // Without git there are no hooks to run either; any other failure leaves the hooks off, so it is not hidden.
    if (error?.code !== "ENOENT") throw error;
  }
}
