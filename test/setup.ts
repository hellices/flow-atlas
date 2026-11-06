/**
 * The tests make their own repositories and name them with `git -C`. A variable that names a repository for git, as
 * git sets for a hook run in a linked worktree, would win over `-C` and point those commands at the repository being
 * pushed, so none reaches a test.
 */
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX"]) {
  delete process.env[name];
}
