/* 临时核验：双击某颗球 → 该球直接做功。跑完删除。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const els = new Map();
function makeEl(id = '') {
    return {
        id, textContent: '', innerHTML: '', className: '', style: {}, dataset: {},
        children: [], value: '', width: 728, height: 568, checked: false,
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        appendChild(c) { this.children.push(c); return c; },
        removeChild() {}, contains() { return false; },
        closest() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 728, height: 568, right: 728, bottom: 568 }; },
        getContext() { return CTX; },
        setAttribute() {}, getAttribute() { return null; }, focus() {}, blur() {}, remove() {},
        setPointerCapture() {}, releasePointerCapture() {},
    };
}
const CTX = new Proxy({}, {
    get(t, k) {
        if (k === 'measureText') return () => ({ width: 10 });
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
        if (k === 'canvas') return makeEl('canvas');
        if (k in t) return t[k];
        return () => undefined;
    },
    set(t, k, v) { t[k] = v; return true; },
});
globalThis.document = {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    createElement() { return makeEl(); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    body: makeEl('body'), documentElement: makeEl('html'),
};
globalThis.window = {
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    addEventListener() {}, removeEventListener() {},
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 900,
};
globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = () => 0;
// 可控时钟：便于精确跨过/不跨过双击窗口
let clock = 1000;
globalThis.performance = { now: () => clock };

for (const f of ['block.js', 'maze.js', 'corridor.js', 'physics.js', 'renderer.js', 'input.js', 'ui.js', 'game.js', 'main.js']) {
    vm.runInThisContext(fs.readFileSync(path.join(__dirname, 'js', f), 'utf8'), { filename: f });
}

let fails = 0;
const check = (n, ok, d) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? '  [' + d + ']' : ''}`); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const CONFIG = {
    mazeCols: 18, mazeRows: 14, pitch: 40, wallThickness: 8,
    blockCount: 15, minBlockMass: 4, maxBlockMass: 9, radiusUnit: 5.5, spawnGap: 8,
    backgroundTemperature: 20, maxTemperature: 300, totalEnergy: 10000,
    specificHeat: 1.0, gravity: 9.81, frictionCoefficient: 0.15, pixelsPerMeter: 40,
    accumulatorInitial: 500, unitExergyGoal: 300,
    mergeAnimDuration: 0.45, mergeAcrossWalls: true,
    showCenterline: true, showGrid: true, showTemperature: true, showExergy: true,
};

const game = new Game(CONFIG);
game.init();
const canvas = document.getElementById('gameCanvas');
const input = new InputHandler(canvas, game);

// 道具：一颗"小"球（可用能最小），用来验证它也能被点名做功
const sorted = [...game.blocks].sort((a, b) => a.exergy - b.exergy);
const small = sorted[0];
const biggest = sorted[sorted.length - 1];
game.updateStatistics();
console.log(`  最小 ${small.exergy.toFixed(1)} J ／ 最大 ${biggest.exergy.toFixed(1)} J`);
check('小球确实不是最大可用能那颗', small !== biggest && small.exergy < biggest.exergy);
check('小球的可用能足以释放', small.exergy > 0.5, small.exergy.toFixed(1));

console.log('\n=== 1. 双击小球 → 让它（而非最大的那颗）做功 ===');
const x = small.x, y = small.y;
const w0 = game.stats.workExtracted;
const expectSmall = small.exergy;

clock = 1000;
input.tap(x, y);                     // 第一次点击 → 拾取
check('第一次点击只是拾取', game.carrying && game.carrying.block === small && near(game.stats.workExtracted, w0),
    game.stats.workExtracted);

clock = 1100;                        // 间隔 100 ms —— 窗口内
input.tap(x, y);                     // 第二次点击 → 双击，直接做功
const released = game.stats.workExtracted - w0;
console.log(`  累计做功 ${w0.toFixed(1)} → ${game.stats.workExtracted.toFixed(1)} J（本次 ${released.toFixed(1)} J）`);
check('做功已执行', released > 0, released.toFixed(1));
check('释放的正是双击的那颗小球', near(released, expectSmall, 1e-6), `${released.toFixed(2)} vs ${expectSmall.toFixed(2)}`);
check('最大的那颗未被释放', near(biggest.exergy, expectSmall === biggest.exergy ? biggest.exergy : biggest.exergy)
    && biggest.temperature > game.config.backgroundTemperature, biggest.temperature.toFixed(1));
check('小球降到环境温度（死态）', small.temperature === CONFIG.backgroundTemperature, small.temperature);
check('双击后拾取状态已解除', game.carrying === null);
check('预览也已清空', game.preview === null && game.mergePreview === null);
check('做功峰值记录到本次释放', near(game.stats.peakWork, released, 1e-6), game.stats.peakWork.toFixed(2));

console.log('\n=== 2. 间隔超时 / 落点偏离 → 不当双击，按原语义走 ===');
const b2 = game.blocks.find((bb) => !bb.hidden && bb.exergy > 0.5 && bb !== small);
const t0Birja = game.stats.workExtracted;

clock = 2000;
input.tap(b2.x, b2.y);                // 拾取
clock = 2000 + 500;                   // 500 ms > 350 ms
input.tap(b2.x, b2.y);                // 应为"确认"而非双击释放
check('超时后仍是确认移动语义（未做功）', near(game.stats.workExtracted, t0Birja, 1e-9), game.stats.workExtracted);
if (game.carrying) game.cancelCarry();

clock = 3000;
input.tap(b2.x, b2.y);                // 拾取
clock = 3100;                         // 100 ms 内，但落点偏 40 px
input.tap(b2.x + 40, b2.y);
check('落点偏离过大不当双击（未做功）', near(game.stats.workExtracted, t0Birja, 1e-9), game.stats.workExtracted);
if (game.carrying) game.cancelCarry();

console.log('\n=== 3. 点到不同球不算双击 ===');
const b3 = game.blocks.find((bb) => !bb.hidden && bb.exergy > 0.5 && bb !== small && bb !== b2);
const w3 = game.stats.workExtracted;
clock = 4000;
input.tap(b2.x, b2.y);
clock = 4100;
input.tap(b3.x, b3.y);                // 另一颗球
check('两颗不同球之间没有双击', near(game.stats.workExtracted, w3, 1e-9), game.stats.workExtracted);
if (game.carrying) game.cancelCarry();

console.log('\n=== 4. 直接调用 releaseWork —— 指定目标与默认口径 ===');
const b4 = game.blocks.find((bb) => !bb.hidden && bb.exergy > 0.5);
const expect4 = b4.exergy;
const w4 = game.stats.workExtracted;
game.releaseWork(b4);
check('指定目标：释放的正是它', near(game.stats.workExtracted - w4, expect4, 1e-6), expect4.toFixed(2));

const w5 = game.stats.workExtracted;
const maxLeft = Math.max(...game.blocks.filter((bb) => !bb.hidden).map((bb) => bb.exergy));
game.releaseWork();                   // 不指定 → 取最大
check('不指定目标：释放可用能最大的那颗', near(game.stats.workExtracted - w5, maxLeft, 1e-6),
    `${(game.stats.workExtracted - w5).toFixed(2)} vs ${maxLeft.toFixed(2)}`);

console.log('\n=== 5. 边界：对已死球双击不做功 ===');
const w6 = game.stats.workExtracted;
input.lastTap = null;
clock = 5000;
input.tap(small.x, small.y);
clock = 5100;
input.tap(small.x, small.y);
check('双击已释放过的球 → 不做功', near(game.stats.workExtracted, w6, 1e-9), game.stats.workExtracted);
check('给出「已无可释放」提示', document.body.children.some((c) => /已无可释放的可用能/.test(c.textContent)));

console.log('\n=== 6. 能量账仍守恒 ===');
check('剩余内能 + 累计做功 + 排热 = 10000 J',
    near(game.stats.totalEnergy + game.stats.workExtracted + game.stats.heatRejected, 10000, 1e-6),
    (game.stats.totalEnergy + game.stats.workExtracted + game.stats.heatRejected).toFixed(6));

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
if (fails) process.exit(1);
