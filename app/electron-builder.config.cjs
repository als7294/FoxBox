// electron-builder config (used by scripts/package.mjs). `--mac dir` → release/mac-arm64/FoxBox.app
/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.smittytech.foxbox',
  productName: 'FoxBox',
  copyright: 'GUY FVWKS',
  directories: { output: 'release', buildResources: 'build-resources' },
  // Everything is bundled by electron-vite; no runtime node_modules ship.
  files: ['out/**', 'package.json', '!out/**/*.map'],
  asar: true,
  npmRebuild: false,
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  },
  mac: {
    target: [{ target: 'dir', arch: ['arm64'] }],
    category: 'public.app-category.music',
    // The FoxBox app icon (design/brand/foxbox-icon-1024.png, built into an .icns with iconutil).
    icon: 'build-resources/icon.icns',
    // Ad-hoc signature (no Developer ID). Hardened runtime would reject Electron's pre-signed frameworks.
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
    darkModeSupport: true,
    extendInfo: {
      NSMicrophoneUsageDescription:
        'FoxBox records your voice so it can be masked. The audio stays on this Mac.',
      // The engine's wheels (mlx, mlx-metal, numpy, scipy) are macosx_14_0_arm64: macOS 14 on Apple silicon only.
      LSMinimumSystemVersion: '14.0',
    },
  },
}
