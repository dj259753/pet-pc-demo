/* ═══════════════════════════════════════════
   精灵动画渲染器 - 基于精灵表（Spritesheet）
   从 PNG 精灵表加载帧动画，支持所有动画状态
   ═══════════════════════════════════════════ */

const SpriteRenderer = (() => {
  const canvas = document.getElementById('pet-canvas');
  const ctx = canvas.getContext('2d');
  const W = 160, H = 160;

  // 关闭抗锯齿，保持像素风格清晰
  ctx.imageSmoothingEnabled = false;

  let frameIndex = 0;
  let frameTimer = 0;
  let currentAnim = 'idle';

  // ─── 精灵表配置 ───
  // 每张精灵表的帧宽高
  const FRAME_W = 128;
  const FRAME_H = 128;

  // 精灵表图片缓存
  const spriteSheets = {};
  let spritesLoaded = false;

  // 每帧的实际内容边界缓存
  // 格式: { 'sheetName': [ { minX, minY, maxX, maxY, contentW, contentH }, ... ] }
  const frameBounds = {};

  // ─── 动画定义 ───
  // 每个动画指向一张精灵表 + 帧数 + 速度
  // 目前只有 idle.png，其他动画暂时复用 idle 的精灵表
  const ANIM_CONFIG = {
    idle:         { sheet: 'idle',       frames: 6, speed: 300,  flipX: false, frameW: 128, frameH: 128 },
    walk_right:   { sheet: 'walk-right', frames: 7, speed: 150,  flipX: false, frameW: 128, frameH: 128 },
    walk_left:    { sheet: 'walk-left',  frames: 7, speed: 150,  flipX: false, frameW: 128, frameH: 128 },
    yawning:      { sheet: 'idle', frames: 6, speed: 500,  flipX: false, frameW: 128, frameH: 128 },
    happy_jump:   { sheet: 'happy',    frames: 6, speed: 150,  flipX: false, frameW: 128, frameH: 128 },
    coffee_drink: { sheet: 'coffee',     frames: 8, speed: 300,  flipX: false, frameW: 128, frameH: 128 },
    kick_ball:    { sheet: 'kick-ball',  frames: 6, speed: 200,  flipX: false, frameW: 128, frameH: 128 },
    rain_wash:    { sheet: 'rain',       frames: 8, speed: 200,  flipX: false, frameW: 128, frameH: 128 },
    eating:       { sheet: 'eating',   frames: 6, speed: 250,  flipX: false, frameW: 128, frameH: 128 },
    washing:      { sheet: 'idle',     frames: 6, speed: 200,  flipX: false, frameW: 128, frameH: 128 },
    happy:        { sheet: 'happy',    frames: 6, speed: 250,  flipX: false, frameW: 128, frameH: 128 },
    sad:          { sheet: 'idle',     frames: 6, speed: 500,  flipX: false, frameW: 128, frameH: 128 },
    working:      { sheet: 'working-1', frames: 4, speed: 350,  flipX: false, frameW: 128, frameH: 128 },
    working_1:    { sheet: 'working-1', frames: 4, speed: 350,  flipX: false, frameW: 128, frameH: 128 },
    working_2:    { sheet: 'working-2', frames: 7, speed: 300,  flipX: false, frameW: 128, frameH: 128 },
    thinking:     { sheet: 'idle',     frames: 6, speed: 400,  flipX: false, frameW: 128, frameH: 128 },
    talking:      { sheet: 'idle',     frames: 6, speed: 200,  flipX: false, frameW: 128, frameH: 128 },
    sleeping:     { sheet: 'sleeping', frames: 4, speed: 500,  flipX: false, frameW: 128, frameH: 128 },
    sleeping_lie: { sheet: 'sleeping', frames: 4, speed: 600,  flipX: false, frameW: 128, frameH: 128 },
    error:        { sheet: 'idle',     frames: 6, speed: 500,  flipX: false, frameW: 128, frameH: 128 },
  };

  // ─── 需要加载的精灵表文件列表（原版像素风，作为 fallback） ───
  const SHEET_FILES = {
    idle: 'sprites/idle.png',
    'walk-right': 'sprites/walk-right.png',
    'walk-left': 'sprites/walk-left.png',
    happy: 'sprites/happy.png',
    sleeping: 'sprites/sleeping.png',
    coffee: 'sprites/coffee.png',
    rain: 'sprites/rain.png',
    'kick-ball': 'sprites/kick-ball.png',
    question: 'sprites/question.png',
    thinking: 'sprites/thinking.png',
    'working-1': 'sprites/working-1.png',
    'working-2': 'sprites/working-2.png',
    eating: 'sprites/eating.png',
  };

  // ═══════════════════════════════════════════
  //  QC 动画系统 - 从 QQ宠物素材生成的精灵表
  //  支持5级情绪 × (Stand/Speak/interact/play)
  // ═══════════════════════════════════════════
  
  let qcManifest = null;       // QC 动画清单
  let qcAnimConfig = {};       // QC 动画配置（与 ANIM_CONFIG 格式兼容）
  let qcLoaded = false;        // QC 动画是否加载完成
  let qcLoadedSheets = {};     // 已加载的 QC 精灵表
  
  // 动画池：按 mood 和类型索引
  const QC_POOLS = {
    stand:    {},  // { happy: ['happy-Stand'], peaceful: ['peaceful-Stand', 'peaceful-Stand1'] }
    speak:    {},  // { happy: ['happy-Speak'], ... }
    interact: {},  // { happy: ['happy-interact-H1', ...], ... }
    play:     {},  // { happy: ['happy-play-P1', ...], ... }
    appear:   {},  // { happy: ['happy-Appear'], ... }
    hide:     {},  // { happy: ['happy-Hide'], ... }
  };
  
  // 通用（不分情绪）动画池
  const QC_COMMON = {
    eat:     [],   // ['Eat1', 'Eat2']
    clean:   [],
    sick:    [],
    enter:   [],
    exit:    [],
    cure:    [],
    die:     [],
    dying:   [],
    levelup: [],
    revival: [],
  };
  
  // ─── 加载 QC 动画清单 ───
  async function loadQCManifest() {
    try {
      const resp = await fetch('sprites/qc/animation-manifest.json');
      if (!resp.ok) throw new Error('manifest not found');
      qcManifest = await resp.json();
      
      // 解析并分类
      for (const [name, config] of Object.entries(qcManifest)) {
        // 注册动画配置
        qcAnimConfig[name] = {
          sheet: name,
          frames: config.frames,
          speed: config.speed || 250,
          flipX: config.flipX || false,
          frameW: config.frameW || 160,
          frameH: config.frameH || 160,
        };
        
        // 分类到动画池
        const parts = name.split('-');
        
        if (parts.length === 1) {
          // 通用动作：Eat1, Clean1, Sick1, Enter1, etc.
          const lower = name.toLowerCase();
          if (lower.startsWith('eat'))     QC_COMMON.eat.push(name);
          else if (lower.startsWith('clean')) QC_COMMON.clean.push(name);
          else if (lower.startsWith('sick'))  QC_COMMON.sick.push(name);
          else if (lower.startsWith('enter')) QC_COMMON.enter.push(name);
          else if (lower.startsWith('exit'))  QC_COMMON.exit.push(name);
          else if (lower.startsWith('cure'))  QC_COMMON.cure.push(name);
          else if (lower === 'die')           QC_COMMON.die.push(name);
          else if (lower === 'dying')         QC_COMMON.dying.push(name);
          else if (lower === 'levup')         QC_COMMON.levelup.push(name);
          else if (lower === 'revival')       QC_COMMON.revival.push(name);
        } else {
          // 情绪动画：happy-Stand, peaceful-interact-H1, happy-play-P1, etc.
          const mood = parts[0]; // happy, peaceful, sad, upset, prostrate
          const type = parts.length === 2 ? parts[1].toLowerCase() : parts[1].toLowerCase();
          
          if (parts.length === 2) {
            // happy-Stand, happy-Speak, happy-Appear, happy-Hide
            const t = parts[1].toLowerCase().replace(/\d+$/, '');
            if (t === 'stand')       { (QC_POOLS.stand[mood] = QC_POOLS.stand[mood] || []).push(name); }
            else if (t === 'speak')  { (QC_POOLS.speak[mood] = QC_POOLS.speak[mood] || []).push(name); }
            else if (t === 'appear') { (QC_POOLS.appear[mood] = QC_POOLS.appear[mood] || []).push(name); }
            else if (t === 'hide')   { (QC_POOLS.hide[mood] = QC_POOLS.hide[mood] || []).push(name); }
            else { (QC_POOLS.stand[mood] = QC_POOLS.stand[mood] || []).push(name); }
          } else if (parts.length >= 3) {
            // happy-interact-H1, happy-play-P1
            const category = parts[1].toLowerCase();
            if (category === 'interact') {
              (QC_POOLS.interact[mood] = QC_POOLS.interact[mood] || []).push(name);
            } else if (category === 'play') {
              (QC_POOLS.play[mood] = QC_POOLS.play[mood] || []).push(name);
            }
          }
        }
      }
      
      console.log('🐧 QC动画清单加载完成:', Object.keys(qcManifest).length, '个动画');
      console.log('   stand池:', Object.entries(QC_POOLS.stand).map(([k,v]) => `${k}(${v.length})`).join(', '));
      console.log('   interact池:', Object.entries(QC_POOLS.interact).map(([k,v]) => `${k}(${v.length})`).join(', '));
      console.log('   play池:', Object.entries(QC_POOLS.play).map(([k,v]) => `${k}(${v.length})`).join(', '));
      console.log('   通用:', Object.entries(QC_COMMON).filter(([k,v]) => v.length > 0).map(([k,v]) => `${k}(${v.length})`).join(', '));
      
      return true;
    } catch (e) {
      console.warn('QC动画清单加载失败，使用原版动画:', e.message);
      return false;
    }
  }
  
  // ─── 按需加载 QC 精灵表（懒加载） ───
  function loadQCSheet(name) {
    return new Promise((resolve) => {
      if (qcLoadedSheets[name]) { resolve(qcLoadedSheets[name]); return; }
      if (spriteSheets[name]) { resolve(spriteSheets[name]); return; }
      
      const img = new Image();
      img.onload = () => {
        spriteSheets[name] = img;
        qcLoadedSheets[name] = img;
        resolve(img);
      };
      img.onerror = () => {
        console.warn(`QC精灵表加载失败: ${name}`);
        resolve(null);
      };
      img.src = `sprites/qc/${name}.png`;
    });
  }
  
  // ─── 预加载指定心情的核心动画 ───
  async function preloadMoodSheets(mood) {
    const sheetsToLoad = [];
    
    // Stand + Speak 必加载
    if (QC_POOLS.stand[mood]) sheetsToLoad.push(...QC_POOLS.stand[mood]);
    if (QC_POOLS.speak[mood]) sheetsToLoad.push(...QC_POOLS.speak[mood]);
    
    // 通用动作
    sheetsToLoad.push(...QC_COMMON.eat, ...QC_COMMON.clean);
    
    // 前几个 interact 和 play（不全部加载，太大）
    if (QC_POOLS.interact[mood]) sheetsToLoad.push(...QC_POOLS.interact[mood].slice(0, 10));
    if (QC_POOLS.play[mood]) sheetsToLoad.push(...QC_POOLS.play[mood].slice(0, 10));
    
    console.log(`🐧 预加载 ${mood} 心情动画: ${sheetsToLoad.length} 张`);
    await Promise.all(sheetsToLoad.map(name => loadQCSheet(name)));
    console.log(`🐧 ${mood} 心情动画预加载完成`);
  }
  
  // ─── QC 动画选择接口 ───
  
  /** 获取当前心情的Stand动画名 */
  function getQCStand(mood) {
    const pool = QC_POOLS.stand[mood] || QC_POOLS.stand['peaceful'] || [];
    return pool.length > 0 ? pool[0] : null;
  }
  
  /** 获取当前心情的Speak动画名 */
  function getQCSpeak(mood) {
    const pool = QC_POOLS.speak[mood] || QC_POOLS.speak['peaceful'] || [];
    return pool.length > 0 ? pool[0] : null;
  }
  
  /** 从指定心情的 interact 池随机选一个 */
  function getQCInteract(mood) {
    const pool = QC_POOLS.interact[mood] || QC_POOLS.interact['peaceful'] || [];
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  
  /** 从指定心情的 play 池随机选一个 */
  function getQCPlay(mood) {
    const pool = QC_POOLS.play[mood] || QC_POOLS.play['peaceful'] || [];
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  
  /** 从通用动画池随机选一个 */
  function getQCCommon(type) {
    const pool = QC_COMMON[type] || [];
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ─── 分析精灵表每帧的内容边界 ───
  function analyzeFrameBounds(sheetName, img, frameW, frameH, frameCount) {
    const offCanvas = document.createElement('canvas');
    offCanvas.width = frameW;
    offCanvas.height = frameH;
    const offCtx = offCanvas.getContext('2d');
    const bounds = [];

    for (let i = 0; i < frameCount; i++) {
      offCtx.clearRect(0, 0, frameW, frameH);
      offCtx.drawImage(img, i * frameW, 0, frameW, frameH, 0, 0, frameW, frameH);
      const imageData = offCtx.getImageData(0, 0, frameW, frameH);
      const data = imageData.data;

      let minX = frameW, maxX = 0, minY = frameH, maxY = 0;
      let found = false;

      for (let y = 0; y < frameH; y++) {
        for (let x = 0; x < frameW; x++) {
          const alpha = data[(y * frameW + x) * 4 + 3];
          if (alpha > 10) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            found = true;
          }
        }
      }

      if (found) {
        bounds.push({ minX, minY, maxX, maxY, contentW: maxX - minX + 1, contentH: maxY - minY + 1 });
      } else {
        bounds.push({ minX: 0, minY: 0, maxX: frameW, maxY: frameH, contentW: frameW, contentH: frameH });
      }
    }

    frameBounds[sheetName] = bounds;
    console.log(`📐 帧边界: ${sheetName}`, bounds.map((b, i) => `帧${i}:${b.contentW}x${b.contentH}`).join(', '));
  }

  // ─── 加载所有精灵表 ───
  function loadSpriteSheets() {
    return new Promise((resolve) => {
      const entries = Object.entries(SHEET_FILES);
      let loaded = 0;
      const total = entries.length;

      entries.forEach(([name, path]) => {
        const img = new Image();
        img.onload = () => {
          spriteSheets[name] = img;
          loaded++;
          console.log(`🖼️ 精灵表加载完成: ${name} (${img.width}×${img.height})`);
          // 查找使用该精灵表的动画配置，获取帧参数
          const animEntry = Object.values(ANIM_CONFIG).find(a => a.sheet === name);
          if (animEntry) {
            analyzeFrameBounds(name, img, animEntry.frameW || FRAME_W, animEntry.frameH || FRAME_H, animEntry.frames);
          }
          if (loaded >= total) {
            spritesLoaded = true;
            resolve();
          }
        };
        img.onerror = () => {
          console.warn(`⚠️ 精灵表加载失败: ${name} (${path})，使用备用绘制`);
          loaded++;
          if (loaded >= total) {
            spritesLoaded = true;
            resolve();
          }
        };
        img.src = path;
      });

      // 如果没有任何表要加载
      if (total === 0) {
        spritesLoaded = true;
        resolve();
      }
    });
  }

  // ─── 特效叠加层绘制 ───
  // 某些动画状态需要在精灵上方绘制额外特效

  function drawOverlayEffects(animName, frame) {
    switch (animName) {
      case 'sleeping':
      case 'sleeping_lie':
        drawSleepZzz(frame);
        break;
      case 'happy':
      case 'happy_jump':
        drawHappyEffects(frame);
        break;
      case 'sad':
        drawSadEffects(frame);
        break;
      case 'thinking':
      case 'question':
        // 精灵表已自带完整画面（包含问号），无需额外特效
        break;
      case 'eating':
        // 精灵表已自带完整吃东西画面，无需额外特效
        break;
      case 'kick_ball':
        drawKickBallEffects(frame);
        break;
      case 'working':
      case 'working_1':
      case 'working_2':
        // 精灵表已自带完整工作画面（含电脑），无需额外特效
        break;
      case 'error':
        drawErrorEffects(frame);
        break;
      case 'yawning':
        drawYawningEffects(frame);
        break;
      default:
        break;
    }
  }

  function drawSleepZzz(frame) {
    const zzz = ['z', 'Z', 'z'];
    const sizes = [10, 13, 16];
    const positions = [[120, 20], [130, 10], [138, 0]];
    const count = (frame % 3) + 1;
    for (let i = 0; i < count; i++) {
      ctx.fillStyle = `rgba(180, 180, 255, ${0.4 + frame * 0.15})`;
      ctx.font = `${sizes[i]}px serif`;
      ctx.fillText(zzz[i], positions[i][0], positions[i][1] + 20);
    }
  }

  function drawHappyEffects(frame) {
    const emojis = ['⭐', '✨', '♪', '❤', '♫'];
    const positions = [[5, 20], [135, 15], [140, 30], [2, 40], [130, 45]];
    ctx.font = '14px serif';
    const count = Math.min(frame % 4 + 1, 3);
    for (let i = 0; i < count; i++) {
      const idx = (frame + i) % emojis.length;
      ctx.fillStyle = ['#ffd700', '#ff6b6b', '#ffd93d', '#6bcb77', '#ff69b4'][idx];
      ctx.fillText(emojis[idx], positions[idx][0], positions[idx][1]);
    }
  }

  function drawSadEffects(frame) {
    ctx.fillStyle = '#74b9ff';
    if (frame % 3 === 0) {
      ctx.fillRect(52, 55, 2, 8);
    } else if (frame % 3 === 1) {
      ctx.fillRect(52, 58, 2, 8);
      ctx.fillRect(105, 55, 2, 6);
    } else {
      ctx.fillRect(105, 58, 2, 8);
    }
  }

  function drawThinkingEffects(frame) {
    // thinking 精灵表已包含完整画面，无需额外特效
  }

  function drawEatingEffects(frame) {
    // eating 精灵表已包含完整画面，无需额外特效
  }

  function drawKickBallEffects(frame) {
    // 足球：第3帧(frameIdx=2)时从宠物右下角被踢起
    // 帧0-1: 足球在右下角地面上（准备踢）
    // 帧2: 踢出瞬间
    // 帧3-5: 足球飞起弧线
    const ballSize = 14;
    ctx.save();
    ctx.imageSmoothingEnabled = false;

    // 足球位置轨迹
    let bx, by;
    if (frame <= 1) {
      // 足球在地面，宠物右下角
      bx = 120;
      by = 138;
    } else if (frame === 2) {
      // 踢出瞬间，刚离开脚
      bx = 128;
      by = 120;
    } else if (frame === 3) {
      // 飞起
      bx = 135;
      by = 90;
    } else if (frame === 4) {
      // 最高点
      bx = 140;
      by = 60;
    } else {
      // 落下/飞远
      bx = 148;
      by = 85;
    }

    // 绘制足球（像素风格）
    // 白色圆球
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(bx, by, ballSize / 2, 0, Math.PI * 2);
    ctx.fill();
    // 黑色轮廓
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(bx, by, ballSize / 2, 0, Math.PI * 2);
    ctx.stroke();
    // 五边形花纹
    ctx.fillStyle = '#333';
    const r2 = ballSize / 5;
    ctx.beginPath();
    ctx.arc(bx, by, r2, 0, Math.PI * 2);
    ctx.fill();
    // 小黑块装饰
    ctx.fillRect(bx - 5, by - 2, 2, 2);
    ctx.fillRect(bx + 3, by - 2, 2, 2);
    ctx.fillRect(bx - 1, by + 3, 2, 2);

    ctx.restore();
  }

  // 以下特效函数保留但不再主动调用（精灵表已自带画面）
  function drawCoffeeEffects(frame) {
    // 咖啡精灵表已包含完整画面，无需额外特效
  }

  function drawRainEffects(frame) {
    // 洗澡精灵表已包含完整画面，无需额外特效
  }

  function drawWorkingEffects(frame) {
    // working 精灵表已包含完整画面（含电脑），无需额外特效
  }

  function drawErrorEffects(frame) {
    ctx.fillStyle = '#e63946';
    ctx.font = 'bold 16px monospace';
    if (frame % 2 === 0) {
      ctx.fillText('!', 135, 25);
    }
    ctx.font = '14px serif';
    ctx.fillText('×', 52, 52);
    ctx.fillText('×', 100, 52);
  }

  function drawYawningEffects(frame) {
    if (frame > 0 && frame < 4) {
      ctx.fillStyle = `rgba(200, 200, 255, ${0.3 + frame * 0.1})`;
      ctx.beginPath();
      ctx.arc(135, 25 - frame * 5, 5 + frame * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ─── 渲染单帧 ───
  function drawSpriteFrame(animName, frame) {
    const config = getAnimConfig(animName);
    const sheet = spriteSheets[config.sheet];

    if (!sheet) {
      // 精灵表未加载，画一个占位符
      ctx.fillStyle = '#333';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('加载中...', W / 2, H / 2);
      ctx.textAlign = 'start';
      return;
    }

    // 使用每个动画配置的帧尺寸
    const fw = config.frameW || FRAME_W;
    const fh = config.frameH || FRAME_H;
    const frameIdx = frame % config.frames;

    // 从精灵表中取出该帧（整帧原样绘制，和预览一致）
    const sx = frameIdx * fw;
    const sy = 0;

    // 在160x160画布中居中绘制整帧（缩小30%）
    const scale = Math.min(104 / fw, 104 / fh);
    const drawW = fw * scale;
    const drawH = fh * scale;
    const dx = (W - drawW) / 2;
    const dy = (H - drawH) / 2 + 4;

    ctx.save();
    ctx.imageSmoothingEnabled = false;

    if (config.flipX) {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    }

    ctx.drawImage(sheet, sx, sy, fw, fh, dx, dy, drawW, drawH);
    ctx.restore();
  }

  // ─── 动画循环 ───
  function render(timestamp) {
    if (!frameTimer) frameTimer = timestamp;
    const config = getAnimConfig(currentAnim);

    if (timestamp - frameTimer >= config.speed) {
      frameTimer = timestamp;
      frameIndex = (frameIndex + 1) % config.frames;
    }

    ctx.clearRect(0, 0, W, H);

    if (spritesLoaded || qcLoaded) {
      drawSpriteFrame(currentAnim, frameIndex);
      drawOverlayEffects(currentAnim, frameIndex);
    }

    requestAnimationFrame(render);
  }

  // ─── 切换动画 ───
  function setAnimation(name) {
    if (name === currentAnim) return;
    
    // 优先查找 QC 动画
    if (qcAnimConfig[name]) {
      currentAnim = name;
      frameIndex = 0;
      frameTimer = 0;
      // 懒加载精灵表
      if (!spriteSheets[name]) {
        loadQCSheet(name);
      }
      return;
    }
    
    // 降级到原版动画
    if (ANIM_CONFIG[name]) {
      currentAnim = name;
      frameIndex = 0;
      frameTimer = 0;
    }
  }

  // ─── 获取当前动画配置（合并 QC + 原版） ───
  function getAnimConfig(animName) {
    return qcAnimConfig[animName] || ANIM_CONFIG[animName] || ANIM_CONFIG.idle;
  }

  // ─── 启动 ───
  function start() {
    loadSpriteSheets().then(async () => {
      console.log('🐧 原版精灵表加载完成');
      
      // 加载 QC 动画系统
      const qcOk = await loadQCManifest();
      if (qcOk) {
        // 预加载默认心情（peaceful）的核心动画
        await preloadMoodSheets('peaceful');
        await preloadMoodSheets('happy');
        qcLoaded = true;
        
        // 切换到 QC 的 idle 动画
        const stand = getQCStand('peaceful');
        if (stand) setAnimation(stand);
      }
      
      console.log('🐧 启动渲染循环');
      requestAnimationFrame(render);
    });
  }

  // ─── 动态注册新精灵表（后续添加更多动画时用） ───
  function registerSheet(name, path, animations) {
    SHEET_FILES[name] = path;
    const img = new Image();
    img.onload = () => {
      spriteSheets[name] = img;
      console.log(`🖼️ 新精灵表已注册: ${name}`);
      // 更新动画配置
      if (animations) {
        Object.entries(animations).forEach(([animName, config]) => {
          ANIM_CONFIG[animName] = { ...ANIM_CONFIG[animName], ...config, sheet: name };
        });
      }
    };
    img.src = path;
  }

  return {
    start,
    setAnimation,
    registerSheet,
    getFrameIndex() { return frameIndex; },
    get currentAnim() { return currentAnim; },
    // QC 动画接口
    get qcLoaded() { return qcLoaded; },
    getQCStand,
    getQCSpeak,
    getQCInteract,
    getQCPlay,
    getQCCommon,
    preloadMoodSheets,
    loadQCSheet,
    QC_POOLS,
    QC_COMMON,
  };
})();
