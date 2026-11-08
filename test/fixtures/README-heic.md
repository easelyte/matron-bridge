# heic-grid-10bit.heic

A synthetic HEIC laid out like an iPhone screenshot, used by
`test/inline-image.test.js`. sharp cannot write HEIC, so this file is
checked in.

- 1170x2532 pixels, four horizontal bands top to bottom: red, green, blue,
  white.
- 10-bit HEVC (Main 10), coded as a 3x5 grid of 512x512 tiles. The right-hand
  and bottom tiles are cropped to the image size.
- A 256px thumbnail image.

Made with libheif 1.20's `heif-enc` (x265 encoder) from 16-bit PNG tiles
named `tile-YY-XX.png`:

    heif-enc -q 30 -b 10 -t 256 -T --tiled-image-width 1170 \
      --tiled-image-height 2532 tile-00-00.png -o heic-grid-10bit.heic
