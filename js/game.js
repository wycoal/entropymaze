/**
 * 游戏主控制器
 *
 * 职责：世界构建（迷宫 + 通道网络 + 能量球）、rAF 主循环、拖拽推进与摩擦累计、
 * 相触合并、统计拆分（累计量 / 瞬时量）、游戏结束判定。
 *
 * 与旧版最大的不同是引入了常驻的 requestAnimationFrame 主循环：
 * 移动推进、合并动画、耗散热光环全部由它驱动，渲染不再依赖事件触发，
 * 从根本上解决"合并动画只画首帧、看不到动画"的问题。
 */
class Game {
    constructor(config) {
        this.config = config;

        this.canvas = null;
        this.maze = null;
        this.corridor = null;
        this.physics = null;
        this.renderer = null;
        this.input = null;
        this.ui = null;

        /** 能量球 */
        this.blocks = [];
        this.mergeSerial = 0;

        /** 随机种子：重置时用同一颗种子复现同一局 */
        this.seed = 0;
        this.rng = Math.random;

        this.isPaused = false;
        this.isGameOver = false;

        /** 当前拾取会话：点击拾取 → 自由移动预览 → 再次点击确认 */
        this.carrying = null;
        /** 确认前的增量预览：纯计算结果，绝不影响真实状态 */
        this.preview = null;
        this.mergePreview = null;
        this.frictionAccum = 0;

        this.time = 0;
        this.lastTs = 0;

        this.stats = Game.createEmptyStats();
    }

    static createEmptyStats() {
        return {
            // 瞬时状态量（每帧由物理引擎重算）
            totalEnergy: 0,
            currentExergy: 0,
            systemEntropy: 0,
            // 累计量（只增不减，绝不被瞬时值覆盖）
            maxExergy: 0,
            unitExergy: 0,      // 单个能量单元的可用能最大值（瞬时）—— 胜利判据
            exergyDestroyed: 0,
            entropyGenerated: 0,
            frictionWork: 0,
            workExtracted: 0,   // 累计做功：只累计能量单元释放的功，不计入摩擦
            accumulator: 0,     // 蓄能器余额 = 初始储能 + 累计做功 − 累计摩擦功
            peakWork: 0,        // 单次做功的峰值（做功峰值，只增不减）
            heatRejected: 0,    // 做功时排给环境的热（= T0·S）
            travelDistance: 0,
            dragCount: 0,
            mergeCount: 0,
            // 基准量（每局开始记录，用于做功占比与能量审计）
            initialExergy: 0,
            initialEntropy: 0,
        };
    }

    /* ================= 初始化 ================= */

    init() {
        this.canvas = document.getElementById('gameCanvas');

        this.physics = new PhysicsEngine({
            specificHeat: this.config.specificHeat,
            gravity: this.config.gravity,
            frictionCoeff: this.config.frictionCoefficient,
            backgroundTemp: this.config.backgroundTemperature,
            maxTemperature: this.config.maxTemperature,
            minTemperature: this.config.backgroundTemperature,
        });

        this.ui = new UIManager();
        this.ui.setVictoryThreshold(this.config.unitExergyGoal);
        this.setupUIHandlers();

        this.buildWorld(createSeededRandomSeed());

        this.renderer = new Renderer(this.canvas, this.maze, this.corridor);
        this.renderer.updateDisplayOptions({
            showCenterline: this.config.showCenterline,
            showGrid: this.config.showGrid,
            showTemperature: this.config.showTemperature,
            showExergy: this.config.showExergy,
        });
        // 储能罐位于迷宫之外（画布右侧独立罐体）：光团以它为飞行目标 / 起点
        this.renderer.setAccumulatorElement(this.ui.tankEl);
        this.renderer.setTankElements(this.ui.tankEl, this.ui.tankLiquidEl, this.ui.tankValueEl);
        // 球体颜色只跟温度走：色标区间取 [T0, T_max]
        this.renderer._maxTemp = this.config.maxTemperature;
        this.renderer._minTemp = this.config.backgroundTemperature;
        this.input = new InputHandler(this.canvas, this);

        this.spawnBlocks();
        this.resetStats();
        this.updateStatistics();
        this.captureBaseline();

        this.startLoop();
    }

