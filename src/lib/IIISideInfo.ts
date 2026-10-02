
import GrInfo from './GrInfo.js';

export default class IIISideInfo {
    tt: GrInfo[][] = [[null as unknown as GrInfo, null as unknown as GrInfo], [null as unknown as GrInfo, null as unknown as GrInfo]];
    main_data_begin: number = 0;
    private_bits: number = 0;
    resvDrain_pre: number = 0;
    resvDrain_post: number = 0;
    scfsi: Int32Array[] = [new Int32Array(4), new Int32Array(4)];

    constructor() {
        for (let gr = 0; gr < 2; gr++) {
            for (let ch = 0; ch < 2; ch++) {
                this.tt[gr][ch] = new GrInfo();
            }
        }
    }
}
