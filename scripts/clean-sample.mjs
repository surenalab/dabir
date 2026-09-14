// Remove the sample paper's caches before a build. `examples/score-anchor` is bundled as a resource, folder
// by folder, so a compile output, an agent worktree or a search index left there by opening the sample in a
// dev build would otherwise ship inside the app. All three are gitignored and rebuilt on demand.
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join("examples", "score-anchor", ".dabir");
for (const d of ["build", "worktrees", "index"]) {
  const p = join(root, d);
  if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); console.log(`removed ${p}`); }
}
