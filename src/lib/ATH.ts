
import Encoder from './Encoder.js';

/**
 * ATH related stuff, if something new ATH related has to be added, please plug
 * it here into the ATH.
 */
export default class ATH {
    /**
     * factor for tuning the (sample power) point below which adaptive threshold
     * of hearing adjustment occurs
     */
    aaSensitivityP: number = 0.;
    /**
     * Lowering based on peak volume, 1 = no lowering.
     */
    adjust: number = 0.;
    /**
     * Limit for dynamic ATH adjust.
     */
    adjustLimit: number = 0.;
    /**
     * Determined to lower x dB each second.
     */
    decay: number = 0.;
    /**
     * Lowest ATH value.
     */
    floor: number = 0.;
    /**
     * ATH for sfbs in long blocks.
     */
    l: Float32Array = new Float32Array(Encoder.SBMAX_l);
    /**
     * ATH for sfbs in short blocks.
     */
    s: Float32Array = new Float32Array(Encoder.SBMAX_s);
    /**
     * ATH for partitioned sfb21 in long blocks.
     */
    psfb21: Float32Array = new Float32Array(Encoder.PSFB21);
    /**
     * ATH for partitioned sfb12 in short blocks.
     */
    psfb12: Float32Array = new Float32Array(Encoder.PSFB12);
    /**
     * ATH for long block convolution bands.
     */
    cb_l: Float32Array = new Float32Array(Encoder.CBANDS);
    /**
     * ATH for short block convolution bands.
     */
    cb_s: Float32Array = new Float32Array(Encoder.CBANDS);
    /**
     * Equal loudness weights (based on ATH).
     */
    eql_w: Float32Array = new Float32Array(Encoder.BLKSIZE / 2);
}

