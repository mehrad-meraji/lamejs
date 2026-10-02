
/** MPEG channel modes, as written in the frame header. */
const MPEGMode = {
    STEREO: 0,
    MONO: 3,
} as const;
type MPEGMode = typeof MPEGMode[keyof typeof MPEGMode];
export default MPEGMode;
