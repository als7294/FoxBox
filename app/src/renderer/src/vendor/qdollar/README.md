# $Q recognizer (vendored)

`qdollar.mjs` is the JavaScript version of the $Q Super-Quick Recognizer by Nathan Magrofuoco, from Radu-Daniel
Vatavu, Lisa Anthony and Jacob O. Wobbrock's $Q (MobileHCI '18), downloaded unchanged from
https://depts.washington.edu/acelab/proj/dollar/qdollar.js (sha256 7ac7b71c7bccfab9…), New BSD
License (in the file's header). The one change: two lines at the end exporting `Point` and `QDollarRecognizer` as an ES
module, since FoxBox's renderer forbids eval and can't run it as a plain script. FoxBox uses it in
`components/camera/drawnShapes.ts` (AIR DRAW's shapes).
