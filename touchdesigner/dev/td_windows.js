// On-screen windows of one app by owner (no pixels, no titles: no Screen Recording permission). JXA:
//   osascript -l JavaScript touchdesigner/dev/td_windows.js TouchDesigner
ObjC.import('CoreGraphics')
function run(argv) {
  const owner = argv[0] || 'TouchDesigner'
  const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)))
  const mine = all.filter((w) => w.kCGWindowOwnerName === owner)
  return JSON.stringify({
    total: mine.length,
    onScreen: mine.filter((w) => w.kCGWindowIsOnscreen).map((w) => ({ pid: w.kCGWindowOwnerPID, layer: w.kCGWindowLayer, alpha: w.kCGWindowAlpha, b: w.kCGWindowBounds })),
  })
}
