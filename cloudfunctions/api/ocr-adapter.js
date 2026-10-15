const crypto = require('crypto');
const https = require('https');
const rules = require('./image-domain');
const HOST = 'ocr.tencentcloudapi.com';
const VERSION = '2018-11-19';

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function hmac(key, value) { return crypto.createHmac('sha256', key).update(value).digest(); }

function signedRequest(bytes, env, timestamp) {
  const body = JSON.stringify({ ImageBase64: bytes.toString('base64') });
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/ocr/tc3_request`;
  const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${HOST}\n\ncontent-type;host\n${hash(body)}`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`;
  const key = hmac(hmac(hmac(`TC3${env.TENCENT_SECRET_KEY}`, date), 'ocr'), 'tc3_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    Host: HOST,
    Authorization: `TC3-HMAC-SHA256 Credential=${env.TENCENT_SECRET_ID}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
    'X-TC-Action': 'GeneralBasic', 'X-TC-Version': VERSION,
    'X-TC-Timestamp': String(timestamp), 'X-TC-Region': env.TENCENT_OCR_REGION || 'ap-guangzhou',
    'Content-Length': Buffer.byteLength(body)
  };
  if (env.TENCENT_SESSION_TOKEN) headers['X-TC-Token'] = env.TENCENT_SESSION_TOKEN;
  return { host: HOST, method: 'POST', path: '/', headers, body };
}

function post(options) {
  return new Promise((resolve, reject) => {
    let request;
    const timer = setTimeout(() => request.destroy(rules.error('PROVIDER_TIMEOUT', '识别超时，可查询原任务或稍后重试')), 20000);
    request = https.request(options, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) request.destroy(rules.error('PROVIDER_FAILED', '识别结果过大，请裁剪图片后重试'));
        else chunks.push(chunk);
      });
      response.on('error', () => request.destroy(rules.error('PROVIDER_FAILED', '识别连接中断，可稍后重试')));
      response.on('end', () => {
        clearTimeout(timer);
        if (response.statusCode !== 200) return reject(rules.error('PROVIDER_FAILED', '识别服务返回异常，请稍后重试'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(rules.error('PROVIDER_FAILED', '识别服务返回无效结果')); }
      });
    });
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error.code === 'PROVIDER_TIMEOUT' || error.code === 'PROVIDER_FAILED' ? error
        : rules.error('PROVIDER_FAILED', '无法连接识别服务，请稍后重试'));
    });
    request.end(options.body);
  });
}

function createAdapter({ env = process.env, send = post, now = () => Date.now() } = {}) {
  return {
    provider: () => env.OCR_PROVIDER === 'tencent' ? 'tencent' : 'unconfigured',
    async recognize(bytes) {
      if (env.OCR_PROVIDER !== 'tencent' || !env.TENCENT_SECRET_ID || !env.TENCENT_SECRET_KEY) {
        throw rules.error('OCR_NOT_CONFIGURED', '云端尚未配置 OCR，可保留原图并手动录入');
      }
      const payload = await send(signedRequest(bytes, env, Math.floor(now() / 1000)));
      const response = payload && payload.Response;
      if (!response || response.Error) {
        const code = response && response.Error && response.Error.Code || '';
        if (/ImageNoText/.test(code)) throw rules.error('OCR_EMPTY', '没有识别到文字，请换一张清晰图片或手动录入');
        throw rules.error('PROVIDER_FAILED', /AuthFailure|UnauthorizedOperation/.test(code)
          ? '识别服务认证失败，请检查云端配置；也可手动录入' : '识别服务未能处理图片，请换图或稍后重试');
      }
      if (!Array.isArray(response.TextDetections) || response.TextDetections.some((item) => !item || typeof item.DetectedText !== 'string')) {
        throw rules.error('PROVIDER_FAILED', '识别服务返回无效文字结果');
      }
      return rules.ocrResult({ provider: 'tencent', text: response.TextDetections.map((item) => item.DetectedText).join('\n') });
    }
  };
}

module.exports = Object.assign(createAdapter(), { createAdapter, signedRequest });
