# `common/vendor/`

Third-party code vendored into this repo. This site is served straight off
GitHub Pages with no build step, so every dependency is a checked-in file —
there is no `npm install` to reproduce it and nothing resolves at runtime.

## `chart.umd.min.js`

|         |                                                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Library | [Chart.js](https://www.chartjs.org)                                                                                              |
| Version | **4.5.1** (pinned)                                                                                                               |
| Build   | UMD, minified — defines the global `Chart`                                                                                       |
| Licence | MIT (header retained at the top of the file)                                                                                     |
| Source  | `shimmer-extension/chart.min.js` in this repo, itself the upstream `chart.umd.min.js` from `chart.js@4.5.1`; byte-identical copy |

Load it before any module that uses it, so the global exists first:

```html
<script src="../common/vendor/chart.umd.min.js"></script>
<script type="module">
  import { createStreamPlot } from "../common/plot.js";
</script>
```

`common/plot.js` reads the global `Chart` rather than importing it, and it
does so lazily (inside `createStreamPlot`), so the module still imports
cleanly on a page that has not loaded the script.

### The pin is deliberate

`common/plot.js` depends on behaviour that is version-specific:

- `parsing: false` with `normalized: true` and pre-sorted `{x, y}` point
  arrays mutated in place — the fast path that makes a 512 Hz stream
  affordable;
- the built-in `decimation` plugin with `algorithm: "min-max"`, which is only
  applied to a dataset on a linear x scale with parsing disabled.

Do not swap in a CDN copy or bump the version without re-checking a
high-rate stream on real hardware for dropped points and rising frame times.
The version is stated in three places (this file, the file header, and
`common/README.md`); keep them in step.
