/**
 * Generates all platform icon formats from assets/icon.svg
 *
 * Outputs:
 *   assets/icons/icon.png          — 1024×1024 master PNG
 *   assets/icons/mac/icon.icns     — macOS
 *   assets/icons/win/icon.ico      — Windows
 *   assets/icons/png/              — Linux + various sizes
 */

const sharp     = require('sharp');
const png2icons = require('png2icons');
const path      = require('path');
const fs        = require('fs');

const ROOT   = path.join(__dirname, '..');
const SRC    = path.join(ROOT, 'assets', 'icon.svg');
const OUT    = path.join(ROOT, 'assets', 'icons');
const MASTER = path.join(OUT, 'icon.png');

// PNG sizes needed for Linux / general use
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

async function run() {
  fs.mkdirSync(path.join(OUT, 'mac'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'win'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'png'), { recursive: true });

  console.log('Rendering SVG → 1024×1024 master PNG…');
  await sharp(SRC)
    .resize(1024, 1024)
    .png({ compressionLevel: 9 })
    .toFile(MASTER);

  const masterBuf = fs.readFileSync(MASTER);

  // ── macOS .icns ──────────────────────────────────────────────────────────
  console.log('Generating macOS .icns…');
  const icns = png2icons.createICNS(masterBuf, png2icons.BILINEAR, 0);
  if (icns) {
    fs.writeFileSync(path.join(OUT, 'mac', 'icon.icns'), icns);
    console.log('  ✓ assets/icons/mac/icon.icns');
  } else {
    console.error('  ✗ icns generation failed');
  }

  // ── Windows .ico ─────────────────────────────────────────────────────────
  console.log('Generating Windows .ico…');
  const ico = png2icons.createICO(masterBuf, png2icons.BILINEAR, 0, true);
  if (ico) {
    fs.writeFileSync(path.join(OUT, 'win', 'icon.ico'), ico);
    console.log('  ✓ assets/icons/win/icon.ico');
  } else {
    console.error('  ✗ ico generation failed');
  }

  // ── Linux / misc PNGs ────────────────────────────────────────────────────
  console.log('Generating PNG sizes…');
  await Promise.all(PNG_SIZES.map(async (size) => {
    const dest = path.join(OUT, 'png', `${size}x${size}.png`);
    await sharp(SRC).resize(size, size).png().toFile(dest);
    console.log(`  ✓ ${size}x${size}.png`);
  }));

  // Copy 512×512 as the root icon.png (used by electron-builder on Linux)
  await sharp(SRC).resize(512, 512).png().toFile(path.join(OUT, 'icon.png'));

  console.log('\nAll icons generated in assets/icons/');
}

run().catch(e => { console.error(e); process.exit(1); });
