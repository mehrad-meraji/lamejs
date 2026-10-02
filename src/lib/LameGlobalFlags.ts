import MPEGMode from './MPEGMode.js';
import { ShortBlock } from './common.js';
import type LameInternalFlags from './LameInternalFlags.js';

/** The settings LAME derives for one CBR stream (lame_global_flags). */
export default class LameGlobalFlags {
    /* input description */
    in_samplerate = 0;
    out_samplerate = 0;
    /** sample scaling from the ABR preset table */
    scale = 0.;

    mode: MPEGMode = MPEGMode.STEREO;
    /** bitrate in kbps */
    brate = 0;

    /* resampling and filtering */
    lowpassfreq = 0;

    /* psycho acoustics, from the ABR preset table */
    maskingadjust = 0.;
    maskingadjust_short = 0.;
    ATHcurve = 0.;
    ATHlower = 0.;
    short_blocks: ShortBlock = ShortBlock.short_block_allowed;
    interChRatio = 0.;

    /** MPEG version: 1 = MPEG-1, 0 = MPEG-2 or MPEG-2.5 */
    version = 0;
    /** samples per frame: 1152 (MPEG-1) or 576 */
    framesize = 0;
    frameNum = 0;

    internal_flags: LameInternalFlags | null = null;
}
