/**
 * 能量块 —— 质点 + 圆形体积
 *
 * 本体是一个质点（圆心），体积用圆形表达：圆面积正比于质量。
 * 圆心位置不直接存像素，而是存通道中心线上的参数位置 {segIdx, t}，
 * 由 CorridorNetwork 解析出像素圆心并缓存到 x / y。
 *
 * 圆形半径可以膨胀到超过通道宽度，渲染时不裁剪，因此可以压在薄墙上、
 * 跨越相邻通道 —— 但圆心始终被约束在通道中心线上。
 */
class EnergyBlock {
    /**
     * @param {string} id - 唯一标识
     * @param {number} mass - 质量（与圆面积成正比）
     * @param {number} temperature - 温度（摄氏度）
     * @param {number} radiusUnit - 半径系数：radius = radiusUnit * sqrt(mass)
     */
    constructor(id, mass, temperature, radiusUnit = 5.5) {
        this.id = id;
        this.mass = mass;
        this.temperature = temperature;
        this.radiusUnit = radiusUnit;

        /** 圆心在通道中心线上的参数位置 */
        this.pos = { segIdx: -1, t: 0 };
        /** 派生像素圆心缓存 */
        this.x = 0;
        this.y = 0;

        this.radius = radiusUnit * Math.sqrt(mass);
        this.grayValue = 0;
        this.color = 'rgb(128, 128, 128)';

        /** 由 PhysicsEngine 写回，供渲染读取 */
        this.internalEnergy = 0;
        this.entropy = 0;
        this.exergy = 0;

        this.updateColor();
    }

    /** 设置质量并同步半径 */
    setMass(mass) {
        this.mass = mass;
        this.radius = this.radiusUnit * Math.sqrt(mass);
    }

    /** 由参数位置解析并缓存像素圆心 */
    syncPosition(network) {
        const p = network.pointAt(this.pos.segIdx, this.pos.t);
        this.x = p.x;
        this.y = p.y;
        return p;
    }

    /** 命中测试：点是否落在圆内 */
    containsPoint(px, py) {
        return Math.hypot(px - this.x, py - this.y) <= this.radius;
    }

    /** 圆心距 */
    distanceTo(other) {
        return Math.hypot(this.x - other.x, this.y - other.y);
    }

    /** 两圆是否相触（欧氏距离，允许隔着薄墙相触） */
    touches(other) {
        return this.distanceTo(other) <= this.radius + other.radius;
    }

    /**
     * 温度 → 灰度：0°C 纯黑，300°C 纯白
     * @param {number} maxTemperature
     */
    updateColor(maxTemperature = 300) {
        const normalized = this.temperature / maxTemperature;
        const clamped = Math.max(0, Math.min(1, normalized));
        this.grayValue = Math.round(clamped * 255);
        this.color = `rgb(${this.grayValue}, ${this.grayValue}, ${this.grayValue})`;
    }

    /** 温度归一化值 0~1，用于光晕强度等视觉映射 */
    get heatRatio() {
        return Math.max(0, Math.min(1, this.temperature / 300));
    }

    getInfo() {
        return {
            id: this.id,
            center: `(${this.x.toFixed(1)}, ${this.y.toFixed(1)})`,
            segment: this.pos.segIdx,
            t: this.pos.t.toFixed(3),
            radius: this.radius.toFixed(1),
            mass: this.mass.toFixed(2),
            temperature: `${this.temperature.toFixed(1)}°C`,
            entropy: this.entropy.toFixed(3),
            exergy: this.exergy.toFixed(1),
            gray: this.grayValue,
        };
    }
}
