const insideWorkTree = Bun.spawnSync({
  cmd: ["git", "rev-parse", "--is-inside-work-tree"],
  stdout: "ignore",
  stderr: "ignore",
});

if (insideWorkTree.exitCode === 0) {
  const status = Bun.spawnSync({
    cmd: ["git", "status", "--porcelain=v1", "--untracked-files=all"],
    stdout: "pipe",
    stderr: "inherit",
  });

  if (status.exitCode !== 0) {
    throw new Error("Could not inspect git status before production mutation");
  }

  const dirtyStatus = new TextDecoder().decode(status.stdout).trim();
  if (dirtyStatus) {
    throw new Error(
      "Refusing production mutation from a dirty git tree. Commit the reviewed tree first.",
    );
  }
}

console.log("Git release guard passed.");

export {};
