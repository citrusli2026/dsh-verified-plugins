import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export default function unloadResidueFixture() {
  const residue = process.env.FIXTURE_RESIDUE_PATH;
  if (!residue) return;
  mkdirSync(dirname(residue), { recursive: true });
  writeFileSync(residue, 'unload residue fixture left this file intentionally\n');
}
