/**
 * 下载 Moonshine Tiny ONNX 模型到本地 models/ 目录
 * 用法: node scripts/download-model.js
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MODEL_DIR = path.join(__dirname, '..', 'models', 'moonshine-tiny');

// 模型文件列表（onnx-community/moonshine-tiny-ONNX 格式）
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'preprocessor_config.json',
  'onnx/encoder_model.onnx',
  'onnx/decoder_model_merged.onnx',
];

// 镜像源（按优先级尝试）
const MIRRORS = [
  { base: 'https://hf-mirror.com/onnx-community/moonshine-tiny-ONNX/resolve/main', label: 'hf-mirror.com' },
  { base: 'https://huggingface.co/onnx-community/moonshine-tiny-ONNX/resolve/main', label: 'huggingface.co' },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;

    const req = protocol.get(url, { headers: { 'User-Agent': 'qq-pet-model-downloader/1.0' } }, (res) => {
      // 处理重定向（支持相对路径 location）
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        let location = res.headers.location;
        if (location && !location.startsWith('http')) {
          // 相对路径 → 拼接成绝对 URL
          const base = new URL(url);
          location = `${base.protocol}//${base.host}${location}`;
        }
        if (!location) return reject(new Error('重定向缺少 location'));
        return download(location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const total = parseInt(res.headers['content-length'] || '0');
      let downloaded = 0;
      let lastLog = 0;

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        const now = Date.now();
        if (total && now - lastLog > 1000) {
          process.stdout.write(`\r  下载中: ${(downloaded / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB (${Math.round(downloaded / total * 100)}%)`);
          lastLog = now;
        }
      });

      res.pipe(file);
      file.on('finish', () => {
        file.close();
        if (total) process.stdout.write('\n');
        resolve();
      });
    });

    req.on('error', (err) => { file.close(); try { fs.unlinkSync(dest); } catch {} reject(err); });
    file.on('error', (err) => { file.close(); try { fs.unlinkSync(dest); } catch {} reject(err); });
  });
}

async function main() {
  console.log('📥 下载 Moonshine Tiny ONNX 模型...');
  console.log(`📁 目标目录: ${MODEL_DIR}\n`);

  for (const file of FILES) {
    const dest = path.join(MODEL_DIR, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 100) {
      console.log(`  ✅ 已存在，跳过: ${file}`);
      continue;
    }
    let ok = false;
    for (const mirror of MIRRORS) {
      const url = `${mirror.base}/${file}`;
      console.log(`  ⬇️  ${file}  (via ${mirror.label})`);
      try {
        await download(url, dest);
        const size = fs.statSync(dest).size;
        console.log(`  ✅ ${file} (${(size / 1024 / 1024).toFixed(2)} MB)`);
        ok = true;
        break;
      } catch (e) {
        console.warn(`  ⚠️  镜像失败 ${mirror.label}: ${e.message}`);
      }
    }
    if (!ok) {
      console.error(`  ❌ 所有镜像均失败: ${file}`);
      process.exit(1);
    }
  }

  console.log('\n🎉 模型下载完成！');
  console.log(`📁 模型路径: ${MODEL_DIR}`);

  // 统计总大小
  function dirSize(dir) {
    let total = 0;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, f.name);
      if (f.isDirectory()) total += dirSize(fp);
      else total += fs.statSync(fp).size;
    }
    return total;
  }
  const total = dirSize(MODEL_DIR);
  console.log(`📦 模型总大小: ${(total / 1024 / 1024).toFixed(1)} MB`);
}

main().catch(e => { console.error('下载失败:', e.message); process.exit(1); });