    setupUIHandlers() {
        this.ui.setButtonHandlers(
            () => this.newGame(),
            () => this.reset(),
            () => this.releaseWork()
        );

        this.ui.onBackgroundTempChange = (temp) => {
            this.physics.updateParams({ backgroundTemp: temp });
            this.updateStatistics();
        };

        this.ui.onFrictionCoeffChange = (coeff) => {
            this.physics.updateParams({ frictionCoeff: coeff });
        };

        // 蓄能器初始储能（0–1000 J）：滑块即时生效，余额按新初值重算
        this.ui.onAccumulatorInitialChange = (value) => {
            this.config.accumulatorInitial = value;
            if (this.ui.setAccumulatorValue) this.ui.setAccumulatorValue(value);
            this.updateStatistics();
        };

        this.ui.syncAccumulatorInitial(this.config.accumulatorInitial);

        this.ui.onRestart = () => this.newGame();
    }

    /** 构建（或重建）迷宫与通道网络 */
    buildWorld(seed) {
        this.seed = seed >>> 0;
        this.rng = createSeededRandom(this.seed);

        this.maze = new Maze(
            this.config.mazeCols,
            this.config.mazeRows,
            this.config.pitch,
            this.config.wallThickness,
            this.rng
        );
        this.corridor = new CorridorNetwork(this.maze);

        this.canvas.width = this.maze.width;
        this.canvas.height = this.maze.height;

        if (this.renderer) {
            this.renderer.maze = this.maze;
            this.renderer.corridor = this.corridor;
            this.renderer.invalidateStatic();
            this.renderer.animations = [];
            this.renderer.dissipations = [];
            this.renderer.orbs = [];
            this.renderer.mergeEffects = [];
        }
    }

    /** 生成能量球并沿通道网络散布（拒绝采样，保证开局不自动合并） */
    spawnBlocks() {
        const cfg = this.config;
        const count = cfg.blockCount;
        const masses = [];
        for (let i = 0; i < count; i++) {
            masses.push(cfg.minBlockMass + this.rng() * (cfg.maxBlockMass - cfg.minBlockMass));
        }

        const temperatures = this.physics.allocateTemperatures(masses, cfg.totalEnergy, this.rng);

        this.blocks = [];
        this.mergeSerial = 0;
        for (let i = 0; i < count; i++) {
            const block = new EnergyBlock(`block_${i}`, masses[i], temperatures[i], cfg.radiusUnit);
            block.updateColor(cfg.maxTemperature);
            this.placeBlock(block);
            this.blocks.push(block);
        }
    }

    placeBlock(block) {
        for (let attempt = 0; attempt < 300; attempt++) {
            const pos = this.corridor.randomPosition(this.rng);
            const p = this.corridor.pointAt(pos.segIdx, pos.t);
            let ok = true;
            for (const other of this.blocks) {
                if (Math.hypot(p.x - other.x, p.y - other.y) <= block.radius + other.radius + this.config.spawnGap) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                block.pos = pos;
                block.syncPosition(this.corridor);
                return true;
            }
        }
        const fallback = this.corridor.randomPosition(this.rng);
        block.pos = fallback;
        block.syncPosition(this.corridor);
        return false;
    }

    resetStats() {
        this.stats = Game.createEmptyStats();
        this.frictionAccum = 0;
        this.refreshAccumulator();   // 开局按配置的初始储能入账
    }

    /**
     * 蓄能器余额 = 初始储能 + 累计做功 − 累计摩擦功。
     * 初始值可由滑块随时调整（0–1000 J），所以每次都整体重算而非累加。
     */
    refreshAccumulator() {
        const initial = Number.isFinite(this.config.accumulatorInitial)
            ? this.config.accumulatorInitial : 0;
        this.stats.accumulator = initial + this.stats.workExtracted - this.stats.frictionWork;
        return this.stats.accumulator;
    }

    /**
     * 蓄能器余额是否足以支付 distance（米）的摩擦；不足时返回差额。
     * μ = 0 时本次需求为 0，此时即使余额为负也不拦停；
     * 留 1e-9 J 容差：余额与需求"刚好相等"时浮点尾差不应把玩家锁死。
     */
    accumulatorShortage(block, meters) {
        const need = this.physics.applyFriction(block, meters).work;
        if (need <= 1e-12) return 0;
        const diff = need - this.stats.accumulator;
        return diff > 1e-9 ? diff : 0;
    }

    /* ================= 局管理 ================= */

    newGame() {
        this.startRound(createSeededRandomSeed());
        this.ui.showMessage('新迷宫已生成，新游戏开始', 'success');
    }

