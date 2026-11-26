import { EventEmitter } from "node:events";

/** In-process signals between the keeper and the curator loop. "settled": a vault settle just landed (a shortfall may now be owed). */
export const bus = new EventEmitter();
