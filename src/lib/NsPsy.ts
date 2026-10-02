import { new_float_n } from './common.js';

/**
 * Variables used for --nspsytune
 *
 * @author Ken
 *
 */
export default class NsPsy {
    last_en_subshort: Float32Array[] = new_float_n([4, 9]);
    lastAttacks: Int32Array = new Int32Array(4);
    pefirbuf: Float32Array = new Float32Array(19);

    /**
     * short block tuning
     */
    attackthre = 0.;
}
