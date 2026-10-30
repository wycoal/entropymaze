/**
 * 物理引擎 —— 严格有限体热力学模型
 *
 * 旧版模型 E = Q(1 - T0/T)、Q = m·T 是"热源"近似，用在有限物体上会自相矛盾：
 *   - 摩擦升温后 Q 增大，导致可用能不降反升（与熵增原理相悖）；
 *   - 合并时 E = Q - m·T0 在能量与质量都守恒的前提下恒等，熵增恒为 0。
 *
 * 新版改用有限体（闭口系统）的严格表达式，全部使用开尔文：
 *   内能（相对环境）  U = m·c·(T - T0)
 *   熵（相对环境）    S = m·c·ln(T / T0)
 *   㶲               E = m·c·[(T - T0) - T0·ln(T / T0)]
 *
 * 令 φ(T) = (T - T0) - T0·ln(T/T0)，φ'' = T0/T² > 0 为凸函数，
 * 由 Jensen 不等式：Σmᵢ·φ(Tᵢ) ≥ M·φ(ΣmᵢTᵢ/M)，
 * 因此合并（温差传热）必然使系统㶲严格下降，且
 *   㶲损 = T0 · 熵产（Gouy-Stodola 定理）在数值上恒等，可作自检。
 *
 * 摩擦处理：拖拽做功 W 全部耗散为热并以环境温度 T0 排给环境，
 * 因此图块自身的内能与温度不变（总内能守恒），但
 *   熵产 += W / T0，㶲损 += W。
 * 这样"摩擦不再使可用能上升"，可用能全程单调下降。
 */
class PhysicsEngine {
    constructor(config = {}) {
        this.specificHeat = config.specificHeat !== undefined ? config.specificHeat : 1.0;
        this.gravity = config.gravity !== undefined ? config.gravity : 9.81;
        this.frictionCoeff = config.frictionCoeff !== undefined ? config.frictionCoeff : 0.15;
        this.backgroundTemp = config.backgroundTemp !== undefined ? config.backgroundTemp : 20;
        this.maxTemperature = config.maxTemperature !== undefined ? config.maxTemperature : 300;
        this.minTemperature = config.minTemperature !== undefined
            ? config.minTemperature
            : this.backgroundTemp;
    }

    /* ---------------- 温标 ---------------- */

    toKelvin(celsius) {
        return celsius + 273.15;
    }

    toCelsius(kelvin) {
        return kelvin - 273.15;
    }

    /** 环境（背景）温度，开尔文 */
    get T0() {
        return this.toKelvin(this.backgroundTemp);
    }

    /* ---------------- 状态函数 ---------------- */

    /** 内能 U = m·c·(T - T0)，以环境为基准 */
    internalEnergy(block) {
        return block.mass * this.specificHeat * (this.toKelvin(block.temperature) - this.T0);
    }

    /** 熵 S = m·c·ln(T / T0)，以环境为基准 */
    entropy(block) {
        const T = Math.max(this.toKelvin(block.temperature), 1e-6);
        return block.mass * this.specificHeat * Math.log(T / this.T0);
    }

    /** 㶲 E = m·c·[(T - T0) - T0·ln(T / T0)] */
    exergy(block) {
        const T = Math.max(this.toKelvin(block.temperature), 1e-6);
        const T0 = this.T0;
        return block.mass * this.specificHeat * ((T - T0) - T0 * Math.log(T / T0));
    }

    /* ---------------- 摩擦耗散 ---------------- */

    /**
     * 摩擦功 W = μ·m·g·d
     * @param {EnergyBlock} block
     * @param {number} distanceMeters - 沿通道实际行进的距离（米）
     */
    frictionWork(block, distanceMeters) {
        if (distanceMeters <= 0) return 0;
        return this.frictionCoeff * block.mass * this.gravity * distanceMeters;
    }

    /**
     * 施加一次摩擦耗散：功全部转化为热并排给温度为 T0 的环境。
     * 图块自身状态不变（内能守恒）。
     *
     * 注意：摩擦消耗的机械能来自系统之外（玩家拖动输入的功，而非球的内能），
     * 也不会降低球的可用能。按现行口径它**不计入**累计熵产 / 累计㶲损
     * （这两项只统计合并传热），也**不冲减**累计做功（那只统计能量单元释放的功），
     * 而是从蓄能器里支出：
     *   accumulator = 初始储能 + 累计做功 − 累计摩擦功（为负则无法移动）。
     * 于是㶲平衡简化为："可用能下降 = 累计做功 + 累计㶲损"。
     *
     * @returns {{work:number, entropyGenerated:number, exergyDestroyed:number}}
     */
    applyFriction(block, distanceMeters) {
        const work = this.frictionWork(block, distanceMeters);
        if (work <= 0) {
            return { work: 0, entropyGenerated: 0, exergyDestroyed: 0 };
        }
        // 环境在 T0 下吸热 W：熵产 = W / T0；这部分热量㶲为 0，故输入功的㶲全部销毁
        const entropyGenerated = work / this.T0;
        return {
            work,
            entropyGenerated,
            exergyDestroyed: work, // === T0 * entropyGenerated
        };
    }

