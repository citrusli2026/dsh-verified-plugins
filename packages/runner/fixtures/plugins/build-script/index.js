import { writeFileSync } from 'node:fs';

export default function buildScriptFixture() {
  if (process.env.FIXTURE_ACTIVATION_PATH) {
    writeFileSync(process.env.FIXTURE_ACTIVATION_PATH, 'build-script fixture activated\n');
  }
}
