/**
 * UI 管理类
 *
 * 负责：统计面板数值刷新（含变化高亮）、控制面板事件绑定、消息提示、结算浮层。
 *
 * 统计口径分为三类，界面与 Game.stats 一一对应：
 *  - 瞬时量（每帧重算）：总内能、当前可用能、系统熵
 *  - 累计量（只增不减）：累计做功、累计㶲损、累计熵产、累计摩擦功、移动距离、合并次数
 *  - 基准量（每局开始记录）：初始可用能，用于做功占比
 */
class UIManager {
    constructor() {
        // 统计面板
        this.totalEnergyEl = document.getElementById('totalEnergy');
        this.currentExergyEl = document.getElementById('currentExergy');
        this.unitExergyEl = document.getElementById('unitExergy');
        this.maxExergyEl = document.getElementById('maxExergy');
        this.exergyDestroyedEl = document.getElementById('exergyDestroyed');
        this.entropyGeneratedEl = document.getElementById('entropyGenerated');
        this.systemEntropyEl = document.getElementById('systemEntropy');
        this.workExtractedEl = document.getElementById('workExtracted');
        this.accumulatorEl = document.getElementById('accumulator');

        // 储能罐（位于迷宫之外）：罐体 / 液位 / 读数
        this.tankEl = document.getElementById('energyTank');
        this.tankLiquidEl = document.getElementById('tankLiquid');
        this.tankValueEl = document.getElementById('tankValue');
        this.peakWorkEl = document.getElementById('peakWork');
        this.peakWorkRatioEl = document.getElementById('peakWorkRatio');
        this.travelDistanceEl = document.getElementById('travelDistance');
        this.mergeCountEl = document.getElementById('mergeCount');

        // 控制面板
        this.btnNewGame = document.getElementById('btnNewGame');
        this.btnReset = document.getElementById('btnReset');
        this.btnWork = document.getElementById('btnWork');
        this.backgroundTempSlider = document.getElementById('backgroundTemp');
        this.backgroundTempValue = document.getElementById('backgroundTempValue');
        this.frictionCoeffSlider = document.getElementById('frictionCoeff');
        this.frictionCoeffValue = document.getElementById('frictionCoeffValue');
        this.accumulatorSlider = document.getElementById('accumulatorInitial');
        this.accumulatorValueEl = document.getElementById('accumulatorInitialValue');

        /** 单个能量单元可用能的达标线（J）：超过则"单元可用能"改用胜利色显示 */
        this.victoryThreshold = Infinity;

        /** 由 Game 注入的回调 */
        this.onBackgroundTempChange = null;
        this.onFrictionCoeffChange = null;
        this.onAccumulatorInitialChange = null;

        this.bindEvents();
    }

