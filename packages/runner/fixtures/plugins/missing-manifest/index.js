export default function missingManifestFixture() {
  if (process.env.FIXTURE_ACTIVATION_PATH) {
    throw new Error('a bundle-less fixture must never be composed');
  }
}
