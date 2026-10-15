const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter } = require('../cloudfunctions/api/ocr-adapter');

test('real OCR adapter builds a signed image request and preserves detected line order', async () => {
  let request;
  const adapter = createAdapter({
    env: { OCR_PROVIDER: 'tencent', TENCENT_SECRET_ID: 'test-id', TENCENT_SECRET_KEY: 'test-key', TENCENT_SESSION_TOKEN: 'test-token' },
    now: () => Date.parse('2026-10-15T00:00:00Z'),
    send: async (value) => {
      request = value;
      return { Response: { TextDetections: [{ DetectedText: '第一行题目' }, { DetectedText: '第二行选项' }] } };
    }
  });
  const bytes = Buffer.from([1, 2, 3]);
  const result = await adapter.recognize(bytes);
  assert.equal(result.provider, 'tencent');
  assert.equal(result.text, '第一行题目\n第二行选项');
  assert.equal(request.host, 'ocr.tencentcloudapi.com');
  assert.equal(request.headers['X-TC-Action'], 'GeneralBasic');
  assert.equal(request.headers['X-TC-Version'], '2018-11-19');
  assert.equal(request.headers['X-TC-Token'], 'test-token');
  assert.match(request.headers.Authorization, /^TC3-HMAC-SHA256 Credential=test-id\/2026-10-15\/ocr\/tc3_request, SignedHeaders=content-type;host, Signature=[a-f0-9]{64}$/);
  assert.equal(JSON.parse(request.body).ImageBase64, bytes.toString('base64'));
  assert.equal(JSON.parse(request.body).ImageUrl, undefined);
  assert.equal(request.body.includes('test-key'), false);
});

test('real OCR adapter requires server credentials and rejects unsafe provider output', async () => {
  let calls = 0;
  const empty = createAdapter({ env: {}, send: async () => { calls += 1; } });
  await assert.rejects(empty.recognize(Buffer.from('image')), { code: 'OCR_NOT_CONFIGURED' });
  assert.equal(calls, 0);
  const env = { OCR_PROVIDER: 'tencent', TENCENT_SECRET_ID: 'test-id', TENCENT_SECRET_KEY: 'test-key' };
  for (const [payload, code] of [
    [{ Response: { Error: { Code: 'AuthFailure.SecretIdNotFound', Message: 'private provider details' } } }, 'PROVIDER_FAILED'],
    [{ Response: { Error: { Code: 'FailedOperation.ImageNoText' } } }, 'OCR_EMPTY'],
    [{ Response: { TextDetections: [] } }, 'OCR_EMPTY'],
    [{ Response: { TextDetections: [{ DetectedText: 42 }] } }, 'PROVIDER_FAILED'],
    [{ Response: { TextDetections: [{ DetectedText: '字'.repeat(5001) }] } }, 'OCR_TOO_LONG']
  ]) {
    const adapter = createAdapter({ env, send: async () => payload });
    await assert.rejects(adapter.recognize(Buffer.from('image')), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message.includes('private provider details'), false);
      return true;
    });
  }
});
