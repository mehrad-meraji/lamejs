import Encoder from './Encoder.js';

/** Scalefactor band boundaries (long, short and the partitioned sfb21 / sfb12 bands). */
export default class ScaleFac {
    l = new Int32Array(1 + Encoder.SBMAX_l);
    s = new Int32Array(1 + Encoder.SBMAX_s);
    psfb21 = new Int32Array(1 + Encoder.PSFB21);
    psfb12 = new Int32Array(1 + Encoder.PSFB12);

    constructor(l: readonly number[] = [], s: readonly number[] = [], psfb21: readonly number[] = [], psfb12: readonly number[] = []) {
        this.l.set(l.slice(0, this.l.length));
        this.s.set(s.slice(0, this.s.length));
        this.psfb21.set(psfb21.slice(0, this.psfb21.length));
        this.psfb12.set(psfb12.slice(0, this.psfb12.length));
    }
}
