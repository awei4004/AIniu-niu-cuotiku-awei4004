const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { fixture, renderLocal } = require('./helpers/pdf-fixture');
const cloudRenderer = require('../cloudfunctions/api/pdf-renderer');

for (const mode of ['local', 'cloud']) {
  test(`${mode}: production PDF renderer writes real Chinese A4 pages with optional portrait images`, async () => {
    for (const template of ['practice', 'analysis']) {
      const { snapshot, imageBytes } = fixture(template);
      let loads = 0;
      const progress = [];
      const result = mode === 'local' ? await renderLocal(snapshot, imageBytes, (value) => progress.push(value))
        : await cloudRenderer.render(snapshot, { loadImage: async () => { loads += 1; return { bytes: imageBytes, format: 'png' }; } });
      assert.equal(Buffer.from(result.bytes).subarray(0, 5).toString(), '%PDF-');
      const pdf = await PDFDocument.load(result.bytes);
      assert.equal(pdf.getPageCount(), result.pageCount);
      assert.ok(result.pageCount >= 2);
      for (const page of pdf.getPages()) {
        assert.ok(Math.abs(page.getWidth() - 595.28) < 0.01);
        assert.ok(Math.abs(page.getHeight() - 841.89) < 0.01);
      }
      if (mode === 'cloud') assert.equal(loads, template === 'practice' ? 0 : 1);
      else assert.equal(progress.at(-1), 95);
    }
  });
}

test('cloud PDF reports unsupported glyphs instead of silently dropping question content', async () => {
  const { snapshot } = fixture('practice');
  snapshot.questions[0].questionText = '不支持的表情😀';
  await assert.rejects(cloudRenderer.render(snapshot, {}), { code: 'EXPORT_LIMIT' });
});
