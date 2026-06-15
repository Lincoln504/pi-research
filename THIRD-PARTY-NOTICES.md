# Third-Party Notices

`@lincoln504/pi-research` is licensed under the MIT License (see `LICENSE`). That
license covers this project's own source code only.

This package depends on third-party software distributed under its own license
terms. Dependencies are resolved and installed by npm at install time (by
reference); they are **not** bundled into this package's published artifacts
(`dist/*` is built with esbuild `--packages=external`, so no third-party code is
inlined).

## Notable dependency licensing

### camoufox-js / Camoufox browser

`camoufox-js` is used in-process only to configure and launch the Camoufox
(Firefox-fork) browser **binary as a separate operating-system process**, which
this package then drives over the Playwright/CDP protocol. The Camoufox binary is
downloaded and run separately and is subject to its own license.

### ua-parser-js

`ua-parser-js` 2.x is licensed under AGPL-3.0-or-later. To keep this MIT-licensed
package free of AGPL-licensed code in its dependency tree, `package.json`
`overrides` pins `ua-parser-js` to the `1.x` line, which is MIT-licensed. The
1.x and 2.x APIs are compatible for the only surface our transitive dependency
(`camoufox-js`) uses, and the pin is behavior-neutral for this package's usage
(no custom `navigator.userAgent`/`fingerprint` is passed to Camoufox).

## Verifying the dependency tree

```
npm ls ua-parser-js   # expect ua-parser-js@1.x (overridden, MIT)
```

For a full license inventory of installed dependencies, run a license scanner of
your choice (e.g. `npx license-checker --summary`) against your installed
`node_modules`.
