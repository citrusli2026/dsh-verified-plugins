import { writeFileSync } from 'node:fs';

export default function normalFixture() {
  const marker = process.env.FIXTURE_ACTIVATION_PATH;
  if (marker) writeFileSync(marker, 'normal fixture activated\n');
}
