/**
 * Generates PNG app icons from public/icons/icon.svg
 * Run: node scripts/generate-icons.js
 * Requires: npm install --save-dev sharp
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, '../public/icons/icon.svg');
const outDir  = path.join(__dirname, '../public/icons');
const svg = fs.readFileSync(svgPath);

const sizes = [
  // PWA / manifest
  { name: 'icon-192.png',  size: 192 },
  { name: 'icon-512.png',  size: 512 },
  // Apple Touch icons (App Store / iOS home screen)
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'apple-touch-icon-152.png', size: 152 },
  { name: 'apple-touch-icon-120.png', size: 120 },
  // Favicon
  { name: 'favicon-32.png', size: 32 },
];

(async () => {
  for (const { name, size } of sizes) {
    await sharp(svg)
      .resize(size, size)
      .png()
      .toFile(path.join(outDir, name));
    console.log(`✓ ${name} (${size}×${size})`);
  }
  console.log('\nAll icons generated in public/icons/');
})();
