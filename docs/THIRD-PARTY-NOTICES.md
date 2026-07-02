## Third-Party Notices

`@lincoln504/pi-research` is licensed under the MIT License (see `LICENSE`). That
license covers this project's own source code only.

This package depends on third-party software distributed under its own license
terms. Dependencies are resolved and installed by npm at install time (by
reference); they are **not** bundled into this package's published artifacts
(`dist/*` is built with esbuild `--packages=external`, so no third-party code is
inlined).

### Notable dependency licensing

camoufox-js / Camoufox browser

The `camoufox-js` npm package itself is licensed under **MPL-2.0** (file-level
copyleft). It is resolved at install time and **not bundled** into this package's
artifacts (`dist/*` is built `--packages=external`), so no MPL-covered source is
combined into or redistributed by this MIT package. It is used in-process only to
configure and launch the Camoufox (Firefox-fork) browser **binary as a separate
operating-system process**, which this package then drives over the Playwright/CDP
protocol. The Camoufox binary is downloaded and run separately and is subject to its
own license.

ua-parser-js

`ua-parser-js` 2.x is licensed under AGPL-3.0-or-later. To keep this MIT-licensed
package free of AGPL-licensed code in its dependency tree, `package.json`
`overrides` pins `ua-parser-js` to the `1.x` line, which is MIT-licensed. The
1.x and 2.x APIs are compatible for the only surface our transitive dependency
(`camoufox-js`) uses, and the pin is behavior-neutral for this package's usage
(no custom `navigator.userAgent`/`fingerprint` is passed to Camoufox).

youtubei.js / bgutils-js / jsdom (YouTube transcripts)

The `youtube_transcript` tool depends on `youtubei.js` (MIT), `bgutils-js` (MIT),
and `jsdom` (MIT). All three are standard MIT and are resolved at install time,
not bundled. `youtubei.js` and `bgutils-js` interact with YouTube's **unofficial**
InnerTube API and BotGuard attestation to fetch publicly available captions
without an API key; no credentials are used and only caption text is read.
Operators are responsible for ensuring their use complies with YouTube's Terms of
Service. `jsdom` provides the DOM environment the BotGuard VM requires; it is
loaded lazily (only when the tool runs) and never at startup.

sharp / @img/sharp-libvips (via @huggingface/transformers)

`@huggingface/transformers` pulls in `sharp` (Apache-2.0) for image decoding, which
in turn installs prebuilt `@img/sharp-libvips-*` native packages licensed under
**LGPL-3.0-or-later**. These are platform-specific shared libraries linked
**dynamically** at runtime and resolved at install time; no LGPL code is statically
linked into or bundled with this package (`dist/*` is built `--packages=external`).
Dynamic linkage of an unmodified LGPL library from an MIT-licensed program is
permitted by the LGPL. The image path is only exercised by the embedding/knowledge
stack; text-only research does not load it.

### Verifying the dependency tree

```
npm ls ua-parser-js   # expect ua-parser-js@1.x (overridden, MIT)
```

For a full license inventory of installed dependencies, run a license scanner of
your choice (e.g. `npx license-checker --summary`) against your installed
`node_modules`.