    /* ---------------- 合并传热 ---------------- */

    /**
     * 两块合并：能量守恒求平衡温度，再算传热熵产与㶲损
     * @returns {{finalTemperature:number, newMass:number, entropyGenerated:number, exergyDestroyed:number}}
     */
    merge(b1, b2) {
        const c = this.specificHeat;
        const T1 = Math.max(this.toKelvin(b1.temperature), 1e-6);
        const T2 = Math.max(this.toKelvin(b2.temperature), 1e-6);
        const m1 = b1.mass;
        const m2 = b2.mass;
        const totalMass = m1 + m2;

        // U 守恒 ⇒ 平衡温度（摄氏与开尔文下同一式子）
        const Tf = (m1 * T1 + m2 * T2) / totalMass;

        // ΔS = Σ mᵢ·c·ln(Tf / Tᵢ) ≥ 0（由 ln 的凹性保证）
        const entropyGenerated = Math.max(
            0,
            m1 * c * Math.log(Tf / T1) + m2 * c * Math.log(Tf / T2)
        );

        return {
            finalTemperature: this.toCelsius(Tf),
            newMass: totalMass,
            entropyGenerated,
            exergyDestroyed: this.T0 * entropyGenerated,
        };
    }

    /* ---------------- 温度分配 ---------------- */

    /**
     * 在给定质量分布下分配温度，使系统总内能严格等于 totalEnergy。
     *
     * 做法：先按随机权重把总内能分给各块 → Tᵢ = T0 + Uᵢ/(mᵢ·c)；
     * 若某些块越界（高于上限或低于环境温度），钳制后把多出/缺少的内能
     * 按质量比例在未饱和的块之间再分配，迭代至收敛。
     *
     * @param {number[]} masses
     * @param {number} totalEnergy
     * @param {Function} rng
     * @returns {number[]} 摄氏温度数组
     */
    allocateTemperatures(masses, totalEnergy, rng) {
        const n = masses.length;
        if (n === 0) return [];

        const weights = masses.map(() => 0.35 + rng() * 0.9);
        const weightSum = weights.reduce((a, b) => a + b, 0);
        const temps = masses.map(
            (m, i) => this.backgroundTemp + (totalEnergy * weights[i]) / weightSum / (m * this.specificHeat)
        );

        const upper = this.maxTemperature;
        const lower = this.minTemperature;
        const capacity = masses.reduce((s, m) => s + m * this.specificHeat * (upper - lower), 0);

        // 容量不足时按整体上界收缩，保证迭代收敛
        if (totalEnergy > capacity && capacity > 0) {
            const scale = capacity / totalEnergy;
            for (let i = 0; i < n; i++) {
                temps[i] = this.backgroundTemp + (temps[i] - this.backgroundTemp) * scale;
            }
        }

        for (let iter = 0; iter < 12; iter++) {
            let excess = 0; // 需要重新分配的内能（J）
            const free = [];
            for (let i = 0; i < n; i++) {
                if (temps[i] > upper) {
                    excess += (temps[i] - upper) * masses[i] * this.specificHeat;
                    temps[i] = upper;
                } else if (temps[i] < lower) {
                    excess -= (lower - temps[i]) * masses[i] * this.specificHeat;
                    temps[i] = lower;
                } else {
                    free.push(i);
                }
            }
            if (Math.abs(excess) < 1e-6 || free.length === 0) break;
            const freeMass = free.reduce((s, i) => s + masses[i], 0);
            if (freeMass <= 0) break;
            const deltaT = excess / (freeMass * this.specificHeat);
            for (const i of free) temps[i] += deltaT;
        }

        return temps;
    }

    /* ---------------- 系统总量 ---------------- */

    /**
     * 汇总系统状态，并把每块的 U / S / E 写回 block（供渲染读取"显示可用能"）
     * @param {EnergyBlock[]} blocks
     */
    summarize(blocks) {
        let energy = 0;
        let entropy = 0;
        let exergy = 0;
        for (const b of blocks) {
            b.internalEnergy = this.internalEnergy(b);
            b.entropy = this.entropy(b);
            b.exergy = this.exergy(b);
            energy += b.internalEnergy;
            entropy += b.entropy;
            exergy += b.exergy;
        }
        return { energy, entropy, exergy };
    }

    /* ---------------- 参数 ---------------- */

    updateParams(params = {}) {
        if (params.frictionCoeff !== undefined) this.frictionCoeff = params.frictionCoeff;
        if (params.backgroundTemp !== undefined) {
            this.backgroundTemp = params.backgroundTemp;
            this.minTemperature = Math.max(this.minTemperature, this.backgroundTemp);
        }
        if (params.specificHeat !== undefined) this.specificHeat = params.specificHeat;
    }

    /**
     * 自检：验证"㶲损 = T0 × 熵产"（Gouy-Stodola）。
     * 返回相对偏差，正常应远小于 1e-9。
     */
    static gouyStodolaError(exergyDestroyed, entropyGenerated, T0) {
        const expected = T0 * entropyGenerated;
        if (Math.abs(expected) < 1e-12) return 0;
        return Math.abs(exergyDestroyed - expected) / Math.abs(expected);
    }
}
