import { writeFileSync } from 'node:fs';

if (process.env.FIXTURE_BUILD_MARKER) {
  writeFileSync(process.env.FIXTURE_BUILD_MARKER, 'postinstall executed\n');
}
