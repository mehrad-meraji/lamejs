
/** Nested Float32Arrays: `new_float_n([2, 576])` is `Float32Array[2][576]`; the caller names the type. */
export function new_float_n<T = Float32Array[]>(dims: number[]): T {
    const [n, ...rest] = dims;
    return (rest.length == 0 ? new Float32Array(n) : Array.from({ length: n }, () => new_float_n<unknown>(rest))) as T;
}

/** Nested Int32Arrays, like new_float_n. */
export function new_int_n<T = Int32Array[]>(dims: number[]): T {
    const [n, ...rest] = dims;
    return (rest.length == 0 ? new Int32Array(n) : Array.from({ length: n }, () => new_int_n<unknown>(rest))) as T;
}

/** LAME's short block policy. */
export const ShortBlock = {
    /** LAME may use them, even different block types for L/R. */
    short_block_allowed: 0,
    /** LAME may use them, but always same block types in L/R. */
    short_block_coupled: 1,
} as const;
export type ShortBlock = typeof ShortBlock[keyof typeof ShortBlock];
