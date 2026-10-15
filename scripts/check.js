const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const compilerDirectory = [
  'D:\\微信web开发者工具\\code\\package.nw\\node_modules\\wcc-exec',
  'D:\\微信web开发者工具\\resources\\app.asar.unpacked\\node_modules\\wcc-exec'
].find((directory) => ['wcc.exe', 'wcsc.exe'].every((file) => fs.existsSync(path.join(directory, file))));
const wcc = compilerDirectory && path.join(compilerDirectory, 'wcc.exe');
const wcsc = compilerDirectory && path.join(compilerDirectory, 'wcsc.exe');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === '.git') return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

const files = walk(root);
const jsFiles = files.filter((file) => file.endsWith('.js'));
const wxmlFiles = files.filter((file) => file.endsWith('.wxml'));
const wxssFiles = files.filter((file) => file.endsWith('.wxss'));

jsFiles.forEach((file) => execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' }));

if (compilerDirectory) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrong-question-wxml-'));
  wxmlFiles.forEach((file, index) => {
    execFileSync(wcc, [file, '-o', path.join(tempDir, `${index}.js`)], { stdio: 'pipe' });
  });
  wxssFiles.forEach((file, index) => {
    execFileSync(wcsc, ['-lc', file, '-o', path.join(tempDir, `${index}.wxss.js`)], { stdio: 'pipe' });
  });
  console.log(`微信编译检查通过：${wxmlFiles.length} 个 WXML，${wxssFiles.length} 个 WXSS`);
} else {
  console.log('未找到微信编译器，已跳过 WXML/WXSS 编译检查');
}

console.log(`JavaScript 语法检查通过：${jsFiles.length} 个文件`);
