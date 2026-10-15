const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { layout } = require('./pdf-layout');
const { error } = require('./export-domain');

async function render(snapshot, { loadImage }) {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const fontPath = path.join(__dirname, 'assets/NotoSansSC-VF.ttf');
  if (!fs.existsSync(fontPath)) throw error('PDF_FONT_MISSING', '云函数缺少中文字体，请完整上传 assets 目录');
  // Keep the complete TrueType font so glyph and character mappings remain intact in print viewers.
  const font = await document.embedFont(fs.readFileSync(fontPath), { subset: false });
  const supported = new Set(font.getCharacterSet());
  function checkText(text) {
    if (Array.from(text).some((char) => !supported.has(char.codePointAt(0)))) {
      throw error('EXPORT_LIMIT', '内容含当前打印字体不支持的字符，请移除表情或特殊字符后导出');
    }
  }
  const measure = (text, size) => { checkText(text); return font.widthOfTextAtSize(text, size); };
  const images = {};
  for (const q of snapshot.questions) {
    if (!q.sourceFileId || images[q.sourceFileId]) continue;
    const image = await loadImage(q.sourceFileId);
    images[q.sourceFileId] = image.format === 'png' ? await document.embedPng(image.bytes) : await document.embedJpg(image.bytes);
  }
  const plan = layout(snapshot, measure, images);
  for (const operations of plan.pages) {
    const page = document.addPage([plan.width, plan.height]);
    for (const op of operations) {
      if (op.type === 'text' && op.text) {
        checkText(op.text);
        page.drawText(op.text, { x: op.x, y: plan.height - op.y - op.size, font, size: op.size, color: rgb(0.09, 0.09, 0.09) });
      }
      if (op.type === 'line') page.drawLine({ start: { x: op.x, y: plan.height - op.y },
        end: { x: op.x + op.width, y: plan.height - op.y }, thickness: 0.5, color: rgb(op.light ? 0.83 : 0.5, op.light ? 0.83 : 0.5, op.light ? 0.83 : 0.5) });
      if (op.type === 'image') page.drawImage(images[op.id], { x: op.x, y: plan.height - op.y - op.height, width: op.width, height: op.height });
    }
  }
  document.setTitle(snapshot.title);
  document.setProducer('Wrong Question Library / pdf-lib');
  return { bytes: await document.save(), pageCount: plan.pages.length };
}

module.exports = { render };
