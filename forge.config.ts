import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

const config = {
  packagerConfig: {
    asar: true,
    executableName: "spire",
    ignore: (file: string) => {
      if (!file) return false;
      const runtimePaths = [
        "/.vite",
        "/node_modules",
        "/node_modules/better-sqlite3",
        "/node_modules/bindings",
        "/node_modules/file-uri-to-path",
      ];
      return !runtimePaths.some(
        (runtimePath) =>
          file === runtimePath ||
          (runtimePath !== "/node_modules" && file.startsWith(`${runtimePath}/`)),
      );
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerZIP({}, ["linux"]),
    new MakerDeb({
      options: {
        name: "spire",
        productName: "Spire",
        genericName: "Agent graph orchestrator",
        categories: ["Development"],
      },
    }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: "src/main/index.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload/index.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
