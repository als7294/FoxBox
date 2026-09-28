// electron-builder config (used by scripts/package.mjs): release/mac-arm64/FoxBox.app, and with --dmg
// release/FoxBox-<version>-arm64.dmg (the note in build-resources/ rides along in the disk image).
const { join } = require('node:path')

const electronFuses = {
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
}

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
  electronFuses,
  // Component updates (1.2): record each part's hash in Contents/Resources/components.json before signing
  // (src/main/components.ts). The fuses are applied after this hook, so they go into the electron part's hash.
  afterPack: async (context) => {
    const { hashComponents, writeComponentsFile } = await import('./src/main/components.ts')
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    const electron = require('electron/package.json').version
    const hashes = hashComponents(app, { electron: JSON.stringify({ electron, electronFuses }) })
    writeComponentsFile(app, hashes)
    console.log(`  • components  ${Object.entries(hashes).map(([n, h]) => `${n}=${h.slice(0, 12)}`).join('  ')}`)
  },
  mac: {
    target: [{ target: 'dir', arch: ['arm64'] }],
    artifactName: '${productName}-${version}-${arch}.${ext}',
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
      NSAudioCaptureUsageDescription:
        "FoxBox listens to your DJ software's output (system audio) to drive the visuals. Nothing is recorded or sent anywhere.",
      NSCameraUsageDescription:
        'FoxBox uses the camera for camera clips. Faces are pixelated on this Mac, and the video never leaves it unless you share it.',
      // The engine's wheels (mlx, mlx-metal, numpy, scipy) are macosx_14_0_arm64: macOS 14 on Apple silicon only.
      LSMinimumSystemVersion: '14.0',
    },
  },
  // The branded install window (design/brand/dmg-background*.png as one HiDPI TIFF, built with tiffutil): the app and
  // the Applications link sit on the art's dashed slots; the first-open steps are printed on it, so the note file
  // sits below the visible window for anyone who scrolls.
  dmg: {
    title: '${productName} ${version}',
    icon: 'build-resources/icon.icns',
    background: 'build-resources/dmg-background.tiff',
    window: { width: 660, height: 420 },
    iconSize: 128,
    contents: [
      { x: 180, y: 205, type: 'file' },
      { x: 480, y: 205, type: 'link', path: '/Applications' },
      { x: 330, y: 560, type: 'file', path: join(__dirname, 'build-resources', 'Open FoxBox.txt') },
    ],
  },
}
