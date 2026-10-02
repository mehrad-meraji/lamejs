

export default class CalcNoiseData {
    global_gain = 0;
    sfb_count1 = 0;
    step: Int32Array = new Int32Array(39);
    noise: Float32Array = new Float32Array(39);
    noise_log: Float32Array = new Float32Array(39);

    reset(): void {
        this.global_gain = 0;
        this.sfb_count1 = 0;
        this.step.fill(0);
        this.noise.fill(0);
        this.noise_log.fill(0);
    }
}