    reset() {
        this.startRound(this.seed);
        this.ui.showMessage('已重置到本局初始状态', 'info');
    }

    startRound(seed) {
        this.buildWorld(seed);
        this.spawnBlocks();
        this.resetStats();
        this.isGameOver = false;
        this.isPaused = false;
        this.carrying = null;
        this.preview = null;
        this.mergePreview = null;
        this.setPausedClass(false);
        this.updateStatistics();
        this.captureBaseline();
        this.render();
    }

    togglePause() {
        this.isPaused = !this.isPaused;
        this.setPausedClass(this.isPaused);
    }

    /** 记录本局基准值：初始可用能与初始系统熵（做功占比、能量审计用） */
    captureBaseline() {
        this.stats.initialExergy = this.stats.currentExergy;
        this.stats.initialEntropy = this.stats.systemEntropy;
    }

    /* ===== 做功：只释放"最大可用能单体"的全部可用能 ===== */

    /**
     * 把一颗球可逆地放到环境基准态（T = T0），
     * 它的㶲全部转化为对外输出的功。其余球完全不动。
     *
     * 能量账：该球内能减少 Uᵢ —— 其中 Eᵢ 变成对外做功，
     * 余下 Uᵢ − Eᵢ = T0·Sᵢ 作为热排给环境（可逆过程，不产生熵）。
     * 因此恒有：剩余总内能 + 累计做功 + 累计排热 = 初始总内能。
     *
     * @param {EnergyBlock} [preferred] 指定「让这颗球做功」（双击用）；
     *        不给或给已消失的球时，退回默认口径：取可用能最大的那一颗。
     * @returns {boolean} 是否成功做功
     */
    releaseWork(preferred = null) {
        if (this.isGameOver) return false;
        if (this.isPaused) return false;

        // 指定了目标且仍然在场，就用它；否则退回"可用能最大的单体"
        let target = (preferred && !preferred.hidden && this.blocks.indexOf(preferred) >= 0)
            ? preferred : null;
        if (!target) {
            for (const b of this.blocks) {
                if (b.hidden) continue;
                if (!target || b.exergy > target.exergy) target = b;
            }
        }
        if (!target) return false;

        const work = target.exergy;            // 可逆放出：全部㶲 → 功
        const energy = target.internalEnergy;  // 该球此刻的内能
        if (!(work > 0.5)) {
            this.ui.showMessage(
                preferred ? '这颗球已无可释放的可用能（已处于环境态）' : '已无可释放的可用能',
                'info'
            );
            return false;
        }

        // 若正拖着这颗球，先解除拾取，避免释放后仍显示拖拽预览
        if (this.carrying && this.carrying.block === target) this.cancelCarry();

        // 降到环境温度（死态）：此后 U = S = E = 0，质量与半径不变
        target.temperature = this.physics.backgroundTemp;
        target.updateColor(this.physics.maxTemperature);

        this.stats.workExtracted += work;
        this.refreshAccumulator();          // 释放的功充入蓄能器
        this.stats.peakWork = Math.max(this.stats.peakWork, work); // 单次做功峰值
        this.stats.heatRejected += energy - work; // === T0 · Sᵢ

        // 爆炸规模由本次释放的可用能量决定
        this.renderer.addExplosion({
            x: target.x,
            y: target.y,
            r: target.radius,
            power: work,
        });

        // 金色光团从释放点飞向储能罐，表示可用能充入蓄能器
        this.renderer.spawnWorkOrbs(target.x, target.y, work);

        // 单次释放超过达标线 → 放一波烟花庆祝
        const goal = Number.isFinite(this.config.unitExergyGoal) ? this.config.unitExergyGoal : Infinity;
        const reached = work > goal;
        if (reached) {
            this.renderer.addFireworks({ x: target.x, y: target.y, power: work });
        }

        const ratio = this.stats.initialExergy > 0
            ? (work / this.stats.initialExergy) * 100
            : 0;
        this.ui.showMessage(
            `释放可用能 ${work.toFixed(0)} J（占初始可用能 ${ratio.toFixed(1)}%）`
            + (reached ? ` —— 超过 ${goal.toFixed(0)} J 达标线！` : ''),
            'success'
        );

        this.updateStatistics();
        // 若正拖着一颗球，预览要按新状态重算
        if (this.carrying) this.updateCarry(
            this.carrying.free.x + this.carrying.grab.x,
            this.carrying.free.y + this.carrying.grab.y
        );
        return true;
    }

