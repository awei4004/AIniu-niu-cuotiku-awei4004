const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { fixture, renderLocal } = require('../tests/helpers/pdf-fixture');
const cloudRenderer = require('../cloudfunctions/api/pdf-renderer');

async function main() {
  const output = path.resolve(__dirname, '../output/pdf');
  const scratch = path.resolve(__dirname, '../tmp/pdfs');
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });
  for (const template of ['practice', 'analysis']) {
    const { snapshot, imageBytes } = fixture(template);
    const cloud = await cloudRenderer.render(snapshot, { loadImage: async () => ({ bytes: imageBytes, format: 'png' }) });
    const local = await renderLocal(snapshot, imageBytes);
    for (const [mode, result] of [['cloud', cloud], ['local', local]]) {
      const pdf = await PDFDocument.load(result.bytes);
      if (pdf.getPageCount() !== result.pageCount) throw new Error('Page count mismatch');
      const target = path.join(mode === 'cloud' ? output : scratch, `${template}-${mode}.pdf`);
      fs.writeFileSync(target, result.bytes);
      console.log(`${mode} / ${template}: ${result.pageCount} pages, ${result.bytes.length} bytes, ${target}`);
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
