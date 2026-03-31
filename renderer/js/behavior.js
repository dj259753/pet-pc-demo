/* ═══════════════════════════════════════════
   企鹅行为引擎 - 自动走动 / 打哈欠 / 睡觉
   走动范围：整个应用窗口区域
   ═══════════════════════════════════════════ */

const BehaviorEngine = (() => {
  // ─── 行为状态 ───
  const BEHAVIOR = {
    IDLE: 'idle',
    WALKING: 'walking',
    YAWNING: 'yawning',
    SLEEPING: 'sleeping',
    PAUSED: 'paused',
    JUMPING: 'jumping',  // 开心跳跃
    WORKING: 'working',  // 工作中
  };

  let currentBehavior = BEHAVIOR.IDLE;
  let petContainer = null;

  // ─── 走动参数（全窗口范围） ───
  const PET_W = 160;
  const PET_H = 160;
  const WIN_W = 320;
  const WIN_H = 460;
  const TASKBAR_H = 0;
  const ITEMS_BAR_H = 70; // 底部物品栏高度

  // 走动边界
  const WALK_MIN_X = 0;
  const WALK_MAX_X = WIN_W - PET_W;
  const WALK_MIN_Y = 0;
  const WALK_MAX_Y = WIN_H - PET_H - TASKBAR_H - ITEMS_BAR_H;

  let posX = (WIN_W - PET_W) / 2;
  let posY = 200;
  let walkDirX = 1;   // 1=右, -1=左
  let walkDirY = 0;   // 0=不动, 1=下, -1=上
  let walkStepSize = 6;  // 每步走多少像素
  let walkStepInterval = null;  // 定格步进定时器

  // ─── 交互状态 ───
  let isMouseOver = false;
  let lastInteractionTime = Date.now();
  const YAWN_DELAY = 20000;
  const SLEEP_DELAY = 60000;

  // ─── 悬浮激活状态（双层） ───
  let isActivated = false;           // 是否已激活（显示动作栏）
  let hoverActivateTimer = null;     // 0.6s 激活计时器
  let hoverDeactivateTimer = null;   // 2s 失活计时器
  const ACTIVATE_DELAY = 600;        // 悬浮 0.6s 后激活
  const DEACTIVATE_DELAY = 1300;     // 离开 1.3s 后失活

  // ─── 定时器 ───
  let behaviorInterval = null;
  let walkAnimFrame = null;
  
  // ─── QC 自主动画定时器（贴近原版 22.5~52.5 秒） ───
  let qcIdleTimer = null;
  const QC_IDLE_MIN_DELAY = 30000;    // 最短30秒
  const QC_IDLE_MAX_DELAY = 120000;   // 最长120秒

  // 辅助：获取当前心情的 idle/stand 动画名
  function getIdleAnim() {
    if (typeof SpriteRenderer !== 'undefined' && SpriteRenderer.qcLoaded) {
      const mood = (typeof PetState !== 'undefined') ? (PetState.mood || 'peaceful') : 'peaceful';
      return SpriteRenderer.getQCStand(mood) || 'idle';
    }
    return 'idle';
  }

  // ─── 跳跃参数 ───
  let jumpBaseY = 0;
  let jumpVelocity = 0;
  let jumpCount = 0;
  let maxJumps = 3;
  let isJumping = false;
  let jumpCallback = null;

  // ─── 工作模块参数 ───
  const WORK_DURATION = 20 * 60 * 1000; // 20分钟
  const WORK_SWITCH_INTERVAL = 30000;   // 每30秒随机切换工作动画
  const WORK_COUNTDOWN_INTERVAL = 1000; // 每秒更新倒计时
  let workTimer = null;       // 工作总时长计时器
  let workSwitchTimer = null; // 切换动画定时器
  let workCountdownTimer = null; // 倒计时更新定时器
  let workStartTime = 0;      // 工作开始时间
  let isWorking = false;

  // 工作时的话语
  const WORK_PHRASES = [
    '认真工作中...💻',
    '代码写得好起劲！⌨️',
    'bug在哪里...🔍',
    '编译通过了！✅',
    '主人别打扰我，我在工作呢！',
    '敲键盘好累，但我会坚持的！💪',
    '还有好多代码要写...📝',
    '这个需求好难...🤯',
    '摸鱼？不存在的！我在认真工作！',
    '工作使我快乐！...才怪 😵',
    '主人加油，我们一起努力！💪',
    '专注专注...不要看手机！📵',
    '离休息还有一会儿，坚持住！',
  ];

  // ─── 初始化 ───
  function init() {
    petContainer = document.getElementById('pet-container');

    posX = (WIN_W - PET_W) / 2;
    posY = 200;
    updatePosition();

    // 监听宠物区域 + 动作栏区域的鼠标进出（统一激活区域）
    petContainer.addEventListener('mouseenter', onMouseEnter);
    petContainer.addEventListener('mouseleave', onMouseLeave);

    const actionBar = document.getElementById('hover-panel');
    if (actionBar) {
      actionBar.addEventListener('mouseenter', onMouseEnter);
      actionBar.addEventListener('mouseleave', onMouseLeave);
    }

    document.addEventListener('mousedown', resetInteractionTimer);
    document.addEventListener('keydown', resetInteractionTimer);

    behaviorInterval = setInterval(behaviorScheduler, 1000);

    // 启动 QC 自主动画调度
    scheduleQCIdleAnimation();

    // 启动后延迟，用 QC 自主动画代替原有的走动
    setTimeout(() => {
      if (currentBehavior === BEHAVIOR.IDLE && !isMouseOver) {
        // 不再走动，由 QC 自主动画调度器负责
      }
    }, 10000);
  }

  // ─── 行为调度器 ───
  function behaviorScheduler() {
    if (isMouseOver || currentBehavior === BEHAVIOR.PAUSED || currentBehavior === BEHAVIOR.JUMPING || currentBehavior === BEHAVIOR.WORKING) return;

    const elapsed = Date.now() - lastInteractionTime;

    if (currentBehavior === BEHAVIOR.SLEEPING) return;

    if (elapsed >= SLEEP_DELAY) {
      if (currentBehavior !== BEHAVIOR.SLEEPING) {
        startSleeping();
      }
      return;
    }

    if (elapsed >= YAWN_DELAY && currentBehavior === BEHAVIOR.WALKING) {
      startYawning();
      return;
    }
  }

  // ─── 走动逻辑（全窗口漫游） ───
  function startWalking() {
    if (currentBehavior === BEHAVIOR.SLEEPING) wakeUp();
    currentBehavior = BEHAVIOR.WALKING;

    // 随机方向
    walkDirX = Math.random() > 0.5 ? 1 : -1;
    // 随机决定是否也在Y轴移动
    const r = Math.random();
    if (r < 0.3) walkDirY = -1;       // 向上
    else if (r < 0.6) walkDirY = 1;   // 向下
    else walkDirY = 0;                  // 只水平走

    SpriteRenderer.setAnimation(walkDirX > 0 ? 'walk_right' : 'walk_left');

    // 停掉旧的步进定时器和动画帧
    clearInterval(walkStepInterval);
    cancelAnimationFrame(walkAnimFrame);

    // 用 setInterval 定格步进：每150ms走一步，和动画帧速度同步
    walkStepInterval = setInterval(walkStep, 150);
  }

  function walkStep() {
    if (currentBehavior !== BEHAVIOR.WALKING) {
      clearInterval(walkStepInterval);
      return;
    }

    posX += walkStepSize * walkDirX;
    posY += walkStepSize * walkDirY * 0.4;

    // X边界检测
    if (posX >= WALK_MAX_X) {
      posX = WALK_MAX_X;
      walkDirX = -1;
      SpriteRenderer.setAnimation('walk_left');
    } else if (posX <= WALK_MIN_X) {
      posX = WALK_MIN_X;
      walkDirX = 1;
      SpriteRenderer.setAnimation('walk_right');
    }

    // Y边界检测
    if (posY >= WALK_MAX_Y) {
      posY = WALK_MAX_Y;
      walkDirY = -1;
    } else if (posY <= WALK_MIN_Y) {
      posY = WALK_MIN_Y;
      walkDirY = 1;
    }

    // 随机换Y方向
    if (Math.random() < 0.08) {
      const r = Math.random();
      if (r < 0.25) walkDirY = -1;
      else if (r < 0.5) walkDirY = 1;
      else walkDirY = 0;
    }

    // 随机停下（每步20%概率，大部分时间站着不动）
    if (Math.random() < 0.20) {
      pauseWalkBriefly();
      return;
    }

    updatePosition();
  }

  function pauseWalkBriefly() {
    clearInterval(walkStepInterval);
    SpriteRenderer.setAnimation(getIdleAnim());
    // 停顿 8-20 秒（原来是 1.5-3.5s）
    setTimeout(() => {
      if (currentBehavior === BEHAVIOR.WALKING && !isMouseOver) {
        // 40% 概率彻底停下来不走了（切换到 IDLE）
        if (Math.random() < 0.40) {
          currentBehavior = BEHAVIOR.IDLE;
          resetToCenter(); // 回到窗口中心，避免后续自主动画在偏移位置播放
          // 过较长时间后才可能重新走动
          setTimeout(() => {
            if (currentBehavior === BEHAVIOR.IDLE && !isMouseOver) {
              if (Math.random() < 0.3) {
                startWalking();
              }
            }
          }, 15000 + Math.random() * 20000);  // 15-35 秒后再考虑走
          return;
        }
        if (Math.random() > 0.5) walkDirX *= -1;
        const r = Math.random();
        if (r < 0.3) walkDirY = -1;
        else if (r < 0.6) walkDirY = 1;
        else walkDirY = 0;
        SpriteRenderer.setAnimation(walkDirX > 0 ? 'walk_right' : 'walk_left');
        clearInterval(walkStepInterval);
        walkStepInterval = setInterval(walkStep, 150);
      }
    }, 8000 + Math.random() * 12000);
  }

  function stopWalking() {
    clearInterval(walkStepInterval);
    cancelAnimationFrame(walkAnimFrame);
    if (currentBehavior === BEHAVIOR.WALKING) {
      currentBehavior = BEHAVIOR.PAUSED;
      SpriteRenderer.setAnimation(getIdleAnim());
    }
    // 走完后回到窗口中心锚点，避免后续播放 play/interact 动画时企鹅偏到边上
    resetToCenter();
  }

  /** 把 pet-container 回到窗口中心默认位置 */
  function resetToCenter() {
    posX = (WIN_W - PET_W) / 2;  // 80
    posY = 200;
    updatePosition();
  }

  // ─── 开心跳跃 ───
  function startJumping(onComplete) {
    currentBehavior = BEHAVIOR.JUMPING;
    cancelAnimationFrame(walkAnimFrame);
    jumpBaseY = posY;
    jumpVelocity = -6;
    jumpCount = 0;
    maxJumps = 3;
    isJumping = true;
    jumpCallback = onComplete || null;
    SpriteRenderer.setAnimation('happy_jump');
    jumpLoop();
  }

  function jumpLoop() {
    if (!isJumping) return;

    jumpVelocity += 0.4; // 重力
    posY += jumpVelocity;

    // 落地检测
    if (posY >= jumpBaseY) {
      posY = jumpBaseY;
      jumpCount++;
      if (jumpCount >= maxJumps) {
        // 跳完了
        isJumping = false;
        currentBehavior = BEHAVIOR.PAUSED;
        SpriteRenderer.setAnimation(getIdleAnim());
        updatePosition();
        if (jumpCallback) jumpCallback();
        return;
      }
      // 继续跳
      jumpVelocity = -5 + jumpCount * 0.5; // 每次跳低一点
    }

    updatePosition();
    requestAnimationFrame(jumpLoop);
  }

  // ─── 打哈欠 ───
  function startYawning() {
    currentBehavior = BEHAVIOR.YAWNING;
    cancelAnimationFrame(walkAnimFrame);
    SpriteRenderer.setAnimation('yawning');

    setTimeout(() => {
      if (currentBehavior === BEHAVIOR.YAWNING && !isMouseOver) {
        startWalking();
      }
    }, 3000);
  }

  // ─── 工作模块 ───
  function startWorking(onComplete) {
    if (currentBehavior === BEHAVIOR.SLEEPING) wakeUp();
    currentBehavior = BEHAVIOR.WORKING;
    isWorking = true;
    workStartTime = Date.now();
    clearInterval(walkStepInterval);
    cancelAnimationFrame(walkAnimFrame);

    // 随机选择初始工作动画
    switchWorkingAnim();

    if (typeof PetDiary !== 'undefined') PetDiary.addEntry('work_start', '开始工作啦！💪');

    // 显示倒计时UI
    showWorkTimer();
    updateWorkCountdown();

    // 每秒更新倒计时
    workCountdownTimer = setInterval(() => {
      if (!isWorking) {
        clearInterval(workCountdownTimer);
        return;
      }
      updateWorkCountdown();
    }, WORK_COUNTDOWN_INTERVAL);

    // 每30秒随机切换工作动画 + 显示工作话语
    workSwitchTimer = setInterval(() => {
      if (!isWorking) {
        clearInterval(workSwitchTimer);
        return;
      }
      switchWorkingAnim();
      // 不弹气泡
    }, WORK_SWITCH_INTERVAL);

    // 20分钟后工作完成
    workTimer = setTimeout(() => {
      finishWorking(onComplete);
    }, WORK_DURATION);
  }

  function switchWorkingAnim() {
    // 随机选择 working_1 或 working_2
    const anim = Math.random() > 0.5 ? 'working_1' : 'working_2';
    SpriteRenderer.setAnimation(anim);
  }

  function finishWorking(onComplete) {
    isWorking = false;
    clearTimeout(workTimer);
    clearInterval(workSwitchTimer);
    clearInterval(workCountdownTimer);
    workTimer = null;
    workSwitchTimer = null;
    workCountdownTimer = null;

    // 隐藏倒计时UI
    hideWorkTimer();

    currentBehavior = BEHAVIOR.PAUSED;
    SpriteRenderer.setAnimation(getIdleAnim());
    if (typeof PetDiary !== 'undefined') PetDiary.addEntry('work_end', '工作完成！辛苦了～');

    // 工作完成增加精力消耗
    PetState.setStat('energy', PetState.stats.energy - 15);
    PetState.setStat('hunger', PetState.stats.hunger - 10);

    if (onComplete) {
      onComplete();
    } else {
      // 自动恢复行走
      setTimeout(() => {
        if (currentBehavior === BEHAVIOR.PAUSED && !isMouseOver) {
          startWalking();
        }
      }, 3000);
    }
  }

  function stopWorking() {
    if (!isWorking) return;
    isWorking = false;
    clearTimeout(workTimer);
    clearInterval(workSwitchTimer);
    clearInterval(workCountdownTimer);
    workTimer = null;
    workSwitchTimer = null;
    workCountdownTimer = null;

    // 隐藏倒计时UI
    hideWorkTimer();

    currentBehavior = BEHAVIOR.PAUSED;
    SpriteRenderer.setAnimation(getIdleAnim());

    // 按工作时长比例提示
    const worked = Date.now() - workStartTime;
    const workedMin = Math.floor(worked / 60000);
    const workedSec = Math.floor((worked % 60000) / 1000);
    if (worked > 10000) {
      // 不弹气泡
    }
  }

  function getWorkProgress() {
    if (!isWorking) return null;
    const elapsed = Date.now() - workStartTime;
    const remaining = Math.max(0, WORK_DURATION - elapsed);
    return {
      elapsed,
      remaining,
      progress: Math.min(elapsed / WORK_DURATION, 1),
    };
  }

  // ─── 倒计时UI控制（在按钮上显示） ───
  function showWorkTimer() {
    const btnTimer = document.getElementById('work-btn-timer');
    if (btnTimer) btnTimer.classList.add('active');
    // 顶部计时器不再使用
  }

  function hideWorkTimer() {
    const btnTimer = document.getElementById('work-btn-timer');
    if (btnTimer) {
      btnTimer.classList.remove('active', 'warning');
      btnTimer.textContent = '';
    }
  }

  function updateWorkCountdown() {
    const btnTimer = document.getElementById('work-btn-timer');
    if (!btnTimer) return;

    const elapsed = Date.now() - workStartTime;
    const remaining = Math.max(0, WORK_DURATION - elapsed);
    const progress = Math.min(elapsed / WORK_DURATION, 1) * 100;

    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    btnTimer.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    // 也更新旧的进度条（如果存在）
    const progressEl = document.getElementById('work-progress');
    if (progressEl) progressEl.style.width = `${progress}%`;

    // 最后1分钟变红色警告
    if (remaining <= 60000) {
      btnTimer.classList.add('warning');
    } else {
      btnTimer.classList.remove('warning');
    }
  }

  // ─── 睡觉 ───
  function startSleeping() {
    currentBehavior = BEHAVIOR.SLEEPING;
    cancelAnimationFrame(walkAnimFrame);
    SpriteRenderer.setAnimation('sleeping_lie');
    if (typeof PetDiary !== 'undefined') PetDiary.addEntry('sleep', '困了，打个盹~');
  }

  function wakeUp() {
    if (currentBehavior !== BEHAVIOR.SLEEPING) return;
    currentBehavior = BEHAVIOR.IDLE;
    SpriteRenderer.setAnimation(getIdleAnim());
    if (typeof PetDiary !== 'undefined') PetDiary.addEntry('wake', '睡醒了，精神满满！');
  }

  // ─── 鼠标交互（双层激活机制） ───
  function onMouseEnter() {
    isMouseOver = true;
    resetInteractionTimer();

    // 取消失活定时器（鼠标回来了）
    clearTimeout(hoverDeactivateTimer);
    hoverDeactivateTimer = null;

    if (currentBehavior === BEHAVIOR.SLEEPING) {
      wakeUp();
    } else if (currentBehavior === BEHAVIOR.WALKING) {
      stopWalking();
    }

    if (currentBehavior !== BEHAVIOR.SLEEPING && currentBehavior !== BEHAVIOR.JUMPING && currentBehavior !== BEHAVIOR.WORKING) {
      currentBehavior = BEHAVIOR.PAUSED;
      SpriteRenderer.setAnimation(getIdleAnim());
    }

    // 如果尚未激活 → 启动 1s 激活计时器
    if (!isActivated && !hoverActivateTimer) {
      hoverActivateTimer = setTimeout(() => {
        hoverActivateTimer = null;
        if (isMouseOver) {
          activate();
        }
      }, ACTIVATE_DELAY);
    }
  }

  function onMouseLeave() {
    isMouseOver = false;
    resetInteractionTimer();

    // 取消激活计时器（不到 1s 就离开了）
    clearTimeout(hoverActivateTimer);
    hoverActivateTimer = null;

    if (isActivated) {
      // 启动 2s 失活延迟
      clearTimeout(hoverDeactivateTimer);
      hoverDeactivateTimer = setTimeout(() => {
        hoverDeactivateTimer = null;
        if (!isMouseOver) {
          deactivate();
          // 只有 30% 概率恢复走路，其余时间原地待命
          if (currentBehavior === BEHAVIOR.PAUSED || currentBehavior === BEHAVIOR.IDLE) {
            if (Math.random() < 0.3) {
              startWalking();
            } else {
              currentBehavior = BEHAVIOR.IDLE;
              resetToCenter(); // 确保回到中心
            }
          }
        }
      }, DEACTIVATE_DELAY);
    } else {
      // 未激活状态：延迟更久恢复走动，且只有 30% 概率走
      setTimeout(() => {
        if (!isMouseOver && (currentBehavior === BEHAVIOR.PAUSED || currentBehavior === BEHAVIOR.IDLE)) {
          if (Math.random() < 0.3) {
            startWalking();
          }
        }
      }, 5000);
    }
  }

  // ─── 激活 / 失活 ───
  function activate() {
    if (isActivated) return;
    isActivated = true;
    showActionBar();
  }

  function deactivate() {
    if (!isActivated) return;
    isActivated = false;
    hideActionBar();
  }

  // ─── 浮动面板显隐（纯用 .visible class） ───
  function showActionBar() {
    const panel = document.getElementById('hover-panel');
    if (panel) {
      panel.classList.add('visible');
    }
  }

  function hideActionBar() {
    const panel = document.getElementById('hover-panel');
    if (panel) {
      panel.classList.remove('visible');
    }
  }

  // ─── 重置交互计时 ───
  function resetInteractionTimer() {
    lastInteractionTime = Date.now();
  }

  // ─── 更新位置 ───
  function updatePosition() {
    if (petContainer) {
      petContainer.style.left = posX + 'px';
      petContainer.style.top = posY + 'px';
      petContainer.style.transform = 'none';
    }
  }

  // ─── 获取当前位置 ───
  function getPosition() {
    return { x: posX, y: posY };
  }

  // ─── 外部接口 ───
  function notifyInteraction() {
    resetInteractionTimer();
    if (currentBehavior === BEHAVIOR.SLEEPING) {
      wakeUp();
    }
  }

  function pause() {
    clearInterval(walkStepInterval);
    cancelAnimationFrame(walkAnimFrame);
    if (currentBehavior === BEHAVIOR.WALKING) {
      currentBehavior = BEHAVIOR.PAUSED;
    }
    resetInteractionTimer();
  }

  function resume() {
    resetInteractionTimer();
    if (!isMouseOver && currentBehavior === BEHAVIOR.PAUSED) {
      // 较长延迟后才考虑恢复走动，且只有 30% 概率
      setTimeout(() => {
        if (!isMouseOver && currentBehavior === BEHAVIOR.PAUSED) {
          if (Math.random() < 0.3) {
            startWalking();
          } else {
            currentBehavior = BEHAVIOR.IDLE;
            resetToCenter(); // 确保回到中心
          }
        }
      }, 8000);
    }
  }

  // ─── QC 自主动画调度 ───
  function scheduleQCIdleAnimation() {
    const delay = QC_IDLE_MIN_DELAY + Math.random() * (QC_IDLE_MAX_DELAY - QC_IDLE_MIN_DELAY);
    qcIdleTimer = setTimeout(() => {
      playQCIdleAnimation();
      // 注意：不在这里立即 scheduleQCIdleAnimation()
      // 而是在动画播完的回调里调度下一个，确保间隔是从播完开始算
    }, delay);
  }

  function playQCIdleAnimation() {
    if (currentBehavior !== BEHAVIOR.IDLE && currentBehavior !== BEHAVIOR.PAUSED) { scheduleQCIdleAnimation(); return; }
    if (isMouseOver) { scheduleQCIdleAnimation(); return; }
    if (typeof SpriteRenderer === 'undefined' || !SpriteRenderer.qcLoaded) { scheduleQCIdleAnimation(); return; }
    // 吸附状态下不触发自主动画
    if (typeof EdgeSnap !== 'undefined' && EdgeSnap.isSnapped) { scheduleQCIdleAnimation(); return; }

    const mood = (typeof PetState !== 'undefined') ? (PetState.mood || 'peaceful') : 'peaceful';

    // ─── 原版逻辑：30% 说话 + 70% play 动画 ───
    const roll = Math.random() * 100;

    if (roll < 30) {
      // 30% 概率：播 Speak 动画 + AI 碎碎念
      const speakAnim = SpriteRenderer.getQCSpeak(mood);
      if (!speakAnim) { scheduleQCIdleAnimation(); return; }

      SpriteRenderer.loadQCSheet(speakAnim).then((img) => {
        if (!img) return;
        if (currentBehavior !== BEHAVIOR.IDLE && currentBehavior !== BEHAVIOR.PAUSED) return;
        if (isMouseOver) return;

        currentBehavior = BEHAVIOR.PAUSED;
        resetToCenter(); // 确保企鹅在窗口中心再播动画

        // 播 Speak 动画（播完回 Stand，然后重新调度下一次）
        SpriteRenderer.playOnce(speakAnim, () => {
          const stand = SpriteRenderer.getQCStand(mood);
          SpriteRenderer.setAnimation(stand || 'idle');
          currentBehavior = BEHAVIOR.IDLE;
          scheduleQCIdleAnimation(); // 播完后才计时下一次
        });

        // 同时触发 AI 碎碎念（异步，不阻塞动画）
        if (typeof AIBrain !== 'undefined') {
          AIBrain.speak('idle_mumble', {
            description: `宠物闲着没事自言自语，当前心情:${mood}`,
            constraint: '一句随机碎碎念，10-25字，可以是吐槽/感叹/自嗨/发呆感悟，不要@主人',
          }).then(reply => {
            if (reply && typeof BubbleSystem !== 'undefined') {
              BubbleSystem.show(reply, 3000);
            }
          }).catch(() => {});
        }
      });
    } else {
      // 70% 概率：播 play 池随机动画
      const playAnim = SpriteRenderer.getQCPlay(mood);
      if (!playAnim) { scheduleQCIdleAnimation(); return; }

      SpriteRenderer.loadQCSheet(playAnim).then((img) => {
        if (!img) return;
        if (currentBehavior !== BEHAVIOR.IDLE && currentBehavior !== BEHAVIOR.PAUSED) return;
        if (isMouseOver) return;

        currentBehavior = BEHAVIOR.PAUSED;
        resetToCenter(); // 确保企鹅在窗口中心再播动画

        // 用 playOnce 播完一遍后自动回 Stand
        SpriteRenderer.playOnce(playAnim, () => {
          const stand = SpriteRenderer.getQCStand(mood);
          SpriteRenderer.setAnimation(stand || 'idle');
          currentBehavior = BEHAVIOR.IDLE;
          scheduleQCIdleAnimation(); // 播完后才计时下一次
        });
      });
    }
  }

  return {
    init,
    get currentBehavior() { return currentBehavior; },
    get isActivated() { return isActivated; },
    getPosition,
    notifyInteraction,
    pause,
    resume,
    startJumping,
    startWorking,
    stopWorking,
    getWorkProgress,
    resetInteractionTimer,
    resetToCenter,
    deactivate,
    BEHAVIOR,
  };
})();
