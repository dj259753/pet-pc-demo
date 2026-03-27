/* ═══════════════════════════════════════════
   宠物状态机 - 核心养成数据模型
   ═══════════════════════════════════════════ */

const PetState = (() => {
  // ─── 核心数值 ───
  const stats = {
    hunger: 80,    // 饥饿值 0-100（越高越饱）
    clean: 70,     // 清洁值 0-100
    energy: 90,    // 精力值 0-100
  };

  // ─── 物品库存 ───
  const inventory = {
    cookie: 10,    // 饼干
    soap: 5,       // 肥皂
    coffee: 8,     // 咖啡
    toy: 3,        // 玩具
  };

  // ─── 状态枚举 ───
  const STATES = {
    IDLE: 'idle',
    EATING: 'eating',
    WASHING: 'washing',
    WORKING: 'working',
    SLEEPING: 'sleeping',
    HAPPY: 'happy',
    SAD: 'sad',
    THINKING: 'thinking',
    TALKING: 'talking',
    ERROR: 'error',
  };

  // ─── 心情枚举（QC 5级情绪） ───
  const MOODS = {
    HAPPY: 'happy',
    PEACEFUL: 'peaceful',
    UPSET: 'upset',
    SAD: 'sad',
    PROSTRATE: 'prostrate',
  };

  let currentState = STATES.IDLE;
  let currentMood = MOODS.PEACEFUL;  // 默认心情：平静
  let stateLockedUntil = 0;

  // ─── 数值衰减配置 ───
  const DECAY_RATES = {
    hunger: 0.8,   // 每分钟下降
    clean: 0.5,
    energy: 0.6,
  };

  // ─── 事件监听 ───
  const listeners = {};

  function emit(event, data) {
    if (listeners[event]) {
      listeners[event].forEach(fn => fn(data));
    }
  }

  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
  }

  // ─── 数值变更 ───
  function setStat(key, value) {
    const old = stats[key];
    stats[key] = Math.max(0, Math.min(100, Math.round(value)));
    if (old !== stats[key]) {
      emit('stat-change', { key, value: stats[key], old });
      // 低数值警告
      if (stats[key] <= 20 && old > 20) {
        emit('low-warning', { key, value: stats[key] });
      }
    }
  }

  // ─── 状态切换 ───
  function setState(newState, lockMs = 0) {
    if (Date.now() < stateLockedUntil && lockMs === 0) return;
    const old = currentState;
    currentState = newState;
    if (lockMs > 0) stateLockedUntil = Date.now() + lockMs;
    emit('state-change', { state: newState, old });
  }

  // ─── 自然衰减（每分钟调用一次） ───
  function decay() {
    // 番茄钟工作期间 hunger 额外消耗
    const focusExtra = (typeof FocusMode !== 'undefined' && FocusMode.isActive) ? 1.0 : 0;
    setStat('hunger', stats.hunger - DECAY_RATES.hunger - focusExtra);
    setStat('clean', stats.clean - DECAY_RATES.clean);
    setStat('energy', stats.energy - DECAY_RATES.energy);
    // 根据数值自动判断状态
    autoState();
    // 同步衰减 Personality 情绪
    if (typeof Personality !== 'undefined') Personality.decayMood();
  }

  // ─── 自动状态判断 ───
  function autoState() {
    if (Date.now() < stateLockedUntil) return;
    if (stats.hunger <= 10 || stats.clean <= 10 || stats.energy <= 10) {
      setState(STATES.SAD);
    } else if (stats.hunger >= 80 && stats.clean >= 80 && stats.energy >= 80) {
      setState(STATES.HAPPY);
    } else {
      setState(STATES.IDLE);
    }
    // 同步更新心情
    updateMood();
  }

  // ─── 心情计算（QC 5级情绪） ───
  function updateMood() {
    const { hunger, clean, energy } = stats;
    const avg = (hunger + clean + energy) / 3;
    let newMood;

    if (hunger <= 10 || clean <= 10 || energy <= 10) {
      newMood = MOODS.SAD;
    } else if (avg <= 30) {
      newMood = MOODS.UPSET;
    } else if (avg >= 75 && hunger >= 60 && clean >= 60 && energy >= 60) {
      newMood = MOODS.HAPPY;
    } else {
      newMood = MOODS.PEACEFUL;
    }

    if (newMood !== currentMood) {
      const old = currentMood;
      currentMood = newMood;
      emit('mood-change', { mood: newMood, old });
    }
  }

  // ─── 喂食 ───
  function feed() {
    if (inventory.cookie <= 0) return false;
    inventory.cookie--;
    setStat('hunger', stats.hunger + 20);
    setState(STATES.EATING, 1500);
    emit('action', { type: 'feed' });
    emit('inventory-change', { item: 'cookie', count: inventory.cookie });
    // 接入 AI 驱动系统
    if (typeof Personality !== 'undefined') Personality.onEvent('fed');
    if (typeof PetMemory !== 'undefined') PetMemory.addEvent('fed', '被喂了小鱼~');
    return true;
  }

  // ─── 清洗 ───
  function wash() {
    if (inventory.soap <= 0) return false;
    inventory.soap--;
    setStat('clean', stats.clean + 25);
    setState(STATES.WASHING, 1200);
    emit('action', { type: 'wash' });
    emit('inventory-change', { item: 'soap', count: inventory.soap });
    if (typeof Personality !== 'undefined') Personality.onEvent('washed');
    if (typeof PetMemory !== 'undefined') PetMemory.addEvent('washed', '洗了个舒服的澡~');
    return true;
  }

  // ─── 喝咖啡 ───
  function drinkCoffee() {
    if (inventory.coffee <= 0) return false;
    inventory.coffee--;
    setStat('energy', stats.energy + 30);
    setState(STATES.HAPPY, 1000);
    emit('action', { type: 'coffee' });
    emit('inventory-change', { item: 'coffee', count: inventory.coffee });
    return true;
  }

  // ─── 玩耍 ───
  function play() {
    if (inventory.toy <= 0) return false;
    inventory.toy--;
    setStat('hunger', stats.hunger - 5); // 玩耍消耗体力
    setStat('energy', stats.energy - 10);
    setState(STATES.HAPPY, 2000);
    emit('action', { type: 'play' });
    emit('inventory-change', { item: 'toy', count: inventory.toy });
    if (typeof Personality !== 'undefined') Personality.onEvent('played');
    if (typeof PetMemory !== 'undefined') PetMemory.addEvent('played', '玩了一会儿球~');
    return true;
  }

  // ─── 系统联动：CPU 高时强制工作 ───
  function forceWorking() {
    setState(STATES.WORKING, 5000);
    setStat('energy', stats.energy - 5);
    emit('action', { type: 'force-working' });
  }

  return {
    stats,
    inventory,
    STATES,
    MOODS,
    get state() { return currentState; },
    get mood() { return currentMood; },
    on,
    emit,
    setStat,
    setState,
    decay,
    feed,
    wash,
    drinkCoffee,
    play,
    forceWorking,
    autoState,
    updateMood,
  };
})();
