# Shimmer Capture has moved

Shimmer Capture now has its own repository:

- **Source:** [ShimmerResearch/shimmer-capture-web](https://github.com/ShimmerResearch/shimmer-capture-web)
- **Live:** [shimmerresearch.github.io/shimmer-capture-web](https://shimmerresearch.github.io/shimmer-capture-web/)

`index.html` beside this file is a redirect stub, not the page. It is here so
that every link published while Shimmer Capture lived at
`…/webBLEDemos/ShimmerCapture/` keeps working, and so search engines learn the
new URL from its `rel="canonical"`. Leave it in place.

## What went with it

The page, its README, and `common/` — the shared UI library it was built on.
`common/` moved rather than being copied because by the time of the split
nothing else in this repository imported it: the other demos each carry their
own UI, and only Shimmer Capture ever loaded `common/theme.css`. The
`verify.yml` workflow went too; it only ever ran the Shimmer Capture pass.

What stayed: every other demo, the Chrome extension, and the shared
`vendor/` copy of the SDK that eighteen pages here still import. The new
repository vendors its own copy from the same build, so
`C:\dev\web\sync-all-vendors.ps1` now has a third consumer to keep in step.

A change to `common/` no longer reaches anything in this repository, and a
change here no longer reaches Shimmer Capture.
