import type { Fill, Order } from "../types.js";

export interface Executor {
  name: string;
  execute(order: Order): Promise<Fill>;
}
