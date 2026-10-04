import { readdirSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default function recursiveWatcherFixture() {
  const marker = process.env.FIXTURE_ACTIVATION_PATH;
  if (marker) writeFileSync(marker, 'recursive watcher fixture activated\n');
  const root = process.env.FIXTURE_WATCH_ROOT;
  if (!root) return;
  for (const child of readdirSync(root)) watch(join(root, child), () => {});
}
