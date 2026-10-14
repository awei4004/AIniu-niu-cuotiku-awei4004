const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
fs.copyFileSync(path.join(root, 'miniprogram/services/practice-domain.js'),
  path.join(root, 'cloudfunctions/api/practice-domain.js'));
console.log('出题和判题规则已同步至云函数');
