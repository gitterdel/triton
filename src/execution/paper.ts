import type { Executor } from "./executor.js";
import type { Fill, Order } from "../types.js";
import { simulatedFee } from "../state/portfolio.js";

// Ejecutor simulado: fill instantáneo al precio de la señal, con fee aproximado
// de DEX. Sirve para validar la estrategia antes de conectar TWAK.
export const paperExecutor: Executor = {
  name: "paper",
  async execute(order: Order): Promise<Fill> {
    return {
      order,
      executedAt: new Date().toISOString(),
      fee: simulatedFee(order),
    };
  },
};