    setPausedClass(paused) {
        const container = document.querySelector('.game-container');
        if (container) container.classList.toggle('game-paused', paused);
    }

    /* ===== 拾取 → 自由移动预览 → 点击确认 =====
     *
     * 与"按住拖拽"的根本区别：拾取与移动期间不产生任何物理过程，
     * 球的真实位置（通道参数 pos）保持不变，只做增量预览；
     * 只有再次点击确认时，才沿通道真实推进并累计摩擦耗散、触发合并。
     */

    pickBlockAt(px, py) {
        for (let i = this.blocks.length - 1; i >= 0; i--) {
            const b = this.blocks[i];
            if (!b.hidden && b.containsPoint(px, py)) return b;
        }
        return null;
    }

    /**
     * 点击拾取一颗球，此后它附着在指针上自由移动
     * @returns {boolean} 是否成功拾取
     */
    pickUp(block, px, py) {
        if (this.isPaused || this.isGameOver || !block || block.hidden) return false;
        if (this.carrying) return false;
        this.carrying = {
            block,
            grab: { x: px - block.x, y: py - block.y }, // 抓取偏移：点击大球边缘时圆心不跳到指针下
            free: { x: block.x, y: block.y },           // 自由跟随的圆心（可脱离通道，仅视觉）
            target: { x: block.x, y: block.y },         // 确认后真正落到的通道中心线位置
            targetPos: { segIdx: block.pos.segIdx, t: block.pos.t },
            path: null,
            traveled: 0,
            valid: true,
        };
        this.stats.dragCount++;
        this.updateCarry(px, py);
        return true;
    }

    /** 指针移动：球跟随指针，并刷新"若此刻确认会发生什么"的预览 */
    updateCarry(px, py) {
        const car = this.carrying;
        if (!car) return;

        car.free = {
            x: Math.max(0, Math.min(px - car.grab.x, this.maze.width)),
            y: Math.max(0, Math.min(py - car.grab.y, this.maze.height)),
        };

        const proj = this.corridor.projectPoint(car.free.x, car.free.y);
        car.target = { x: proj.x, y: proj.y };
        car.targetPos = { segIdx: proj.segIdx, t: proj.t };
        car.valid = proj.dist <= this.config.pitch * 0.95;
        car.path = this.corridor.buildPath(car.block.pos, car.targetPos);
        car.traveled = 0;

        this.updatePreview();
    }

    /** 放弃本次拾取（Esc / 新局 / 游戏结束） */
    cancelCarry() {
        this.carrying = null;
        this.preview = null;
        this.mergePreview = null;
    }

    /**
     * 再次点击：确认操作 —— 此刻才真正执行物理过程
     * @returns {boolean} 是否执行了确认
     */
    confirmCarry() {
        const car = this.carrying;
        if (!car) return false;
        if (this.isPaused || this.isGameOver) return false;

        const block = car.block;
        const meters = (car.path ? car.path.length : 0) / this.config.pixelsPerMeter;

        // 0) 蓄能器闸门：余额不足以支付本次摩擦 → 拒绝移动（不做半程结算）
        const shortage = this.accumulatorShortage(block, meters);
        if (shortage > 0) {
            this.ui.showMessage(
                `蓄能器不足：本次需 ${(this.stats.accumulator + shortage).toFixed(0)} J`
                + `，可用 ${this.stats.accumulator.toFixed(0)} J —— 请先「做功」补充`,
                'error'
            );
            return false;
        }

        // 1) 沿通道真实推进到落点，累计摩擦耗散（这一步才是物理过程）
        this.advanceAlongPath(car, car.path ? car.path.length : 0);
        // 2) 落点处与别的球相触则合并
        this.tryMerge(block);

        this.cancelCarry();
        this.updateStatistics();
        return true;
    }

