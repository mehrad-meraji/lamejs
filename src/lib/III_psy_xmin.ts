import { new_float_n } from './common.js';
import Encoder from './Encoder.js';

/** Energies or masking thresholds per scalefactor band (long, and short × 3 windows). */
export default class III_psy_xmin {
    l = new Float32Array(Encoder.SBMAX_l);
    s: Float32Array[] = new_float_n([Encoder.SBMAX_s, 3]);

    assign(other: III_psy_xmin): void {
        this.l.set(other.l);
        for (let i = 0; i < Encoder.SBMAX_s; i++)
            this.s[i].set(other.s[i]);
    }
}
