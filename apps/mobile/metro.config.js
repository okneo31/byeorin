const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro config tuned for pnpm workspaces.
 *
 * pnpm uses a non-hoisted node_modules layout, so Metro's default upward lookup
 * does not find workspace siblings (e.g. `@byeorin/wallet-sdk`). We:
 *   1. Watch the monorepo root so file changes in `packages/*` trigger reloads.
 *   2. Tell Metro exactly where the two node_modules trees live (app + root).
 *   3. Disable hierarchical lookup so resolution is deterministic.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const defaultConfig = getDefaultConfig(projectRoot);

/** @type {import('@react-native/metro-config').MetroConfig} */
const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    disableHierarchicalLookup: true,
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
  },
};

module.exports = mergeConfig(defaultConfig, config);