    /**
     * 计算"若此刻确认"的全部增量预览。
     * physics.applyFriction 与 physics.merge 都是纯函数，故此处不改动任何真实状态。
     */
    updatePreview() {
        const car = this.carrying;
        if (!car) {
            this.preview = null;
            return;
        }

        const block = car.block;
        const meters = (car.path ? car.path.length : 0) / this.config.pixelsPerMeter;
        const friction = this.physics.applyFriction(block, meters);

        // 以落点为圆心判断是否会与某颗球相触
        let mergeWith = null;
        for (const other of this.blocks) {
            if (other === block || other.hidden) continue;
            if (Math.hypot(car.target.x - other.x, car.target.y - other.y) > block.radius + other.radius) continue;
            if (!this.config.mergeAcrossWalls &&
                this.corridor.pathDistance(car.targetPos, other.pos) > block.radius + other.radius) continue;
            mergeWith = other;
            break;
        }

        let merged = null;
        if (mergeWith) {
            const r = this.physics.merge(block, mergeWith);
            merged = {
                mass: r.newMass,
                temperature: r.finalTemperature,
                radius: this.config.radiusUnit * Math.sqrt(r.newMass),
                entropyGenerated: r.entropyGenerated,
                exergyDestroyed: r.exergyDestroyed,
            };
        }

        // 预览口径与实际记账一致：累计熵产 / 累计㶲损不含摩擦，摩擦另行单列
        this.preview = {
            meters,
            friction,
            mergeWith,
            merged,
            frictionWork: friction.work,
            entropyGenerated: merged ? merged.entropyGenerated : 0,
            exergyDestroyed: merged ? merged.exergyDestroyed : 0,
            accumulator: this.stats.accumulator,
            accumulatorAfter: this.stats.accumulator - friction.work,
            // 与 confirmCarry 同口径：只有真正付不起（含需求为 0 的情形）才算"不足"
            accumulatorBlocked: this.accumulatorShortage(block, meters) > 0,
        };
        this.mergePreview = mergeWith ? { a: block, b: mergeWith } : null;
    }

    /**
     * 沿行进折线最多推进 maxPx 像素，并按真实路径长度累计摩擦耗散
     * @returns {number} 实际推进的像素数
     */
    advanceAlongPath(session, maxPx) {
        if (!session || !session.path || maxPx <= 0) return 0;

        const block = session.block;
        const result = this.corridor.advance(session.path, session.traveled, maxPx);
        if (result.movedPx <= 0) return 0;

        session.traveled = result.traveled;
        block.pos = result.pos;
        block.syncPosition(this.corridor);

        const meters = result.movedPx / this.config.pixelsPerMeter;
        this.stats.travelDistance += meters;

        // 摩擦功全部耗散并排给环境：图块状态不变（不降低球的可用能）。
        // 摩擦的机械能来自系统之外，按新口径 **不计入** 累计熵产 / 累计㶲损，
        // 也不冲减「累计做功」（那只统计能量单元释放的功），
        // 而是从蓄能器里扣：accumulator = 初始储能 + 累计做功 − 累计摩擦功。
        const friction = this.physics.applyFriction(block, meters);
        this.stats.frictionWork += friction.work;
        this.refreshAccumulator();

        // 耗散热的视觉提示：每走一段距离扩散一圈光环
        this.frictionAccum += result.movedPx;
        if (this.frictionAccum >= 26) {
            this.frictionAccum = 0;
            this.renderer.addDissipation(block.x, block.y, block.radius);
            // 暗红光团飞出，表示摩擦耗散
            this.renderer.spawnFrictionOrbs(block.x, block.y, friction.work);
        }
        return result.movedPx;
    }

    /* ================= 合并 ================= */

    /** 落点处若与别的球相触则合并（仅由 confirmCarry 调用） */
    tryMerge(target) {
        const self = target || (this.carrying ? this.carrying.block : null);
        if (!self || self.hidden) return;

        for (let i = this.blocks.length - 1; i >= 0; i--) {
            const other = this.blocks[i];
            if (other === self || other.hidden) continue;

            let hit = self.touches(other);
            if (hit && !this.config.mergeAcrossWalls) {
                hit = this.corridor.pathDistance(self.pos, other.pos) <= self.radius + other.radius;
            }
            if (hit) {
                this.mergeBlocks(self, other);
                return;
            }
        }
    }

