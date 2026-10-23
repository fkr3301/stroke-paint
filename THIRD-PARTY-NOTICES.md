# Third-party notices

This project bundles the following third-party code. It is not covered by this
project's MIT license; the original license applies.

## vendor/jpeg-js

- Source: https://github.com/jpeg-js/jpeg-js
- Copyright (c) 2014, Eugene Ware
- License: MIT — full text in [`vendor/jpeg-js/LICENSE`](vendor/jpeg-js/LICENSE)

Used by `scripts/paint.js` (Node) to decode JPEG input and to re-encode the small
thumbnail that the player embeds. The browser build (`studio.html`) does not use it:
it decodes with the browser's own `createImageBitmap` and encodes via `<canvas>`.

## Sample image

`examples/sample.jpg` is generated procedurally by `examples/make-sample.py` — no
third-party artwork is included in this repository.
