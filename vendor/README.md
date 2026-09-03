# Vendored `shimmer-web-sdk`

The build output of [`shimmer-web-sdk`](https://github.com/ShimmerResearch/shimmer-web-sdk),
checked in so the GitHub Pages site works with no build step. Every page in this
repository and every module under `common/` imports the SDK from here:

```js
import { Shimmer3RClient } from "../vendor/shimmer-web-sdk.esm.js";
```

Seven artifacts, copied byte for byte from the SDK's `dist/`:
`shimmer-web-sdk.{esm.js,esm.js.map,cjs,cjs.map,umd.js,umd.js.map,d.ts}`.
Pages load the ESM bundle; the others are kept so the set matches a release and
a source map resolves when someone opens the devtools on a live page.

## There is a second copy, on purpose

`shimmer-extension/vendor/` holds the same seven files. That folder is a
packaged Chrome extension: only its own contents are zipped for the store, and
`manifest.json` declares `vendor/shimmer-web-sdk.esm.js` as a web-accessible
resource, so it cannot import a copy that lives outside itself. A symlink would
not survive packing either.

So the rule is: **the extension owns its copy, everything else shares this one**,
and `sync-local-sdk.ps1` writes both. Writing only one leaves the extension
shipping a different SDK from the pages next to it, which is the failure this
note exists to prevent.

## Updating

From the repository root, with a local SDK checkout beside it:

```powershell
powershell -ExecutionPolicy Bypass -File .\update-local-sdk.ps1 -SdkRepoPath "C:\path\to\shimmer-web-sdk"
```

`sdk-source.json` selects which SDK source is built or copied. Do not edit these
files by hand and do not run prettier over them — they are upstream output, and
`.prettierignore` covers the directory for that reason.