    mergeBlocks(a, b) {
        const cfg = this.config;
        const result = this.physics.merge(a, b);

        const snapshotA = {
            x: a.x, y: a.y, r: a.radius, gray: a.grayValue, exergy: a.exergy || 0,
            color: this.renderer.tempColorCss(a.temperature),
        };
        const snapshotB = {
            x: b.x, y: b.y, r: b.radius, gray: b.grayValue, exergy: b.exergy || 0,
            color: this.renderer.tempColorCss(b.temperature),
        };

        const merged = new EnergyBlock(
            `block_m${this.mergeSerial++}`,
            result.newMass,
            result.finalTemperature,
            cfg.radiusUnit
        );
        merged.updateColor(cfg.maxTemperature);
        merged.pos = { segIdx: a.pos.segIdx, t: a.pos.t };
        merged.syncPosition(this.corridor);
        merged.hidden = true;

        this.blocks = this.blocks.filter((x) => x !== a && x !== b);
        this.blocks.push(merged);

        this.stats.mergeCount++;
        this.stats.entropyGenerated += result.entropyGenerated;
        this.stats.exergyDestroyed += result.exergyDestroyed;

        this.renderer.addMergeAnimation({ a: snapshotA, b: snapshotB, target: merged });

        // 合并特效：显示可用能减少量 + 光团飞出消失
        this.renderer.addMergeEffect(
            snapshotA.x, snapshotA.y,
            snapshotB.x, snapshotB.y,
            result.exergyDestroyed,
            snapshotA.exergy,
            snapshotB.exergy
        );

        this.mergePreview = null;
    }

    /* ================= 统计 ================= */

    updateStatistics() {
        const totals = this.physics.summarize(this.blocks);
        this.stats.totalEnergy = totals.energy;
        this.stats.systemEntropy = totals.entropy;
        this.stats.currentExergy = totals.exergy;
        // 单个能量单元的可用能最大值：下一次「做功」能释放多少，上限就是它
        let unit = 0;
        for (const b of this.blocks) {
            if (b.exergy > unit) unit = b.exergy;
        }
        this.stats.unitExergy = unit;
        this.refreshAccumulator();
        if (totals.exergy > this.stats.maxExergy) {
            this.stats.maxExergy = totals.exergy;
        }
        this.ui.updateStats(this.stats);
        this.checkGameOver();
    }

    checkGameOver() {
        if (this.isGameOver) return; // 守卫：杜绝结算浮层重复叠加
        if (this.blocks.length <= 1) {
            this.isGameOver = true;
            this.cancelCarry();
            this.ui.showGameOver(this.stats);
        }
    }

    /* ================= 主循环 ================= */

    startLoop() {
        this.lastTs = performance.now();
        const tick = (ts) => {
            // 先排下一帧：即使本帧抛异常，循环也不会永久停摆（否则画面会整块冻住）
            requestAnimationFrame(tick);
            try {
                // 夹到 [0, 0.05]：既防止首帧/切后台后的巨大步长，也防止时间戳回退产生负 dt
                const dt = Math.min(Math.max((ts - this.lastTs) / 1000, 0), 0.05);
                this.lastTs = ts;
                this.time += dt * 1000;

                if (!this.isPaused) {
                    if (!this.isGameOver) {
                        this.update(dt);
                    }
                    // 即使已结束也要推进动画，否则最后一颗球会永远停在 hidden 状态
                    this.updateAnimations(dt);
                }
                this.render(dt);
            } catch (err) {
                console.error('[EntropyMaze] 主循环异常:', err);
            }
        };
        requestAnimationFrame(tick);
    }

    update(dt) {
        // 拾取与移动期间不做任何物理推进：
        // 摩擦耗散与合并只在 confirmCarry() 里发生，移动阶段纯预览
        this.updateAnimations(dt);
        this.updateStatistics();
    }

    updateAnimations(dt) {
        const list = this.renderer.animations;
        if (list.length === 0) return;
        for (const anim of list) {
            // 合并动画与做功爆炸各自带时长，缺省仍用合并动画时长
            anim.progress += dt / (anim.duration || this.config.mergeAnimDuration);
        }
        this.renderer.animations = list.filter((anim) => {
            if (anim.progress >= 1) {
                if (anim.target) anim.target.hidden = false;
                return false;
            }
            return true;
        });
    }

    render(dt = 0) {
        const car = this.carrying;
        this.renderer.draw({
            blocks: this.blocks,
            selected: car ? car.block : null,
            carry: car
                ? {
                      block: car.block,
                      free: car.free,
                      target: car.target,
                      path: car.path,
                      valid: car.valid,
                  }
                : null,
            preview: this.preview,
            mergePreview: this.mergePreview,
            accumulator: this.stats.accumulator,
            time: this.time,
            dt,
        });
    }

    /* ================= 调试 ================= */

    debugSnapshot() {
        return {
            seed: this.seed,
            isPaused: this.isPaused,
            isGameOver: this.isGameOver,
            maze: this.maze.validate(),
            corridorSegments: this.corridor.segments.length,
            blocks: this.blocks.length,
            stats: this.stats,
        };
    }
}
