import MeanBits from './MeanBits.js';
import Encoder from './Encoder.js';
import L3Side from './L3Side.js';
import type LameGlobalFlags from './LameGlobalFlags.js';
import type Quantize from './Quantize.js';
import type III_psy_ratio from './III_psy_ratio.js';

/** CBR bit allocation and quantization for one frame. */
export default class CBRNewIterationLoop {
    private readonly l3_xmin = new Float32Array(L3Side.SFBMAX);
    private readonly xrpow = new Float32Array(576);
    private readonly targ_bits = new Int32Array(2);

    constructor(private readonly quantize: Quantize) {}

    iteration_loop(gfp: LameGlobalFlags, pe: number[][], ratio: III_psy_ratio[][]): void {
        const gfc = gfp.internal_flags!;
        const { l3_xmin, xrpow, targ_bits, quantize } = this;
        const l3_side = gfc.l3_side;

        const mb = new MeanBits(0);
        quantize.rv.ResvFrameBegin(gfp, mb);
        const mean_bits = mb.bits;

        /* quantize! */
        for (let gr = 0; gr < gfc.mode_gr; gr++) {
            /* calculate needed bits */
            quantize.qupvt.on_pe(gfp, pe, targ_bits, mean_bits, gr, gr);

            for (let ch = 0; ch < gfc.channels_out; ch++) {
                const cod_info = l3_side.tt[gr][ch];
                const masking_lower_db = cod_info.block_type != Encoder.SHORT_TYPE
                    ? gfc.PSY!.mask_adjust /* NORM, START or STOP type */
                    : gfc.PSY!.mask_adjust_short;
                gfc.masking_lower = Math.pow(10.0, masking_lower_db * 0.1);

                /* init_outer_loop sets up cod_info, scalefac and xrpow */
                quantize.init_outer_loop(gfc, cod_info);
                if (quantize.init_xrpow(cod_info, xrpow)) {
                    /*
                     * xr contains energy we will have to encode calculate the
                     * masking abilities find some good quantization in outer_loop
                     */
                    quantize.qupvt.calc_xmin(gfc, ratio[gr][ch], cod_info, l3_xmin);
                    quantize.outer_loop(gfc, cod_info, l3_xmin, xrpow, ch, targ_bits[ch]);
                }
                quantize.iteration_finish_one(gfc, gr, ch);
            }
        }

        quantize.rv.ResvFrameEnd(gfc, mean_bits);
    }
}
