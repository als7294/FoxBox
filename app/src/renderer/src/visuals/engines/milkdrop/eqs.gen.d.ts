type Eq = (a: Record<string, unknown>) => Record<string, unknown>

/** Per preset name: init, frame, pixel ('' = none), shapes [init, frame], waves [init, frame, point ('' = none)]. */
declare const eqs: Record<string, { i: Eq; f: Eq; p: Eq | ''; s: [Eq, Eq][]; w: [Eq, Eq, Eq | ''][] }>
export default eqs
