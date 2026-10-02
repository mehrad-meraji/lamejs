import type LameGlobalFlags from './LameGlobalFlags.js';

const FULL_BITRATES = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

/** Index of the nearest entry in the full bitrate table (borrowed from DM abr presets). */
export function nearestBitrateFullIndex(bitrate: number): number {
    for (let b = 0; b < 16; b++) {
        if (Math.max(bitrate, FULL_BITRATES[b + 1]) != bitrate) {
            /* closer to the lower or the upper bound? */
            return (FULL_BITRATES[b + 1] - bitrate) > (bitrate - FULL_BITRATES[b]) ? b : b + 1;
        }
    }
    return 16;
}

/**
 * Switch mappings for ABR mode, one row per entry of FULL_BITRATES. Only the
 * columns that matter for plain-stereo CBR are kept (quant_comp, quant_comp_s and
 * ns-bass are the same in every row; safejoint, nsmsfix and st_s only apply to
 * joint stereo).
 *
 *  st_lrm scale  msk  ath_lwr ath_curve interch sfscale
 */
const ABR_SWITCH_MAP: readonly (readonly number[])[] = [
    [6.60, 0.95, 0, -30.0, 11, 0.0012, 1], /*   8, impossible to use in stereo */
    [6.60, 0.95, 0, -25.0, 11, 0.0010, 1], /*  16 */
    [6.60, 0.95, 0, -20.0, 11, 0.0010, 1], /*  24 */
    [6.60, 0.95, 0, -15.0, 11, 0.0010, 1], /*  32 */
    [6.60, 0.95, 0, -10.0, 11, 0.0009, 1], /*  40 */
    [6.60, 0.95, 0, -10.0, 11, 0.0009, 1], /*  48 */
    [6.60, 0.95, 0, -6.0, 11, 0.0008, 1], /*  56 */
    [6.60, 0.95, 0, -2.0, 11, 0.0008, 1], /*  64 */
    [6.60, 0.95, 0, .0, 8, 0.0007, 1], /*  80 */
    [6.60, 0.95, 0, 1.0, 5.5, 0.0006, 1], /*  96 */
    [6.60, 0.95, 0, 2.0, 4.5, 0.0005, 1], /* 112 */
    [6.40, 0.95, 0, 3.0, 4, 0.0002, 1], /* 128 */
    [6.00, 0.95, -2, 5.0, 3.5, 0, 1], /* 160 */
    [5.60, 0.97, -4, 7.0, 3, 0, 0], /* 192 */
    [5.20, 0.98, -6, 9.0, 2, 0, 0], /* 224 */
    [5.20, 1.00, -8, 10.0, 1, 0, 0], /* 256 */
    [5.20, 1.00, -10, 12.0, 0, 0, 0], /* 320 */
];

/**
 * LAME's CBR setup applies the ABR preset for the bitrate. None of these options
 * are user settable here, so every value comes straight from the table.
 */
export function applyAbrPreset(gfp: LameGlobalFlags, kbps: number): void {
    const [st_lrm, scale, masking_adj, ath_lower, ath_curve, interch, sfscale] =
        ABR_SWITCH_MAP[nearestBitrateFullIndex(kbps)];
    const gfc = gfp.internal_flags!;

    gfp.brate = Math.max(Math.min(kbps, 320), 8);
    if (sfscale > 0)
        gfc.noise_shaping = 2;
    gfc.nsPsy.attackthre = st_lrm;
    /* ABR seems to have big problems with clipping, especially at low bitrates */
    gfp.scale = scale;
    gfp.maskingadjust = masking_adj;
    gfp.maskingadjust_short = masking_adj * (masking_adj > 0 ? .9 : 1.1);
    gfp.ATHlower = -ath_lower / 10.;
    gfp.ATHcurve = ath_curve;
    gfp.interChRatio = interch;
}
