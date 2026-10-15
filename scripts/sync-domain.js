const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
['practice-domain', 'image-domain', 'export-domain', 'pdf-layout'].forEach((name) => {
  fs.copyFileSync(path.join(root, `miniprogram/services/${name}.js`),
    path.join(root, `cloudfunctions/api/${name}.js`));
});
const vendor = path.join(root, 'miniprogram/vendor');
fs.mkdirSync(vendor, { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules/pdf-lib/dist/pdf-lib.min.js'), path.join(vendor, 'pdf-lib.js'));
fs.copyFileSync(path.join(root, 'node_modules/pdf-lib/LICENSE.md'), path.join(vendor, 'pdf-lib.LICENSE.md'));
console.log('出题、图片、导出规则及 PDF 依赖已同步');
