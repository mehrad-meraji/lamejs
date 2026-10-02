
import L3Side from './L3Side.js';

export default class GrInfo {
    xr: Float32Array = new Float32Array(576);
    l3_enc: Int32Array = new Int32Array(576);
    scalefac: Int32Array = new Int32Array(L3Side.SFBMAX);
    xrpow_max: number = 0.;

    part2_3_length: number = 0;
    big_values: number = 0;
    count1: number = 0;
    global_gain: number = 0;
    scalefac_compress: number = 0;
    block_type: number = 0;
    table_select: Int32Array = new Int32Array(3);
    subblock_gain: Int32Array = new Int32Array(3 + 1);
    region0_count: number = 0;
    region1_count: number = 0;
    preflag: number = 0;
    scalefac_scale: number = 0;
    count1table_select: number = 0;

    part2_length: number = 0;
    sfb_lmax: number = 0;
    sfb_smin: number = 0;
    psy_lmax: number = 0;
    sfbmax: number = 0;
    psymax: number = 0;
    sfbdivide: number = 0;
    width: Int32Array = new Int32Array(L3Side.SFBMAX);
    window: Int32Array = new Int32Array(L3Side.SFBMAX);
    count1bits: number = 0;
    /**
     * added for LSF
     */
    sfb_partition_table: number[] | null = null;
    slen: Int32Array = new Int32Array(4);

    max_nonzero_coeff: number = 0;

    /** Copies `other` into this granule in place. */
    assign(other: GrInfo): void {
        this.xr.set(other.xr);
        this.l3_enc.set(other.l3_enc);
        this.scalefac.set(other.scalefac);
        this.xrpow_max = other.xrpow_max;

        this.part2_3_length = other.part2_3_length;
        this.big_values = other.big_values;
        this.count1 = other.count1;
        this.global_gain = other.global_gain;
        this.scalefac_compress = other.scalefac_compress;
        this.block_type = other.block_type;
        this.table_select.set(other.table_select);
        this.subblock_gain.set(other.subblock_gain);
        this.region0_count = other.region0_count;
        this.region1_count = other.region1_count;
        this.preflag = other.preflag;
        this.scalefac_scale = other.scalefac_scale;
        this.count1table_select = other.count1table_select;

        this.part2_length = other.part2_length;
        this.sfb_lmax = other.sfb_lmax;
        this.sfb_smin = other.sfb_smin;
        this.psy_lmax = other.psy_lmax;
        this.sfbmax = other.sfbmax;
        this.psymax = other.psymax;
        this.sfbdivide = other.sfbdivide;
        this.width.set(other.width);
        this.window.set(other.window);
        this.count1bits = other.count1bits;

        /* the partition tables are shared and never written */
        this.sfb_partition_table = other.sfb_partition_table;
        this.slen.set(other.slen);
        this.max_nonzero_coeff = other.max_nonzero_coeff;
    }
}
