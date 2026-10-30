/**
 * 主入口 —— 配置、种子随机源、快捷键、调试接口
 */

const GAME_CONFIG = {
    /* ---- 迷宫几何：格距 pitch，墙厚 wallThickness ---- */
    mazeCols: 18,
    mazeRows: 14,
    pitch: 40,          // 相邻格心间距（像素），同时作为 1 米
    wallThickness: 8,   // 薄墙厚度（像素）

    /* ---- 能量球 ---- */
    blockCount: 15,
    minBlockMass: 4,    // 半径 = radiusUnit * sqrt(mass)
    maxBlockMass: 9,
    radiusUnit: 11,         // radius = radiusUnit * sqrt(mass)，放大两倍
    spawnGap: 8,        // 初始散布时的最小额外间距（像素）

    /* ---- 温度与能量 ---- */
    backgroundTemperature: 20, // 环境温度 T0（°C），同时作为温度下限
    maxTemperature: 300,       // 温度上限（°C），映射到纯白
    totalEnergy: 10000,        // 系统总内能（J），全程守恒

    /* ---- 物理参数 ---- */
    specificHeat: 1.0,
    gravity: 9.81,
    frictionCoefficient: 0.15,
    pixelsPerMeter: 40,        // 与 pitch 一致：一格 = 一米

    /* ---- 交互 ---- */
    accumulatorInitial: 500,   // 蓄能器初始储能（J），可在 0–1000 间由滑块调整
    unitExergyGoal: 300,    // 单个能量单元可用能达标线（J）：超过则"单元可用能"改用胜利色
    mergeAnimDuration: 0.45,   // 合并动画时长（秒）
    mergeAcrossWalls: true,    // 允许圆形隔着薄墙相触即合

    /* ---- 显示（全部默认开启，无需手动勾选） ---- */
    showCenterline: true,
    showGrid: true,
    showTemperature: true,
    showExergy: true,
};

/** 全局游戏实例 */
let game = null;

/**
 * 轻量可复现随机源（mulberry32）—— 不引入任何依赖，
 * 使得"重置"能用同一颗种子复现同一座迷宫与同一批能量球。
 */
function createSeededRandom(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function createSeededRandomSeed() {
    return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

window.addEventListener('DOMContentLoaded', () => {
    game = new Game(GAME_CONFIG);
    game.init();

    setupKeyboardShortcuts();

    setTimeout(() => {
        game.ui.showMessage('点击拾取能量球，移动后再次点击确认执行', 'info');
    }, 500);
});

/** 键盘快捷键 */
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

        switch (e.key.toLowerCase()) {
            case 'n':
                game.newGame();
                break;
            case 'r':
                game.reset();
                break;
            case 'w':
                game.releaseWork(); // 释放最大可用能单体的全部可用能
                break;
            case 'p':
            case ' ':
                e.preventDefault();
                if (document.activeElement && document.activeElement.blur) {
                    document.activeElement.blur();
                }
                game.togglePause();
                break;
            case 'escape':
                game.cancelCarry(); // 放弃本次拾取
                break;
            default:
                break;
        }
    });
}

/** 调试工具（在控制台中使用 window.debug.*） */
window.debug = {
    state: () => console.log('游戏状态:', game.debugSnapshot()),
    blocks: () => console.table(game.blocks.map((b) => b.getInfo())),
    physics: () => console.log('物理参数:', {
        specificHeat: game.physics.specificHeat,
        frictionCoeff: game.physics.frictionCoeff,
        backgroundTemp: game.physics.backgroundTemp,
        T0: game.physics.T0,
    }),
    maze: () => console.log('迷宫自检:', game.maze.validate()),
    corridor: () => console.log('通道网络:', {
        segments: game.corridor.segments.length,
        totalLength: game.corridor.totalLength,
    }),
    /**
     * 能量审计：四条恒等式
     *  1) 累计㶲损 = T0 × 累计熵产（Gouy-Stodola；两者均只含合并，不含摩擦）
     *  2) 剩余内能 + 累计做功 + 累计排热 = 初始内能
     *  3) ΔE = ΔU − T0·ΔS_sys（广义㶲平衡；未做功时退化为 ΔE = −T0·ΔS）
     *  4) 可用能下降 = 累计做功 + 累计㶲损（摩擦已从净做功中扣除，故不再出现在这里）
     */
    verify: () => {
        const s = game.stats;
        const T0 = game.physics.T0;
        const U0 = game.config.totalEnergy;

        const gs = PhysicsEngine.gouyStodolaError(s.exergyDestroyed, s.entropyGenerated, T0);
        const budget = (s.totalEnergy + s.workExtracted + s.heatRejected) - U0;
        const exergyBalance = (s.currentExergy - s.initialExergy)
            - ((s.totalEnergy - U0) - T0 * (s.systemEntropy - s.initialEntropy));
        const lossBalance = (s.initialExergy - s.currentExergy)
            - (s.workExtracted + s.exergyDestroyed);

        console.log('1) 㶲损 vs T0×熵产 相对偏差:', gs);
        console.log('2) 能量预算残差 (U+W+Q) − U₀:', budget);
        console.log('3) 广义㶲平衡 ΔE − (ΔU − T0·ΔS):', exergyBalance);
        console.log('4) 可用能下降 − (累计做功 + 累计㶲损):', lossBalance);
        return { gs, budget, exergyBalance, lossBalance };
    },
    reset: () => game.reset(),
    newGame: () => game.newGame(),
};

// 兼容模块系统（若将来接入打包工具）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        Game,
        Maze,
        CorridorNetwork,
        EnergyBlock,
        PhysicsEngine,
        Renderer,
        InputHandler,
        UIManager,
    };
}
