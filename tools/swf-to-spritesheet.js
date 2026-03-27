/**
 * SWF → 精灵表(Spritesheet) 批量转换工具
 * 
 * 使用 Electron + Ruffle 渲染 SWF 动画，逐帧截图，拼合为精灵表 PNG
 * 
 * 用法: ELECTRON_PATH=... node swf-to-spritesheet.js --input <swf_dir> --output <output_dir> [options]
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ─── 配置 ───
const FRAME_SIZE = 160;        // 输出帧尺寸（px）
const RENDER_SIZE = 320;       // Ruffle 渲染尺寸（2x 以获得更好质量）
const MAX_FRAMES = 200;        // 每个 SWF 最大帧数
const FRAME_DELAY = 90;        // 帧间隔（ms），约 12fps
const CONCURRENT = 1;          // 同时转换数

// ─── 命令行参数 ───
let inputDir = '';
let outputDir = '';
let filterMood = '';  // 可选：只转换特定心情目录

for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--input') inputDir = process.argv[i + 1];
  if (process.argv[i] === '--output') outputDir = process.argv[i + 1];
  if (process.argv[i] === '--mood') filterMood = process.argv[i + 1];
}

if (!inputDir || !outputDir) {
  console.log('Usage: electron swf-to-spritesheet.js --input <GG/Adult dir> --output <sprites dir> [--mood happy|sad|...]');
  process.exit(1);
}

// ─── 收集 SWF 文件 ───
function collectSwfFiles(baseDir) {
  const files = [];
  
  function walk(dir, prefix) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.name.toLowerCase().endsWith('.swf') && !entry.name.includes('副本')) {
        files.push({ fullPath, relPath, name: entry.name.replace('.swf', '') });
      }
    }
  }
  
  walk(baseDir, '');
  return files;
}

// ─── 主流程 ───
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const swfFiles = collectSwfFiles(inputDir);
  
  // 按心情过滤
  let filtered = swfFiles;
  if (filterMood) {
    filtered = swfFiles.filter(f => f.relPath.startsWith(filterMood + '/') || f.relPath.startsWith(filterMood + '\\'));
    console.log(`Filtered to mood "${filterMood}": ${filtered.length} files`);
  }
  
  console.log(`Found ${filtered.length} SWF files to convert`);
  fs.mkdirSync(outputDir, { recursive: true });
  
  // 复制 Ruffle 文件到 tools 目录（renderer 需要同目录加载）
  const ruffleDir = path.join(__dirname, 'node_modules', '@ruffle-rs', 'ruffle');
  const toolsDir = __dirname;
  
  // 创建窗口
  const win = new BrowserWindow({
    width: RENDER_SIZE + 50,
    height: RENDER_SIZE + 50,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
    },
  });
  
  // 等待 renderer 就绪
  await new Promise(resolve => {
    ipcMain.once('renderer-ready', resolve);
    win.loadFile(path.join(toolsDir, 'swf-renderer.html'));
  });
  
  console.log('Renderer ready, starting conversion...\n');
  
  // 逐个转换
  let completed = 0;
  let failed = 0;
  
  for (const swfFile of filtered) {
    const outputName = swfFile.relPath
      .replace(/\\/g, '/')
      .replace(/\//g, '-')
      .replace('.swf', '');
    
    const spritesheetPath = path.join(outputDir, `${outputName}.png`);
    const metaPath = path.join(outputDir, `${outputName}.json`);
    
    // 跳过已存在的
    if (fs.existsSync(spritesheetPath) && fs.existsSync(metaPath)) {
      console.log(`[SKIP] ${swfFile.relPath}`);
      completed++;
      continue;
    }
    
    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 30000);
        
        ipcMain.once('convert-result', (event, data) => {
          clearTimeout(timeout);
          if (data.error) reject(new Error(data.error));
          else resolve(data);
        });
        
        win.webContents.send('convert-swf', {
          swfPath: swfFile.fullPath,
          width: RENDER_SIZE,
          height: RENDER_SIZE,
          maxFrames: MAX_FRAMES,
          frameDelay: FRAME_DELAY,
        });
      });
      
      if (!result.frames || result.frames.length === 0) {
        console.log(`[EMPTY] ${swfFile.relPath} - no frames captured`);
        failed++;
        continue;
      }
      
      // 保存帧并拼合精灵表（用 Python 脚本处理）
      const framesDir = path.join(outputDir, '_frames', outputName);
      fs.mkdirSync(framesDir, { recursive: true });
      
      for (let i = 0; i < result.frames.length; i++) {
        const base64Data = result.frames[i].replace(/^data:image\/png;base64,/, '');
        fs.writeFileSync(path.join(framesDir, `${i.toString().padStart(3, '0')}.png`), base64Data, 'base64');
      }
      
      // 保存元数据
      const meta = {
        name: outputName,
        source: swfFile.relPath,
        frames: result.frames.length,
        renderWidth: RENDER_SIZE,
        renderHeight: RENDER_SIZE,
        targetWidth: FRAME_SIZE,
        targetHeight: FRAME_SIZE,
      };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      
      completed++;
      console.log(`[OK] ${swfFile.relPath} → ${result.frames.length} frames`);
      
      // 重新加载 renderer（避免 Ruffle 内存泄漏）
      if (completed % 10 === 0) {
        await new Promise(resolve => {
          ipcMain.once('renderer-ready', resolve);
          win.reload();
        });
      }
      
    } catch (e) {
      console.log(`[FAIL] ${swfFile.relPath}: ${e.message}`);
      failed++;
    }
  }
  
  console.log(`\nDone! Converted: ${completed}, Failed: ${failed}`);
  console.log(`Frames saved to: ${path.join(outputDir, '_frames')}`);
  console.log(`Run assemble_spritesheets.py to build final spritesheets.`);
  
  win.close();
  app.quit();
});
