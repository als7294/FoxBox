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
  // Everything is bundled by electron-vite (main and preload import only node: and electron); no runtime node_modules
  // ship. electron-builder adds `dependencies` on its own, so they're excluded explicitly (app.asar 113 → 33 MB).
  files: ['out/**', 'package.json', '!out/**/*.map', '!**/node_modules/**'],
  asar: true,
  npmRebuild: false,
  electronFuses,
  // Component updates (1.2): record each part's hash in Contents/Resources/components.json before signing
  // (src/main/components.ts). The fuses are applied after this hook, so they go into the electron part's hash.
  afterPack: async (context) => {
    if (context.electronPlatformName !== 'darwin') return // the parts are the Mac's .app layout (W1: Windows uses NSIS + blockmap)
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
    // The FoxBox Strings icon (the user's pick, S3's design/brand/icons/*/foxbox-strings-a-*.png, built into an .icns with iconutil).
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
      // An iPhone as a Continuity Camera webcam is listed (and macOS stops logging that the key is missing).
      NSCameraUseContinuityCameraDeviceType: true,
      // 2.1: Ableton Link finds Live and other Link apps on the local network (asked once, when Link is turned on).
      NSLocalNetworkUsageDescription: 'FoxBox uses your local network for Ableton Link, to keep its tempo in sync with Live and other Link apps.',
      // The engine's wheels (mlx, mlx-metal, numpy, scipy) are macosx_14_0_arm64: macOS 14 on Apple silicon only.
      LSMinimumSystemVersion: '14.0',
    },
  },
  // W1, the Windows beta (SAUCE only): an x64 NSIS installer, per user, no admin; electron-updater reads latest.yml and
  // the blockmap from the GitHub release (so an asar-only change is a small delta). Unsigned for now (the user's call).
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build-resources/icon.png',
    artifactName: '${productName}-Setup-${version}-${arch}.${ext}',
    publish: [{ provider: 'github', owner: 'als7294', repo: 'FoxBox', releaseType: 'release' }],
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    differentialPackage: true,
    shortcutName: 'FoxBox',
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