    bindEvents() {
        this.backgroundTempSlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            this.backgroundTempValue.textContent = `${value}°C`;
            if (this.onBackgroundTempChange) this.onBackgroundTempChange(value);
        });

        this.frictionCoeffSlider.addEventListener('input', (e) => {
            const value = (parseFloat(e.target.value) / 100).toFixed(2);
            this.frictionCoeffValue.textContent = value;
            if (this.onFrictionCoeffChange) this.onFrictionCoeffChange(parseFloat(value));
        });

        this.accumulatorSlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            this.setAccumulatorValue(value);
            if (this.onAccumulatorInitialChange) this.onAccumulatorInitialChange(value);
        });
    }

    /** 把滑块与读数对齐到给定初值（0–1000 J） */
    syncAccumulatorInitial(value) {
        this.accumulatorSlider.value = String(value);
        this.setAccumulatorValue(value);
    }

    setAccumulatorValue(value) {
        this.accumulatorValueEl.textContent = `${value.toFixed(0)} J`;
    }

    /** 设置达标线（0 或非法值表示不设限） */
    setVictoryThreshold(value) {
        this.victoryThreshold = Number.isFinite(value) && value > 0 ? value : Infinity;
    }

    setButtonHandlers(onNewGame, onReset, onWork) {
        this.btnNewGame.addEventListener('click', onNewGame);
        this.btnReset.addEventListener('click', onReset);
        this.btnWork.addEventListener('click', onWork);
    }

    /* ---------------- 统计 ---------------- */

    updateStats(stats) {
        // 「累计做功」只累计能量单元释放的功；摩擦从「蓄能器」里扣
        const work = stats.workExtracted || 0;
        const accumulator = Number.isFinite(stats.accumulator) ? stats.accumulator : 0;
        const peakWork = stats.peakWork || 0;
        // 胜利判据：单个能量单元的可用能超过达标线（300 J）→ 该卡转为胜利色
        const unitExergy = stats.unitExergy || 0;
        const hasWork = work > 1e-6;
        const peakRatio = hasWork ? (peakWork / work) * 100 : 0;
        const reachedVictory = unitExergy > this.victoryThreshold;
        const unitCard = this.unitExergyEl && this.unitExergyEl.closest
            ? this.unitExergyEl.closest('.stat-item') : null;
        if (unitCard && unitCard.classList) {
            unitCard.classList.toggle('is-victory', reachedVictory);
        }

        const entries = [
            [this.totalEnergyEl, `${stats.totalEnergy.toFixed(0)} J`],
            [this.currentExergyEl, `${stats.currentExergy.toFixed(0)} J`],
            [this.unitExergyEl, `${unitExergy.toFixed(0)} J`],
            [this.maxExergyEl, `${stats.maxExergy.toFixed(0)} J`],
            [this.workExtractedEl, `${work.toFixed(0)} J`],
            [this.accumulatorEl, `${accumulator.toFixed(0)} J`],
            [this.peakWorkEl, `${peakWork.toFixed(0)} J`],
            // 累计做功（净）为正之前，该比值无意义：不显示数值
            [this.peakWorkRatioEl, hasWork ? `${peakRatio.toFixed(1)}%` : ''],
            [this.exergyDestroyedEl, `${stats.exergyDestroyed.toFixed(0)} J`],
            [this.entropyGeneratedEl, `${stats.entropyGenerated.toFixed(3)} J/K`],
            [this.systemEntropyEl, `${stats.systemEntropy.toFixed(3)} J/K`],
            [this.travelDistanceEl, `${stats.travelDistance.toFixed(1)} m`],
            [this.mergeCountEl, `${stats.mergeCount}`],
        ];

        const changed = [];
        for (const [el, value] of entries) {
            if (!el || el.textContent === value) continue;
            el.textContent = value;
            changed.push(el);
        }
        if (changed.length === 0) return;

        // 统一做一次重排来重启全部动画，避免每个元素各自触发一次同步布局
        for (const el of changed) {
            el.classList.remove('changed');
            const card = el.closest('.stat-item');
            if (card) card.classList.remove('updated');
        }
        void document.body.offsetHeight;
        for (const el of changed) {
            el.classList.add('changed');
            const card = el.closest('.stat-item');
            if (card) card.classList.add('updated');
        }
    }

    /* ---------------- 提示与结算 ---------------- */

    showMessage(message, type = 'info') {
        const el = document.createElement('div');
        el.className = `message ${type}`;
        el.textContent = message;
        document.body.appendChild(el);

        requestAnimationFrame(() => el.classList.add('show'));
        setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => {
                if (el.parentNode) el.parentNode.removeChild(el);
            }, 320);
        }, 2600);
    }

    showGameOver(stats) {
        if (document.querySelector('.game-over-overlay')) return; // 二次保险：不叠加

        // 「累计做功」只统计释放的功；摩擦计入蓄能器支出
        const work = stats.workExtracted || 0;
        const peakWork = stats.peakWork || 0;
        const accumulator = Number.isFinite(stats.accumulator) ? stats.accumulator : 0;
        const hasWork = work > 1e-6;
        const score = hasWork ? (peakWork / work) * 100 : 0;   // 参考比值：做功峰值 / 累计做功
        // 胜利判据是「单个能量单元的可用能」超过达标线，故把它置顶写在成绩里
        // 做过功之后总内能会下降（那部分内能被取出为功 + 排给环境），不能再说"始终保持"
        const unitExergy = stats.unitExergy || 0;
        const reachedVictory = unitExergy > this.victoryThreshold;
        const note = hasWork
            ? `本局成绩 · 单元可用能 ${unitExergy.toFixed(0)} J（超 ${this.victoryThreshold.toFixed(0)} J 达标）`
              + `｜ 做功峰值 ${peakWork.toFixed(0)} J（峰值/累计做功 ${score.toFixed(1)}%）｜ 累计做功 ${work.toFixed(0)} J`
              + `｜ 蓄能器余 ${accumulator.toFixed(0)} J（摩擦支出 ${(stats.frictionWork || 0).toFixed(0)} J）`
              + `｜ 剩余内能 ${stats.totalEnergy.toFixed(0)} J`
              + `｜ 排给环境 ${(stats.heatRejected || 0).toFixed(0)} J —— 能量守恒，㶲不守恒`
            : `总内能始终保持 ${stats.totalEnergy.toFixed(0)} J —— 能量守恒，㶲不守恒`;

        const overlay = document.createElement('div');
        overlay.className = 'game-over-overlay';
        overlay.innerHTML = `
            <div class="game-over-content">
                <h2>熵增过程结束</h2>
                <p>全部能量球已合并为一，可用能降至最终值</p>
                <div class="game-over-stats">
                    <div class="game-over-stat">
                        <div class="game-over-stat-label">可用能峰值</div>
                        <div class="game-over-stat-value">${stats.maxExergy.toFixed(0)} J</div>
                    </div>
                    <div class="game-over-stat">
                        <div class="game-over-stat-label">剩余可用能</div>
                        <div class="game-over-stat-value">${stats.currentExergy.toFixed(0)} J</div>
                    </div>
                    <div class="game-over-stat">
                        <div class="game-over-stat-label">累计做功</div>
                        <div class="game-over-stat-value">${work.toFixed(0)} J</div>
                    </div>
                    <div class="game-over-stat">
                        <div class="game-over-stat-label">蓄能器余额</div>
                        <div class="game-over-stat-value">${accumulator.toFixed(0)} J</div>
                    </div>
                    <div class="game-over-stat is-score${reachedVictory ? ' is-victory' : ''}">
                        <div class="game-over-stat-label">单元可用能 · 成绩${reachedVictory ? ' · 已达标' : ''}</div>
                        <div class="game-over-stat-value">${unitExergy.toFixed(0)} J</div>
                    </div>
                    <div class="game-over-stat">
                        <div class="game-over-stat-label">做功峰值</div>
                        <div class="game-over-stat-value">${peakWork.toFixed(0)} J</div>
                    </div>
                    <div class="game-over-stat">
                        <div class="game-over-stat-label">做功峰值/累计做功</div>
                        <div class="game-over-stat-value">${hasWork ? score.toFixed(1) + '%' : ''}</div>
                    </div>
                    <div class="game-over-stat">
                        <div class="game-over-stat-label">累计㶲损</div>
                        <div class="game-over-stat-value">${stats.exergyDestroyed.toFixed(0)} J</div>
                    </div>
                    <div class="game-over-stat">
                        <div class="game-over-stat-label">累计熵产</div>
                        <div class="game-over-stat-value">${stats.entropyGenerated.toFixed(3)} J/K</div>
                    </div>
                    <div class="game-over-stat">
                        <div class="game-over-stat-label">移动距离</div>
                        <div class="game-over-stat-value">${stats.travelDistance.toFixed(1)} m</div>
                    </div>
                    <div class="game-over-stat">
                        <div class="game-over-stat-label">合并次数</div>
                        <div class="game-over-stat-value">${stats.mergeCount}</div>
                    </div>
                </div>
                <div class="game-over-note">${note}</div>
                <button class="btn btn-primary" id="btnGameOverRestart">再来一局</button>
            </div>
        `;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('show'));

        const btn = overlay.querySelector('#btnGameOverRestart');
        if (btn) {
            btn.addEventListener('click', () => {
                overlay.remove();
                if (this.onRestart) this.onRestart();
            });
        }
    }
}
