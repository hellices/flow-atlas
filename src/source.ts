import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import picomatch from "picomatch";

/** Files of a repository at one position: the working tree or a commit read without checking it out. */
export interface Source {
  readonly ref: string;
  list(): string[];
  read(path: string): string | undefined;
  /** When the content read was current: the commit's time for a commit, the present for the working tree. */
  asOf(): string;
}

const isoSeconds = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export function matcher(globs: string[]): (path: string) => boolean {
  if (globs.length === 0) return () => false;
  return picomatch(globs, { dot: true });
}

function isGitRepo(root: string): boolean {
  const result = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === "true";
}

export class WorktreeSource implements Source {
  readonly ref = "WORKTREE";
  private files: string[] | undefined;
  constructor(private readonly root: string) {}

  asOf(): string {
    return isoSeconds(new Date());
  }

  list(): string[] {
    if (this.files) return this.files;
    if (isGitRepo(this.root)) {
      const out = execFileSync("git", ["-C", this.root, "ls-files", "-co", "--exclude-standard", "-z"], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
      this.files = out.split("\0").filter(Boolean);
    } else {
      this.files = walk(this.root, this.root);
    }
    return this.files;
  }

  read(path: string): string | undefined {
    try {
      return readFileSync(join(this.root, path), "utf8");
    } catch {
      return undefined;
    }
  }
}

function walk(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(root, full));
    else out.push(relative(root, full));
  }
  return out;
}

/** Reads a commit through `git ls-tree` and `git cat-file --batch`; the working tree and index are never touched. */
export class GitRefSource implements Source {
  private files: string[] | undefined;
  private readonly cache = new Map<string, string | undefined>();
  constructor(
    private readonly root: string,
    readonly ref: string,
  ) {}

  asOf(): string {
    const out = execFileSync("git", ["-C", this.root, "show", "-s", "--format=%cI", this.ref], { encoding: "utf8" }).trim();
    return isoSeconds(new Date(out));
  }

  list(): string[] {
    if (this.files) return this.files;
    const out = execFileSync("git", ["-C", this.root, "ls-tree", "-r", "-z", "--name-only", this.ref], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    this.files = out.split("\0").filter(Boolean);
    return this.files;
  }

  /** Loads many files in one `git cat-file --batch` process. */
  preload(paths: string[]): void {
    const wanted = paths.filter((p) => !this.cache.has(p));
    if (wanted.length === 0) return;
    const input = wanted.map((p) => `${this.ref}:${p}\n`).join("");
    const result = spawnSync("git", ["-C", this.root, "cat-file", "--batch"], {
      input,
      maxBuffer: 1024 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`git cat-file failed: ${result.stderr.toString()}`);
    const buf = result.stdout;
    let offset = 0;
    for (const path of wanted) {
      const headerEnd = buf.indexOf(10, offset);
      const header = buf.subarray(offset, headerEnd).toString();
      offset = headerEnd + 1;
      if (header.endsWith(" missing")) {
        this.cache.set(path, undefined);
        continue;
      }
      const size = Number(header.split(" ")[2]);
      this.cache.set(path, buf.subarray(offset, offset + size).toString("utf8"));
      offset += size + 1;
    }
  }

  read(path: string): string | undefined {
    if (!this.cache.has(path)) this.preload([path]);
    return this.cache.get(path);
  }
}

export function openSource(root: string, ref: string | undefined): Source {
  if (!ref || ref === "WORKTREE") return new WorktreeSource(root);
  const resolved = execFileSync("git", ["-C", root, "rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" }).trim();
  return new GitRefSource(root, resolved);
}

/** Files under the globs, minus the excluded ones, loaded in one batch when reading a commit. */
export function select(source: Source, globs: string[], exclude: string[]): string[] {
  const include = matcher(globs);
  const skip = matcher(exclude);
  const files = source.list().filter((f) => include(f) && !skip(f));
  if (source instanceof GitRefSource) source.preload(files);
  return files;
}

export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
