const path = require("path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

const root = path.resolve(__dirname, "../..");
const esc = (p) => p.replace(/[/\\^$.*+?()[\]{}|-]/g, "\\$&");
// Watch only what the app imports: its own folder, the shared types, and installed packages.
// Watching the whole repo made Metro crawl the hub, native build output and the Pods on every start.
module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [path.resolve(root, "packages/shared"), path.resolve(root, "node_modules")],
  resolver: {
    nodeModulesPaths: [path.resolve(__dirname, "node_modules"), path.resolve(root, "node_modules")],
    unstable_enableSymlinks: true,
    blockList: [
      new RegExp(`${esc(path.resolve(root, "packages/hub"))}/.*`),
      new RegExp(`${esc(__dirname)}/(macos|ios)/(build|Pods|DerivedData)/.*`),
      /\/node_modules\/.*\/(android|ios|macos)\/build\/.*/,
    ],
  },
  transformer: {
    // Load modules when they're first used instead of all at startup.
    getTransformOptions: async () => ({ transform: { experimentalImportSupport: false, inlineRequires: true } }),
  },
});
