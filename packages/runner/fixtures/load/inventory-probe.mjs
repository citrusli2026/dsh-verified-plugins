import { writeFileSync } from 'node:fs';

// This first-party fixture observes DSH's public plugin-manager projection
// after the Loader has settled. It never changes the subject's entries.
export default function inventoryProbe(ctx) {
  setTimeout(() => {
    void (async () => {
      const manager = ctx.root.get('pluginManager');
      if (!manager) throw new Error('pluginManager service unavailable');
      await ctx.root.loader.await();
      const [bundles, plugins] = await Promise.all([manager.listBundles(), manager.listPlugins()]);
      const bundle = bundles.find((row) => row.name === process.env.DSH_VERIFY_SUBJECT);
      const entries = new Map(plugins.map((entry) => [entry.entryId, entry]));
      const snapshot = bundle ? {
        found: true, enabled: bundle.enabled, error: bundle.error?.code ?? null,
        overrides: bundle.overrides,
        rows: bundle.rows.map((row) => {
          const live = row.entryId ? entries.get(row.entryId) : undefined;
          return {
            rowId: row.rowId, entryId: row.entryId ?? null,
            enabled: live?.enabled ?? false, fiberPhase: live?.fiberPhase ?? null,
          };
        }),
      } : { found: false, enabled: false, error: null, overrides: [], rows: [] };
      writeFileSync(process.env.DSH_VERIFY_L2_OUT, JSON.stringify(snapshot));
    })().catch((error) => {
      writeFileSync(process.env.DSH_VERIFY_L2_OUT, JSON.stringify({ error: String(error), rows: [] }));
    });
  }, 0);
}
