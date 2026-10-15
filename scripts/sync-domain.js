const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
['practice-domain', 'image-domain'].forEach((name) => {
  fs.copyFileSync(path.join(root, `miniprogram/services/${name}.js`),
    path.join(root, `cloudfunctions/api/${name}.js`));
});
console.log('出题、判题与图片校验规则已同步至云函数');
